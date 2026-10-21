//! PostgreSQL library registration, public principals, replay protection, and quota.

use std::time::Duration;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::Serialize;
use sqlx::{postgres::PgPoolOptions, PgPool, Row};

mod blobs;
mod chain;

use crate::{
    chain::{genesis as genesis_hash, parse_genesis},
    crypto, Error, StorageLimits, SKEW_SECS,
};

// A busy pool is retryable. Other database errors retain their cause for logs;
// handlers choose the HTTP response without exposing database details.
impl From<sqlx::Error> for Error {
    fn from(error: sqlx::Error) -> Self {
        match error {
            sqlx::Error::PoolTimedOut => Self::Unavailable,
            other => Self::Db(other),
        }
    }
}

/// Default lifetime for one-time registration invitations.
pub const DEFAULT_REGISTRATION_TTL_SECS: u64 = 86400;

/// Clones share the same connection pool. Closing it stops every clone.
#[derive(Clone)]
pub(crate) struct Database {
    pool: PgPool,
}

#[derive(Debug, Serialize)]
pub(crate) struct Quota {
    pub max_content_bytes: i64,
    pub max_files: i64,
    pub used_content_bytes: i64,
    pub file_count: i64,
}

impl Database {
    /// Request-policy tests use a closed pool so accidental SQL fails immediately.
    #[cfg(test)]
    pub(crate) async fn closed_for_test() -> Self {
        let pool = PgPoolOptions::new()
            .connect_lazy("postgresql://localhost/i2nclip_unused")
            .unwrap();
        pool.close().await;
        Self { pool }
    }

    /// Open the bounded pool. Startup errors must not include the credential URL.
    pub(crate) async fn connect(url: &str) -> Result<Self, Error> {
        let pool = PgPoolOptions::new()
            .max_connections(8)
            .min_connections(1)
            .acquire_timeout(Duration::from_secs(5))
            .connect(url)
            .await
            .map_err(|_| {
                Error::Config(
                    "unable to connect to PostgreSQL; check I2N_DATABASE_URL and database availability"
                        .into(),
                )
            })?;
        Ok(Self { pool })
    }

    /// Apply pending embedded migrations before serving requests.
    pub(crate) async fn initialize(&self) -> Result<(), Error> {
        sqlx::migrate!("./sql").run(&self.pool).await?;
        Ok(())
    }

    /// Wait for checked-out connections and close the shared pool.
    pub(crate) async fn close(&self) {
        self.pool.close().await;
    }

    /// Check whether this public key has been registered.
    pub(crate) async fn allowed(&self, public: &[u8; 32]) -> Result<bool, Error> {
        let allowed = sqlx::query_scalar(
            r#"
            SELECT EXISTS(
                SELECT 1 FROM libraries WHERE signing_public_key = $1
            )
            "#,
        )
        .bind(public.as_slice())
        .fetch_one(&self.pool)
        .await?;
        Ok(allowed)
    }

    /// Reserve a nonce once; an existing nonce rejects a replay.
    pub(crate) async fn remember_nonce(&self, nonce: &str, ts: u64) -> Result<(), Error> {
        let expires = i64::try_from(ts.saturating_add(SKEW_SECS)).unwrap_or(i64::MAX);
        let result = sqlx::query(
            r#"
            INSERT INTO nonces (nonce, expires)
            VALUES ($1, $2)
            ON CONFLICT (nonce) DO NOTHING
            "#,
        )
        .bind(nonce)
        .bind(expires)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 0 {
            return Err(Error::Unauthorized);
        }
        Ok(())
    }

    /// Store only the invitation hash and return the secret code to the admin.
    pub(crate) async fn issue_code(
        &self,
        ttl: u64,
        limits: StorageLimits,
    ) -> Result<String, Error> {
        limits.validate()?;
        let mut secret = [0; 16];
        getrandom::getrandom(&mut secret).map_err(|e| std::io::Error::other(e.to_string()))?;
        let code = URL_SAFE_NO_PAD.encode(secret);
        let hash = crypto::body_hash_bytes(code.trim().as_bytes());
        let expires = i64::try_from(crypto::now_secs().saturating_add(ttl)).unwrap_or(i64::MAX);
        sqlx::query(
            r#"
            INSERT INTO registration_codes (code_hash, expires_at, max_content_bytes, max_files)
            VALUES ($1, $2, $3, $4)
            "#,
        )
        .bind(hash.as_slice())
        .bind(expires)
        .bind(limits.max_content_bytes)
        .bind(limits.max_files)
        .execute(&self.pool)
        .await?;
        Ok(code)
    }

