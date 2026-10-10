//! PostgreSQL storage for encrypted content, metadata, and search tokens.
//!
//! SQLx runs queries on a shared async pool. Uploads, metadata changes, and
//! invitation consumption commit their related writes in one transaction.
//! Media queries include the owner public key from the verified signature.
//! Downloads return owned bytes so sending a response holds no connection.

use std::time::Duration;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;
use sqlx::Postgres;
use sqlx::Row;
use sqlx::Transaction;

use crate::crypto;
use crate::frame;
use crate::Error;
use crate::MAX_CONTENT;
use crate::MAX_META;
use crate::PAGE;

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

    /// Apply the idempotent initial schema atomically before serving requests.
    pub(crate) async fn initialize(&self) -> Result<(), Error> {
        let mut tx = self.pool.begin().await?;
        sqlx::raw_sql(include_str!("../sql/001_init.sql"))
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
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
                SELECT 1 FROM registered_keys WHERE public_key = $1
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

    /// Store only the invitation hash and return the secret code to the admin.
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

    /// Consume a valid invitation and register the key in one transaction.
    pub(crate) async fn consume_code(&self, code: &str, public: &[u8; 32]) -> Result<(), Error> {
        let hash = crypto::body_hash_bytes(code.trim().as_bytes());
        let mut tx = self.pool.begin().await?;
        let result = sqlx::query(
            r#"
            DELETE FROM registration_codes
            WHERE code_hash = $1 AND expires_at > $2
            "#,
        )
        .bind(hash.as_slice())
        .bind(crypto::now_secs() as i64)
        .execute(&mut *tx)
        .await?;
        if result.rows_affected() == 0 {
            return Err(Error::RegistrationFailed);
        }
        // The deletion stays uncommitted until registration succeeds. Concurrent
        // consumers wait on the same code row, so only one can spend it.
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

    /// Commit sealed content, metadata, and tags together. An existing hash conflicts.
    pub(crate) async fn add(&self, owner: [u8; 32], body: &[u8]) -> Result<Item, Error> {
        let parts = frame::decode_post(body)?;
        crypto::check_blob(parts.meta, MAX_META)?;
        crypto::check_blob(parts.content, MAX_CONTENT)?;
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

    /// Return one owner-filtered page and its tags without fetching content bytes.
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

    /// Fetch authorized content into owned bytes and release the connection.
    pub(crate) async fn content(&self, owner: [u8; 32], id: &str) -> Result<Vec<u8>, Error> {
        let id = frame::parse_id(id)?;
        sqlx::query_scalar(
            r#"
            SELECT content FROM files
            WHERE owner = $1 AND id = $2
            "#,
        )
        .bind(owner.as_slice())
        .bind(id)
        .fetch_optional(&self.pool)
        .await?
        .ok_or(Error::NotFound)
    }

    /// Update the authorized row and replace its tags in the same transaction.
    pub(crate) async fn update_meta(
        &self,
        owner: [u8; 32],
        id: &str,
        body: &[u8],
    ) -> Result<Item, Error> {
        let id = frame::parse_id(id)?;
        let parts = frame::decode_meta(body)?;
        crypto::check_blob(parts.meta, MAX_META)?;
        let mut tx = self.pool.begin().await?;
        // UPDATE locks the authorized row until the tag replacement commits.
        // Concurrent metadata changes cannot mix one update's metadata with another's tags.
        let (bytes, created_at) = sqlx::query_as::<_, (i64, i64)>(
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
            bytes,
            created_at,
            tokens: parts.tokens,
        })
    }

    /// Delete the authorized file; the foreign key cascades deletion to its tags.
    pub(crate) async fn remove(&self, owner: [u8; 32], id: &str) -> Result<(), Error> {
        let id = frame::parse_id(id)?;
        let result = sqlx::query(
            r#"
            DELETE FROM files
            WHERE id = $1 AND owner = $2
            "#,
        )
        .bind(id)
        .bind(owner.as_slice())
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 0 {
            return Err(Error::NotFound);
        }
        Ok(())
    }

    /// Delete expired nonces and invitations together, returning their counts.
    pub(crate) async fn maintain(&self, now: i64) -> Result<(u64, u64), Error> {
        let mut tx = self.pool.begin().await?;
        // Requests exactly on the nonce boundary remain valid; invitations
        // expire at their boundary. Keep these comparisons distinct.
        let nonces = sqlx::query(
            r#"
            DELETE FROM nonces
            WHERE expires < $1
            "#,
        )
        .bind(now)
        .execute(&mut *tx)
        .await?
        .rows_affected();
        let codes = sqlx::query(
            r#"
            DELETE FROM registration_codes
            WHERE expires_at <= $1
            "#,
        )
        .bind(now)
        .execute(&mut *tx)
        .await?
        .rows_affected();
        tx.commit().await?;
        Ok((nonces, codes))
    }
}

// The caller owns the transaction so a failed tag write rolls back its file change.
async fn replace_tokens(
    tx: &mut Transaction<'_, Postgres>,
    id: &str,
    tokens: &[String],
) -> Result<(), Error> {
    sqlx::query(
        r#"
        DELETE FROM tags
        WHERE file_id = $1
        "#,
    )
    .bind(id)
    .execute(&mut **tx)
    .await?;
    for token in tokens {
        sqlx::query(
            r#"
            INSERT INTO tags (file_id, token)
            VALUES ($1, $2)
            "#,
        )
        .bind(id)
        .bind(token)
        .execute(&mut **tx)
        .await?;
    }
    Ok(())
}

#[cfg(all(test, feature = "postgres-tests"))]
mod tests {
    use super::*;

    async fn fixture() -> (Database, PgPool, String) {
        let base = std::env::var("I2N_TEST_DATABASE_URL")
            .expect("set I2N_TEST_DATABASE_URL; real PostgreSQL is required");
        let admin = PgPool::connect(&base)
            .await
            .expect("test PostgreSQL unavailable");
        let name = format!(
            "i2nclip_db_{}_{}",
            std::process::id(),
            URL_SAFE_NO_PAD.encode(crypto::body_hash_bytes(
                crate::reference_crypto::fresh_nonce().as_bytes()
            ))
        )
        .to_lowercase()
        .replace('-', "_");
        sqlx::query(&format!("CREATE DATABASE {name}"))
            .execute(&admin)
            .await
            .unwrap();
        let mut url = url::Url::parse(&base).unwrap();
        url.set_path(&name);
        let db = Database::connect(url.as_str()).await.unwrap();
        db.initialize().await.unwrap();
        (db, admin, name)
    }

    async fn dispose(db: Database, admin: PgPool, name: String) {
        db.close().await;
        sqlx::query(&format!("DROP DATABASE {name} WITH (FORCE)"))
            .execute(&admin)
            .await
            .unwrap();
        admin.close().await;
    }

    #[tokio::test]
    async fn maintenance_boundaries_rollback_and_recovery() {
        let (db, admin, name) = fixture().await;
        sqlx::raw_sql(
            r#"
            INSERT INTO nonces (nonce, expires)
            VALUES ('past', 99), ('boundary', 100), ('future', 101);

            INSERT INTO registration_codes (code_hash, expires_at)
            VALUES
                (decode(repeat('01', 32), 'hex'), 99),
                (decode(repeat('02', 32), 'hex'), 100),
                (decode(repeat('03', 32), 'hex'), 101);

            CREATE FUNCTION fail_cleanup() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN
                RAISE EXCEPTION 'test failure';
            END;
            $$;

            CREATE TRIGGER fail_cleanup
                BEFORE DELETE ON registration_codes
                FOR EACH ROW EXECUTE FUNCTION fail_cleanup();
            "#,
        )
        .execute(&db.pool)
        .await
        .unwrap();
        assert!(db.maintain(100).await.is_err());
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT count(*) FROM nonces")
                .fetch_one(&db.pool)
                .await
                .unwrap(),
            3
        );
        sqlx::query("DROP TRIGGER fail_cleanup ON registration_codes")
            .execute(&db.pool)
            .await
            .unwrap();
        assert_eq!(db.maintain(100).await.unwrap(), (1, 2));
        assert_eq!(db.maintain(100).await.unwrap(), (0, 0));
        assert_eq!(db.maintain(101).await.unwrap(), (1, 1));
        dispose(db, admin, name).await;
    }

    #[tokio::test]
    async fn pool_timeout_is_retryable_and_download_does_not_hold_connection() {
        let (db, admin, name) = fixture().await;
        let mut connections = Vec::new();
        for _ in 0..8 {
            connections.push(db.pool.acquire().await.unwrap());
        }
        let error = db.allowed(&[1; 32]).await.unwrap_err();
        assert!(matches!(error, Error::Unavailable));
        let response = crate::routes::fail(error);
        assert_eq!(
            response.status(),
            axum::http::StatusCode::SERVICE_UNAVAILABLE
        );
        assert_eq!(response.headers()[axum::http::header::RETRY_AFTER], "1");
        connections.clear();
        let mut content = vec![1; 100_000];
        content[0] = 1;
        let body = crate::reference_crypto::encode_post(&[1; 29], &content, "");
        let item = db.add([1; 32], &body).await.unwrap();
        let downloaded = db.content([1; 32], &item.id).await.unwrap();
        for _ in 0..8 {
            connections.push(db.pool.acquire().await.unwrap());
        }
        assert_eq!(downloaded, content);
        drop(connections);
        dispose(db, admin, name).await;
    }

    #[tokio::test]
    async fn pool_reconnects_after_backend_termination() {
        let (db, admin, name) = fixture().await;
        sqlx::query(
            r#"
            SELECT pg_terminate_backend(pid)
            FROM pg_stat_activity
            WHERE datname = $1 AND pid <> pg_backend_pid()
            "#,
        )
        .bind(&name)
        .execute(&admin)
        .await
        .unwrap();
        let mut recovered = false;
        for _ in 0..3 {
            if db.allowed(&[1; 32]).await.is_ok() {
                recovered = true;
                break;
            }
        }
        assert!(recovered);
        dispose(db, admin, name).await;
    }
}
