//! Async PostgreSQL persistence. Transactions own all related writes.

use std::time::Duration;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use sqlx::postgres::PgPoolOptions;
use sqlx::{PgPool, Postgres, Row, Transaction};

use crate::{crypto, frame, store, Error, MAX_CONTENT, MAX_META, PAGE};

// HTTP policy stays outside persistence; classify pool exhaustion here.
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

#[derive(Clone)]
pub(crate) struct Database {
    pool: PgPool,
}

/// Encrypted metadata and searchable tokens, without the stored content.
#[derive(Debug)]
pub(crate) struct Item {
    pub id: String,
    pub meta: Vec<u8>,
    pub bytes: i64,
    pub created_at: i64,
    pub tokens: Vec<String>,
}

impl Database {
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

    pub(crate) async fn initialize(&self) -> Result<(), Error> {
        let mut tx = self.pool.begin().await?;
        sqlx::raw_sql(include_str!("../sql/001_init.sql"))
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(())
    }

    pub(crate) async fn close(&self) {
        self.pool.close().await;
    }

    pub(crate) async fn allowed(&self, public: &[u8; 32]) -> Result<bool, Error> {
        let allowed = sqlx::query_scalar(
            r#"
            SELECT EXISTS(
                SELECT 1 FROM registered_keys WHERE public_key = $1
            )
            "#,
        )
        .bind(public.as_slice())
        .fetch_one(&self.pool)
        .await?;
        Ok(allowed)
    }