    /// Register genesis, invitation and nonce in one transaction; invalid requests leave no nonce.
    pub(crate) async fn consume_code(
        &self,
        code: &str,
        public: &[u8; 32],
        genesis: &[u8],
        nonce: &str,
        ts: u64,
    ) -> Result<(), Error> {
        let authority = parse_genesis(genesis)?;
        if &authority != public {
            return Err(Error::RegistrationFailed);
        }
        let library = genesis_hash(public)?;
        let mut tx = self.pool.begin().await?;
        let inserted =
            sqlx::query("INSERT INTO nonces(nonce,expires) VALUES($1,$2) ON CONFLICT DO NOTHING")
                .bind(nonce)
                .bind(i64::try_from(ts.saturating_add(SKEW_SECS)).unwrap_or(i64::MAX))
                .execute(&mut *tx)
                .await?;
        if inserted.rows_affected() != 1 {
            return Err(Error::Unauthorized);
        }
        crate::auth::check_timestamp(ts, crypto::now_secs())?;
        // Concurrent retries of one authority must not spend another invitation.
        sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended(encode($1::bytea,'hex'),0))")
            .bind(public.as_slice())
            .execute(&mut *tx)
            .await?;
        let existing: Option<Vec<u8>> =
            sqlx::query_scalar("SELECT genesis FROM libraries WHERE signing_public_key=$1")
                .bind(public.as_slice())
                .fetch_optional(&mut *tx)
                .await?;
        if let Some(existing) = existing {
            if existing != genesis {
                return Err(Error::RegistrationFailed);
            }
        } else {
            let hash = crypto::body_hash_bytes(code.trim().as_bytes());
            let limits = sqlx::query("DELETE FROM registration_codes WHERE code_hash=$1 AND expires_at>$2 RETURNING max_content_bytes,max_files")
                .bind(hash.as_slice()).bind(crypto::now_secs() as i64).fetch_optional(&mut *tx).await?.ok_or(Error::RegistrationFailed)?;
            sqlx::query("INSERT INTO libraries(id,genesis,signing_public_key,head_hash,max_blob_bytes,max_files) VALUES($1,$2,$3,$1,$4,$5)")
                .bind(library.as_slice()).bind(genesis).bind(public.as_slice()).bind(limits.try_get::<i64,_>("max_content_bytes")?).bind(limits.try_get::<i64,_>("max_files")?).execute(&mut *tx).await?;
        }
        crate::auth::check_timestamp(ts, crypto::now_secs())?;
        tx.commit().await?;
        Ok(())
    }

    /// Operator quota changes resolve even historical keys without granting API access.
    pub(crate) async fn set_limits(
        &self,
        public: &[u8; 32],
        limits: StorageLimits,
    ) -> Result<(), Error> {
        limits.validate()?;
        let result = sqlx::query(
            "UPDATE libraries SET max_blob_bytes=$2,max_files=$3 WHERE signing_public_key=$1",
        )
        .bind(public.as_slice())
        .bind(limits.max_content_bytes)
        .bind(limits.max_files)
        .execute(&self.pool)
        .await
        .map_err(|error| match &error {
            sqlx::Error::Database(cause) if cause.code().as_deref() == Some("23514") => {
                Error::BadRequest("Storage limits cannot be lower than current usage.".into())
            }
            _ => error.into(),
        })?;
        if result.rows_affected() == 0 {
            return Err(Error::NotFound);
        }
        Ok(())
    }

    pub(crate) async fn quota(&self, signer: [u8; 32]) -> Result<Quota, Error> {
        let row=sqlx::query("SELECT l.max_blob_bytes,l.max_files,l.used_blob_bytes,l.retained_files FROM libraries l WHERE l.signing_public_key=$1")
            .bind(signer.as_slice()).fetch_optional(&self.pool).await?.ok_or(Error::Unauthorized)?;
        Ok(Quota {
            max_content_bytes: row.try_get("max_blob_bytes")?,
            max_files: row.try_get("max_files")?,
            used_content_bytes: row.try_get("used_blob_bytes")?,
            file_count: row.try_get("retained_files")?,
        })
    }
}

#[cfg(all(test, feature = "postgres-tests"))]
mod tests;