    pub(crate) async fn remember_nonce(&self, nonce: &str, ts: u64) -> Result<(), Error> {
        let expires = i64::try_from(ts.saturating_add(crate::SKEW_SECS)).unwrap_or(i64::MAX);
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

    pub(crate) async fn issue_code(&self, ttl: u64) -> Result<String, Error> {
        let mut secret = [0; 16];
        getrandom::getrandom(&mut secret).map_err(|e| std::io::Error::other(e.to_string()))?;
        let code = URL_SAFE_NO_PAD.encode(secret);
        let hash = crypto::body_hash_bytes(code.trim().as_bytes());
        let expires = i64::try_from(crypto::now_secs().saturating_add(ttl)).unwrap_or(i64::MAX);
        sqlx::query(
            r#"
            INSERT INTO registration_codes (code_hash, expires_at)
            VALUES ($1, $2)
            "#,
        )
        .bind(hash.as_slice())
        .bind(expires)
        .execute(&self.pool)
        .await?;
        Ok(code)
    }

    pub(crate) async fn consume_code(&self, code: &str, public: &[u8; 32]) -> Result<(), Error> {
        let mut tx = self.pool.begin().await?;
        let result = sqlx::query(
            r#"
            DELETE FROM registration_codes
            WHERE code_hash = $1 AND expires_at > $2
            "#,
        )
        .bind(crypto::body_hash_bytes(code.trim().as_bytes()).to_vec())
        .bind(crypto::now_secs() as i64)
        .execute(&mut *tx)
        .await?;
        if result.rows_affected() == 0 {
            return Err(Error::RegistrationFailed);
        }
        sqlx::query(
            r#"
            INSERT INTO registered_keys (public_key)
            VALUES ($1)
            ON CONFLICT (public_key) DO NOTHING
            "#,
        )
        .bind(public.as_slice())
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(())
    }

    pub(crate) async fn add(&self, owner: [u8; 32], body: &[u8]) -> Result<Item, Error> {
        let parts = frame::decode_post(body)?;
        store::check_blob(parts.meta, MAX_META)?;
        store::check_blob(parts.content, MAX_CONTENT)?;
        let id = crypto::body_hash_async(parts.content).await;
        let created_at = crypto::now_secs() as i64;
        let mut tx = self.pool.begin().await?;
        let result = sqlx::query(
            r#"
            INSERT INTO files (id, owner, meta, content, created_at)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (id) DO NOTHING
            "#,
        )
        .bind(&id)
        .bind(owner.as_slice())
        .bind(parts.meta)
        .bind(parts.content)
        .bind(created_at)
        .execute(&mut *tx)
        .await?;
        if result.rows_affected() == 0 {
            return Err(Error::Conflict);
        }
        replace_tokens(&mut tx, &id, &parts.tokens).await?;
        tx.commit().await?;
        Ok(Item {
            id,
            meta: parts.meta.to_vec(),
            bytes: parts.content.len() as i64,
            created_at,
            tokens: parts.tokens,
        })
    }

    pub(crate) async fn list(
        &self,
        owner: [u8; 32],
        tokens: &[String],
        after: Option<(i64, String)>,
    ) -> Result<(Vec<Item>, Option<String>), Error> {
        let (created_at, id) = match after {
            Some((created_at, id)) => (Some(created_at), Some(id)),
            None => (None, None),
        };
        // Tags are an AND search; equal timestamps break ties by id ascending.
        let rows = sqlx::query(
            r#"
            SELECT id, meta, octet_length(content)::bigint AS bytes, created_at,
                   ARRAY(
                       SELECT token FROM tags
                       WHERE file_id = files.id
                       ORDER BY token
                   ) AS tokens
            FROM files
            WHERE owner = $1
              AND (
                  SELECT count(DISTINCT token) FROM tags
                  WHERE file_id = files.id AND token = ANY($2)
              ) = cardinality($2)
              AND (
                  $3::bigint IS NULL
                  OR created_at < $3
                  OR (created_at = $3 AND id > $4)
              )
            ORDER BY created_at DESC, id ASC
            LIMIT $5
            "#,
        )
        .bind(owner.as_slice())
        .bind(tokens)
        .bind(created_at)
        .bind(id)
        .bind((PAGE + 1) as i64)
        .fetch_all(&self.pool)
        .await?;
        let mut items = rows
            .into_iter()
            .map(|row| {
                Ok(Item {
                    id: row.try_get("id")?,
                    meta: row.try_get("meta")?,
                    bytes: row.try_get("bytes")?,
                    created_at: row.try_get("created_at")?,
                    tokens: row.try_get("tokens")?,
                })
            })
            .collect::<Result<Vec<_>, sqlx::Error>>()?;
        let more = items.len() > PAGE;
        items.truncate(PAGE);
        let next = more.then(|| {
            let last = items.last().expect("a full page has a last row");
            format!("{}.{}", last.created_at, last.id)
        });
        Ok((items, next))
    }

    pub(crate) async fn content(&self, owner: [u8; 32], id: &str) -> Result<Vec<u8>, Error> {
        let id = store::parse_id(id)?;
        sqlx::query_scalar("SELECT content FROM files WHERE owner = $1 AND id = $2")
            .bind(owner.as_slice())
            .bind(id)
            .fetch_optional(&self.pool)
            .await?
            .ok_or(Error::NotFound)
    }

    pub(crate) async fn update_meta(
        &self,
        owner: [u8; 32],
        id: &str,
        body: &[u8],
    ) -> Result<Item, Error> {
        let id = store::parse_id(id)?;
        let parts = frame::decode_meta(body)?;
        store::check_blob(parts.meta, MAX_META)?;
        let mut tx = self.pool.begin().await?;
        let row = sqlx::query(
            r#"
            UPDATE files SET meta = $1
            WHERE id = $2 AND owner = $3
            RETURNING octet_length(content)::bigint AS bytes, created_at
            "#,
        )
        .bind(parts.meta)
        .bind(&id)
        .bind(owner.as_slice())
        .fetch_optional(&mut *tx)
        .await?
        .ok_or(Error::NotFound)?;
        replace_tokens(&mut tx, &id, &parts.tokens).await?;
        tx.commit().await?;
        Ok(Item {
            id,
            meta: parts.meta.to_vec(),
            bytes: row.try_get("bytes")?,
            created_at: row.try_get("created_at")?,
            tokens: parts.tokens,
        })
    }

    pub(crate) async fn remove(&self, owner: [u8; 32], id: &str) -> Result<(), Error> {
        let id = store::parse_id(id)?;
        let result = sqlx::query("DELETE FROM files WHERE id = $1 AND owner = $2")
            .bind(id)
            .bind(owner.as_slice())
            .execute(&self.pool)
            .await?;
        if result.rows_affected() == 0 {
            return Err(Error::NotFound);
        }
        Ok(())
    }

    pub(crate) async fn maintain(&self, now: i64) -> Result<(u64, u64), Error> {
        let mut tx = self.pool.begin().await?;
        let nonces = sqlx::query("DELETE FROM nonces WHERE expires < $1")
            .bind(now)
            .execute(&mut *tx)
            .await?
            .rows_affected();
        let codes = sqlx::query("DELETE FROM registration_codes WHERE expires_at <= $1")
            .bind(now)
            .execute(&mut *tx)
            .await?
            .rows_affected();
        tx.commit().await?;
        Ok((nonces, codes))
    }
}

async fn replace_tokens(
    tx: &mut Transaction<'_, Postgres>,
    id: &str,
    tokens: &[String],
) -> Result<(), Error> {
    sqlx::query("DELETE FROM tags WHERE file_id = $1")
        .bind(id)
        .execute(&mut **tx)
        .await?;
    for token in tokens {
        sqlx::query("INSERT INTO tags (file_id, token) VALUES ($1, $2)")
            .bind(id)
            .bind(token)
            .execute(&mut **tx)
            .await?;
    }
    Ok(())
}

#[cfg(all(test, feature = "postgres-tests"))]
#[path = "db_tests.rs"]
mod tests;
