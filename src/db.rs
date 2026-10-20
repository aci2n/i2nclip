//! PostgreSQL storage for encrypted content, metadata, and search tokens.
//!
//! SQLx runs queries on a shared async pool. Uploads, metadata changes, and
//! invitation consumption commit their related writes in one transaction.
//! Media queries include the owner public key from the verified signature.
//! Downloads return owned bytes so sending a response holds no connection.
//! Workflows use PostgreSQL's default READ COMMITTED isolation. Metadata writers
//! lock the file before reading/replacing its tags; listing uses one snapshot.

use std::time::Duration;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::Serialize;
use sqlx::{postgres::PgPoolOptions, PgPool, Postgres, Row, Transaction};

use crate::{
    crypto, frame, Error, StorageLimits, CHUNK_PLAINTEXT_BYTES, MAX_DESCRIPTOR, MAX_META, PAGE,
    SKEW_SECS,
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

/// Encrypted metadata and content summary, without the stored content.
#[derive(Debug, sqlx::FromRow)]
pub(crate) struct Item {
    pub id: String,
    pub meta: Vec<u8>,
    pub descriptor: Vec<u8>,
    pub expected_chunk_count: i64,
    pub bytes: i64,
    pub created_at: i64,
}

#[derive(Debug, Serialize)]
pub(crate) struct Quota {
    pub max_content_bytes: i64,
    pub max_files: i64,
    pub used_content_bytes: i64,
    pub file_count: i64,
}

#[derive(Serialize)]
pub(crate) struct TagLabel {
    #[serde(serialize_with = "serialize_token")]
    pub token: String,
    #[serde(with = "serde_bytes")]
    pub label: Vec<u8>,
}

fn serialize_token<S: serde::Serializer>(value: &str, serializer: S) -> Result<S::Ok, S::Error> {
    let bytes = URL_SAFE_NO_PAD
        .decode(value)
        .map_err(serde::ser::Error::custom)?;
    serde_bytes::serialize(&bytes, serializer)
}

#[derive(Serialize)]
pub(crate) struct UploadReceipt {
    pub id: String,
    pub expected_chunk_count: i64,
    pub current_chunk_count: i64,
}

pub(crate) enum MetadataUpdate {
    Updated(Item),
    Conflict(Item),
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

    /// Consume a valid invitation and register the key in one transaction.
    pub(crate) async fn consume_code(&self, code: &str, public: &[u8; 32]) -> Result<(), Error> {
        let hash = crypto::body_hash_bytes(code.trim().as_bytes());
        let mut tx = self.pool.begin().await?;
        let limits = sqlx::query(
            r#"
            DELETE FROM registration_codes
            WHERE code_hash = $1 AND expires_at > $2
            RETURNING max_content_bytes, max_files
            "#,
        )
        .bind(hash.as_slice())
        .bind(crypto::now_secs() as i64)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or(Error::RegistrationFailed)?;
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
        sqlx::query(
            "INSERT INTO key_quotas (public_key, max_content_bytes, max_files) VALUES ($1, $2, $3) ON CONFLICT (public_key) DO NOTHING",
        )
        .bind(public.as_slice())
        .bind(limits.try_get::<i64, _>("max_content_bytes")?)
        .bind(limits.try_get::<i64, _>("max_files")?)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(())
    }

    /// UPDATE takes the same quota-row lock as media mutations.
    pub(crate) async fn set_limits(
        &self,
        public: &[u8; 32],
        limits: StorageLimits,
    ) -> Result<(), Error> {
        limits.validate()?;
        let result = sqlx::query(
            "UPDATE key_quotas SET max_content_bytes = $2, max_files = $3 WHERE public_key = $1",
        )
        .bind(public.as_slice())
        .bind(limits.max_content_bytes)
        .bind(limits.max_files)
        .execute(&self.pool)
        .await
        .map_err(|error| match &error {
            sqlx::Error::Database(cause)
                if matches!(
                    cause.constraint(),
                    Some("key_quotas_content_limit" | "key_quotas_files_limit")
                ) =>
            {
                Error::BadRequest("Storage limits cannot be lower than current usage.".into())
            }
            _ => error.into(),
        })?;
        if result.rows_affected() == 0 {
            return Err(Error::NotFound);
        }
        Ok(())
    }

    /// Read only the signed owner's quota; never scan media for usage.
    pub(crate) async fn quota(&self, owner: [u8; 32]) -> Result<Quota, Error> {
        let row = sqlx::query(
            "SELECT max_content_bytes, max_files, used_content_bytes, file_count FROM key_quotas WHERE public_key = $1",
        ).bind(owner.as_slice()).fetch_optional(&self.pool).await?.ok_or(Error::NotFound)?;
        Ok(Quota {
            max_content_bytes: row.try_get("max_content_bytes")?,
            max_files: row.try_get("max_files")?,
            used_content_bytes: row.try_get("used_content_bytes")?,
            file_count: row.try_get("file_count")?,
        })
    }

    /// Reserve the full encrypted size and a file slot before storing chunks.
    pub(crate) async fn create_upload(
        &self,
        owner: [u8; 32],
        body: &[u8],
    ) -> Result<UploadReceipt, Error> {
        let parts = frame::decode_upload(body)?;
        crypto::check_blob(parts.meta, MAX_META)?;
        crypto::check_blob(parts.descriptor, MAX_DESCRIPTOR)?;
        let (chunks, bytes) = frame::content_shape(parts.plaintext_bytes)?;
        let mut tx = self.pool.begin().await?;
        sqlx::query("SELECT public_key FROM key_quotas WHERE public_key = $1 FOR UPDATE")
            .bind(owner.as_slice())
            .fetch_optional(&mut *tx)
            .await?
            .ok_or(Error::Unauthorized)?;
        let reserved = sqlx::query("UPDATE key_quotas SET used_content_bytes = used_content_bytes + $2, file_count = file_count + 1 WHERE public_key = $1 AND used_content_bytes <= max_content_bytes - $2 AND file_count < max_files")
            .bind(owner.as_slice()).bind(bytes).execute(&mut *tx).await?;
        if reserved.rows_affected() == 0 {
            return Err(Error::StorageLimit);
        }
        let now = crypto::now_secs() as i64;
        let inserted = sqlx::query("INSERT INTO files (id, owner, meta, descriptor, plaintext_bytes, created_at, last_progress_at) VALUES ($1,$2,$3,$4,$5,$6,$6) ON CONFLICT (id) DO NOTHING")
            .bind(&parts.id).bind(owner.as_slice()).bind(parts.meta).bind(parts.descriptor).bind(parts.plaintext_bytes).bind(now).execute(&mut *tx).await?;
        if inserted.rows_affected() == 0 {
            return Err(Error::Conflict);
        }
        insert_tags(&mut tx, &parts.id, &parts.tags).await?;
        tx.commit().await?;
        Ok(UploadReceipt {
            id: parts.id,
            expected_chunk_count: chunks,
            current_chunk_count: 0,
        })
    }

    /// Serialize chunk insertion, retries and publication on the file row.
    pub(crate) async fn put_chunk(
        &self,
        owner: [u8; 32],
        id: &str,
        index: u64,
        content: &[u8],
    ) -> Result<(), Error> {
        let id = frame::parse_id(id)?;
        let index =
            i64::try_from(index).map_err(|_| Error::BadRequest("invalid chunk index".into()))?;
        let mut tx = self.pool.begin().await?;
        let row = sqlx::query("SELECT plaintext_bytes, expected_chunk_count FROM files WHERE owner = $1 AND id = $2 FOR UPDATE")
            .bind(owner.as_slice()).bind(&id).fetch_optional(&mut *tx).await?.ok_or(Error::NotFound)?;
        let size: i64 = row.try_get("plaintext_bytes")?;
        let count: i64 = row.try_get("expected_chunk_count")?;
        if index >= count {
            return Err(Error::BadRequest("invalid chunk index".into()));
        }
        let length = (size - index * CHUNK_PLAINTEXT_BYTES).min(CHUNK_PLAINTEXT_BYTES) + 16;
        if content.len() as i64 != length {
            return Err(Error::BadRequest("invalid encrypted chunk length".into()));
        }
        let existing: Option<Vec<u8>> =
            sqlx::query_scalar("SELECT ciphertext FROM chunks WHERE file_id = $1 AND index = $2")
                .bind(&id)
                .bind(index)
                .fetch_optional(&mut *tx)
                .await?;
        if let Some(existing) = existing {
            return if existing == content {
                Ok(())
            } else {
                Err(Error::Conflict)
            };
        }
        sqlx::query("INSERT INTO chunks (file_id, index, ciphertext) VALUES ($1,$2,$3)")
            .bind(&id)
            .bind(index)
            .bind(content)
            .execute(&mut *tx)
            .await?;
        sqlx::query("UPDATE files SET current_chunk_count = current_chunk_count + 1, last_progress_at = $2 WHERE id = $1")
            .bind(&id).bind(crypto::now_secs() as i64).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(())
    }

    pub(crate) async fn tags(&self, owner: [u8; 32]) -> Result<Vec<TagLabel>, Error> {
        let rows = sqlx::query("SELECT DISTINCT ON (t.token) t.token, t.label FROM tags t JOIN files f ON f.id = t.file_id WHERE f.owner = $1 AND f.current_chunk_count = f.expected_chunk_count ORDER BY t.token, t.file_id")
            .bind(owner.as_slice()).fetch_all(&self.pool).await?;
        rows.into_iter()
            .map(|row| {
                Ok(TagLabel {
                    token: row.try_get("token")?,
                    label: row.try_get("label")?,
                })
            })
            .collect()
    }

    pub(crate) async fn list(
        &self,
        owner: [u8; 32],
        tokens: &[String],
        after: Option<(i64, String)>,
    ) -> Result<(Vec<Item>, Option<String>), Error> {
        let (created_at, id) = after.map_or((None, None), |(ts, id)| (Some(ts), Some(id)));
        let mut items: Vec<Item> = sqlx::query_as(r#"
            SELECT id, meta, descriptor, expected_chunk_count, content_bytes AS bytes, created_at FROM files
            WHERE owner = $1 AND current_chunk_count = expected_chunk_count
              AND (SELECT count(DISTINCT token) FROM tags WHERE file_id = files.id AND token = ANY($2)) = cardinality($2)
              AND ($3::bigint IS NULL OR created_at < $3 OR (created_at = $3 AND id > $4))
            ORDER BY created_at DESC, id ASC LIMIT $5
        "#).bind(owner.as_slice()).bind(tokens).bind(created_at).bind(id).bind((PAGE + 1) as i64).fetch_all(&self.pool).await?;
        let more = items.len() > PAGE;
        items.truncate(PAGE);
        let next = more.then(|| {
            let last = items.last().expect("full page");
            format!("{}.{}", last.created_at, last.id)
        });
        Ok((items, next))
    }

    pub(crate) async fn metadata(&self, owner: [u8; 32], id: &str) -> Result<Item, Error> {
        let id = frame::parse_id(id)?;
        sqlx::query_as("SELECT id, meta, descriptor, expected_chunk_count, content_bytes AS bytes, created_at FROM files WHERE owner = $1 AND id = $2 AND current_chunk_count = expected_chunk_count")
            .bind(owner.as_slice()).bind(id).fetch_optional(&self.pool).await?.ok_or(Error::NotFound)
    }

    /// Sending a response never retains a database connection or transaction.
    pub(crate) async fn content_chunk(
        &self,
        owner: [u8; 32],
        id: &str,
        index: u64,
    ) -> Result<Vec<u8>, Error> {
        let id = frame::parse_id(id)?;
        let index = i64::try_from(index).map_err(|_| Error::NotFound)?;
        sqlx::query_scalar("SELECT c.ciphertext FROM chunks c JOIN files f ON f.id = c.file_id WHERE f.owner = $1 AND f.id = $2 AND c.index = $3 AND f.current_chunk_count = f.expected_chunk_count")
            .bind(owner.as_slice()).bind(id).bind(index).fetch_optional(&self.pool).await?.ok_or(Error::NotFound)
    }

    pub(crate) async fn update_meta(
        &self,
        owner: [u8; 32],
        id: &str,
        body: &[u8],
    ) -> Result<MetadataUpdate, Error> {
        let id = frame::parse_id(id)?;
        let parts = frame::decode_meta(body)?;
        crypto::check_blob(parts.meta, MAX_META)?;
        let mut tx = self.pool.begin().await?;
        let current: Item = sqlx::query_as("SELECT id, meta, descriptor, expected_chunk_count, content_bytes AS bytes, created_at FROM files WHERE id = $1 AND owner = $2 AND current_chunk_count = expected_chunk_count FOR UPDATE")
            .bind(&id).bind(owner.as_slice()).fetch_optional(&mut *tx).await?.ok_or(Error::NotFound)?;
        if crypto::body_hash_bytes(&current.meta) != parts.prev_meta_hash {
            return Ok(MetadataUpdate::Conflict(current));
        }
        sqlx::query("UPDATE files SET meta = $1 WHERE id = $2 AND owner = $3")
            .bind(parts.meta)
            .bind(&id)
            .bind(owner.as_slice())
            .execute(&mut *tx)
            .await?;
        replace_tags(&mut tx, &id, &parts.tags).await?;
        tx.commit().await?;
        Ok(MetadataUpdate::Updated(Item {
            meta: parts.meta.to_vec(),
            ..current
        }))
    }

    pub(crate) async fn remove(&self, owner: [u8; 32], id: &str) -> Result<(), Error> {
        let id = frame::parse_id(id)?;
        self.remove_file(owner, &id, None)
            .await?
            .ok_or(Error::NotFound)?;
        Ok(())
    }

    // Quota always precedes file locks. Cleanup rechecks idleness after waiting.
    async fn remove_file(
        &self,
        owner: [u8; 32],
        id: &str,
        stale_before: Option<i64>,
    ) -> Result<Option<i64>, Error> {
        let mut tx = self.pool.begin().await?;
        sqlx::query("SELECT public_key FROM key_quotas WHERE public_key = $1 FOR UPDATE")
            .bind(owner.as_slice())
            .fetch_optional(&mut *tx)
            .await?
            .ok_or(Error::NotFound)?;
        let bytes: Option<i64> = sqlx::query_scalar("DELETE FROM files WHERE id = $1 AND owner = $2 AND ($3::bigint IS NULL OR (current_chunk_count < expected_chunk_count AND last_progress_at <= $3)) RETURNING content_bytes")
            .bind(id).bind(owner.as_slice()).bind(stale_before).fetch_optional(&mut *tx).await?;
        let Some(bytes) = bytes else {
            return Ok(None);
        };
        sqlx::query("UPDATE key_quotas SET used_content_bytes = used_content_bytes - $2, file_count = file_count - 1 WHERE public_key = $1")
            .bind(owner.as_slice()).bind(bytes).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(Some(bytes))
    }

    pub(crate) async fn maintain(&self, now: i64) -> Result<(u64, u64, u64, i64), Error> {
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
        let mut partials = 0;
        let mut reclaimed_bytes: i64 = 0;
        let cutoff = now.saturating_sub(86400);
        loop {
            let candidates = sqlx::query("SELECT id, owner FROM files WHERE current_chunk_count < expected_chunk_count AND last_progress_at <= $1 ORDER BY last_progress_at, id LIMIT 100")
                .bind(cutoff).fetch_all(&self.pool).await?;
            if candidates.is_empty() {
                break;
            }
            for candidate in candidates {
                let id: String = candidate.try_get("id")?;
                let owner: Vec<u8> = candidate.try_get("owner")?;
                if let Some(bytes) = self
                    .remove_file(
                        owner.try_into().expect("owner length constrained"),
                        &id,
                        Some(cutoff),
                    )
                    .await?
                {
                    partials += 1;
                    reclaimed_bytes = reclaimed_bytes.saturating_add(bytes);
                }
            }
        }
        Ok((nonces, codes, partials, reclaimed_bytes))
    }
}

// The caller owns the transaction so a failed tag write rolls back its file change.
async fn replace_tags(
    tx: &mut Transaction<'_, Postgres>,
    id: &str,
    tags: &[frame::Tag],
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
    insert_tags(tx, id, tags).await
}

async fn insert_tags(
    tx: &mut Transaction<'_, Postgres>,
    id: &str,
    tags: &[frame::Tag],
) -> Result<(), Error> {
    if tags.is_empty() {
        return Ok(());
    }
    let tokens: Vec<_> = tags.iter().map(|tag| tag.token.as_str()).collect();
    let labels: Vec<_> = tags.iter().map(|tag| tag.label.as_slice()).collect();
    sqlx::query(
        r#"
        INSERT INTO tags (file_id, token, label)
        SELECT $1, token, label FROM unnest($2::text[], $3::bytea[]) AS tags(token, label)
        "#,
    )
    .bind(id)
    .bind(tokens)
    .bind(labels)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

#[cfg(all(test, feature = "postgres-tests"))]
mod tests {
    use super::*;
    use crate::reference_crypto::{encode_create, encode_meta, fixture_tag_labels, sealed_fixture};

    // Own the temporary database even if a test assertion or initialization panics.
    struct FixtureDatabase {
        name: String,
        admin_url: String,
        removed: bool,
    }

    impl Drop for FixtureDatabase {
        fn drop(&mut self) {
            if self.removed {
                return;
            }
            let name = self.name.clone();
            let admin_url = self.admin_url.clone();
            std::thread::spawn(move || {
                tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .unwrap()
                    .block_on(async move {
                        let admin = PgPool::connect(&admin_url).await.unwrap();
                        sqlx::query(&format!("DROP DATABASE {name} WITH (FORCE)"))
                            .execute(&admin)
                            .await
                            .unwrap();
                        admin.close().await;
                    });
            })
            .join()
            .unwrap();
        }
    }

    async fn fixture() -> (Database, PgPool, FixtureDatabase) {
        let (db, admin, name) = empty_fixture().await;
        db.initialize().await.unwrap();
        sqlx::query("INSERT INTO registered_keys (public_key) VALUES ($1)")
            .bind([1_u8; 32].as_slice())
            .execute(&db.pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO key_quotas (public_key) VALUES ($1)")
            .bind([1_u8; 32].as_slice())
            .execute(&db.pool)
            .await
            .unwrap();
        (db, admin, name)
    }

    async fn empty_fixture() -> (Database, PgPool, FixtureDatabase) {
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
        let guard = FixtureDatabase {
            name,
            admin_url: base,
            removed: false,
        };
        let db = Database::connect(url.as_str()).await.unwrap();
        (db, admin, guard)
    }

    async fn dispose(db: Database, admin: PgPool, mut fixture: FixtureDatabase) {
        db.close().await;
        sqlx::query(&format!("DROP DATABASE {} WITH (FORCE)", fixture.name))
            .execute(&admin)
            .await
            .unwrap();
        fixture.removed = true;
        admin.close().await;
    }

    async fn wait_for_locks(db: &Database, query_pattern: &str, count: i64) {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let waiting: i64 = sqlx::query_scalar(
                    "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE $1",
                )
                .bind(query_pattern)
                .fetch_one(&db.pool)
                .await
                .unwrap();
                if waiting >= count {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("operation must wait for the preceding transaction");
    }

    async fn assert_usage(db: &Database, owner: [u8; 32], expected: (i64, i64)) {
        let stored: (i64, i64) = sqlx::query_as(
            "SELECT used_content_bytes, file_count FROM key_quotas WHERE public_key = $1",
        )
        .bind(owner.as_slice())
        .fetch_one(&db.pool)
        .await
        .unwrap();
        let actual: (i64, i64) = sqlx::query_as(
            "SELECT COALESCE(SUM(content_bytes), 0)::bigint, COUNT(*) FROM files WHERE owner = $1",
        )
        .bind(owner.as_slice())
        .fetch_one(&db.pool)
        .await
        .unwrap();
        assert_eq!(stored, actual);
        assert_eq!(stored, expected);
    }

    #[tokio::test]
    async fn chain_schema_initialization_reopens_and_serializes_startup() {
        let (db, admin, guard) = empty_fixture().await;
        let (first, second) = tokio::join!(db.initialize(), db.initialize());
        first.unwrap();
        second.unwrap();
        let initial = crate::reference_crypto::from_seed([7; 32]);
        let library = crate::chain::genesis(&initial.public).unwrap();
        sqlx::query("INSERT INTO libraries(id,genesis_device_key,head_hash) VALUES($1,$2,$1)")
            .bind(library.as_slice())
            .bind(initial.public.as_slice())
            .execute(&db.pool)
            .await
            .unwrap();
        db.initialize().await.unwrap();
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM libraries")
            .fetch_one(&db.pool)
            .await
            .unwrap();
        let versions: Vec<i64> =
            sqlx::query_scalar("SELECT version FROM _sqlx_migrations ORDER BY version")
                .fetch_all(&db.pool)
                .await
                .unwrap();
        assert_eq!(count, 1);
        assert_eq!(versions, [1]);
        dispose(db, admin, guard).await;
    }

    #[tokio::test]
    async fn chain_schema_preserves_history_addresses_and_purge_tombstones() {
        let (db, admin, guard) = empty_fixture().await;
        db.initialize().await.unwrap();
        let initial = crate::reference_crypto::from_seed([7; 32]);
        let library = crate::chain::genesis(&initial.public).unwrap();
        sqlx::query("INSERT INTO libraries(id,genesis_device_key,head_hash) VALUES($1,$2,$1)")
            .bind(library.as_slice())
            .bind(initial.public.as_slice())
            .execute(&db.pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO devices(public_key,library_id,authorized_at_sequence) VALUES($1,$2,0)",
        )
        .bind(initial.public.as_slice())
        .bind(library.as_slice())
        .execute(&db.pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO blocks(library_id,sequence,hash,previous_hash,signer_key,signed_body,signature) VALUES($1,1,$2,$1,$3,$4,$5)")
            .bind(library.as_slice()).bind([3u8;32].as_slice()).bind(initial.public.as_slice()).bind([1u8].as_slice()).bind([0u8;64].as_slice()).execute(&db.pool).await.unwrap();
        sqlx::query("INSERT INTO files(library_id,file_id,status,staging_expires_at) VALUES($1,$2,'staging',100)")
            .bind(library.as_slice()).bind([4u8;32].as_slice()).execute(&db.pool).await.unwrap();
        let ciphertext = [6u8; 16];
        let hash = crate::chain::digest(&ciphertext);
        sqlx::query("INSERT INTO blobs(library_id,file_id,hash,ciphertext,staging_expires_at) VALUES($1,$2,$3,$4,100)")
            .bind(library.as_slice()).bind([4u8;32].as_slice()).bind(hash.as_slice()).bind(ciphertext.as_slice()).execute(&db.pool).await.unwrap();
        for query in [
            "UPDATE blocks SET signed_body = decode('00','hex')",
            "DELETE FROM blocks",
            "UPDATE blobs SET ciphertext = decode(repeat('07',16),'hex')",
            "UPDATE libraries SET used_blob_bytes = max_blob_bytes + 1",
            "UPDATE devices SET public_key = decode(repeat('08',32),'hex')",
        ] {
            assert!(
                sqlx::query(query).execute(&db.pool).await.is_err(),
                "{query}"
            );
        }
        sqlx::query("UPDATE blobs SET committed_at_sequence=1,staging_expires_at=NULL")
            .execute(&db.pool)
            .await
            .unwrap();
        assert!(
            sqlx::query("UPDATE blobs SET committed_at_sequence=NULL,staging_expires_at=200")
                .execute(&db.pool)
                .await
                .is_err()
        );
        sqlx::query("UPDATE files SET status='retained',staging_expires_at=NULL")
            .execute(&db.pool)
            .await
            .unwrap();
        assert!(sqlx::query("DELETE FROM blobs")
            .execute(&db.pool)
            .await
            .is_err());
        sqlx::query("UPDATE files SET status='purged'")
            .execute(&db.pool)
            .await
            .unwrap();
        sqlx::query("DELETE FROM blobs")
            .execute(&db.pool)
            .await
            .unwrap();
        assert!(sqlx::query("DELETE FROM files")
            .execute(&db.pool)
            .await
            .is_err());
        assert!(sqlx::query("UPDATE files SET status='retained'")
            .execute(&db.pool)
            .await
            .is_err());
        sqlx::query("UPDATE devices SET revoked_at_sequence=2")
            .execute(&db.pool)
            .await
            .unwrap();
        assert!(sqlx::query("UPDATE devices SET revoked_at_sequence=NULL")
            .execute(&db.pool)
            .await
            .is_err());
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT count(*) FROM blocks")
                .fetch_one(&db.pool)
                .await
                .unwrap(),
            1
        );
        dispose(db, admin, guard).await;
    }

    #[tokio::test]
    async fn fixture_cleanup_survives_a_panicking_test() {
        let (db, admin, fixture) = empty_fixture().await;
        let name = fixture.name.clone();
        let failed = std::panic::catch_unwind(move || {
            let _owned = fixture;
            panic!("simulated test assertion failure");
        });
        assert!(failed.is_err());
        let remaining: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM pg_database WHERE datname = $1")
                .bind(name)
                .fetch_one(&admin)
                .await
                .unwrap();
        assert_eq!(remaining, 0);
        db.close().await;
        admin.close().await;
    }

    #[tokio::test]
    async fn initialization_rejects_changed_migration_checksum() {
        let (db, admin, name) = empty_fixture().await;
        db.initialize().await.unwrap();
        sqlx::query("UPDATE _sqlx_migrations SET checksum = decode('00', 'hex') WHERE version = 1")
            .execute(&db.pool)
            .await
            .unwrap();
        assert!(matches!(
            db.initialize().await,
            Err(Error::Migration(
                sqlx::migrate::MigrateError::VersionMismatch(1)
            ))
        ));
        dispose(db, admin, name).await;
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
        assert_eq!(db.maintain(100).await.unwrap(), (1, 2, 0, 0));
        assert_eq!(db.maintain(100).await.unwrap(), (0, 0, 0, 0));
        assert_eq!(db.maintain(101).await.unwrap(), (1, 1, 0, 0));
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
        .bind(&name.name)
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

    #[tokio::test]
    async fn failed_registration_keeps_invitation_available() {
        let (db, admin, name) = empty_fixture().await;
        db.initialize().await.unwrap();
        let code = db.issue_code(3600, StorageLimits::default()).await.unwrap();
        sqlx::raw_sql(
            r#"
            CREATE FUNCTION reject_registration() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN
                RAISE EXCEPTION 'test registration failure';
            END;
            $$;
            CREATE TRIGGER reject_registration BEFORE INSERT ON key_quotas
                FOR EACH ROW EXECUTE FUNCTION reject_registration();
            "#,
        )
        .execute(&db.pool)
        .await
        .unwrap();
        assert!(matches!(
            db.consume_code(&code, &[1; 32]).await,
            Err(Error::Db(_))
        ));
        assert!(!db.allowed(&[1; 32]).await.unwrap());
        sqlx::query("DROP TRIGGER reject_registration ON key_quotas")
            .execute(&db.pool)
            .await
            .unwrap();
        db.consume_code(&code, &[1; 32]).await.unwrap();
        assert!(db.allowed(&[1; 32]).await.unwrap());
        assert!(matches!(
            db.consume_code(&code, &[2; 32]).await,
            Err(Error::RegistrationFailed)
        ));
        dispose(db, admin, name).await;
    }

    #[tokio::test]
    async fn concurrent_nonce_reservation_has_one_winner() {
        let (db, admin, name) = fixture().await;
        let (a, b) = tokio::join!(
            db.remember_nonce("same-nonce", 100),
            db.remember_nonce("same-nonce", 100)
        );
        assert!(matches!(
            (a, b),
            (Ok(()), Err(Error::Unauthorized)) | (Err(Error::Unauthorized), Ok(()))
        ));
        assert!(matches!(
            db.remember_nonce("same-nonce", 100).await,
            Err(Error::Unauthorized)
        ));
        assert_eq!(
            db.maintain(100 + SKEW_SECS as i64).await.unwrap(),
            (0, 0, 0, 0)
        );
        assert_eq!(
            db.maintain(101 + SKEW_SECS as i64).await.unwrap(),
            (1, 0, 0, 0)
        );
        dispose(db, admin, name).await;
    }

    #[tokio::test]
    async fn maintenance_shutdown_waits_for_active_sweep_without_upload_permits() {
        let (db, admin, name) = fixture().await;
        sqlx::query("INSERT INTO nonces (nonce, expires) VALUES ('expired', 0)")
            .execute(&db.pool)
            .await
            .unwrap();
        let state = crate::AppState::new(db.clone(), "http://i2nclip.test".into());
        let mut permits = Vec::new();
        for key in 0..4 {
            permits.push(state.permits.upload([key; 32]).await.unwrap());
        }
        let mut blocked = db.pool.begin().await.unwrap();
        sqlx::query("LOCK TABLE nonces IN ACCESS EXCLUSIVE MODE")
            .execute(&mut *blocked)
            .await
            .unwrap();
        let (stop, receiver) = tokio::sync::watch::channel(false);
        let task = tokio::spawn(crate::maintenance::run(db.clone(), receiver));
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let waiting: bool = sqlx::query_scalar(
                    r#"
                    SELECT EXISTS(
                        SELECT 1 FROM pg_stat_activity
                        WHERE datname = current_database()
                          AND wait_event_type = 'Lock'
                          AND query LIKE '%DELETE FROM nonces%'
                    )
                    "#,
                )
                .fetch_one(&db.pool)
                .await
                .unwrap();
                if waiting {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("startup sweep must reach the database despite busy upload slots");
        stop.send(true).unwrap();
        assert!(!task.is_finished(), "shutdown must await the blocked sweep");
        blocked.commit().await.unwrap();
        tokio::time::timeout(Duration::from_secs(5), task)
            .await
            .unwrap()
            .unwrap();
        let remaining: i64 = sqlx::query_scalar("SELECT count(*) FROM nonces")
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert_eq!(remaining, 0, "the active sweep finishes before shutdown");
        drop(permits);
        drop(state);
        dispose(db, admin, name).await;
    }

    fn creation(value: u8, size: i64, tokens: &str) -> Vec<u8> {
        encode_create(
            &format!("{value:064x}"),
            size,
            &sealed_fixture(value, 100),
            &sealed_fixture(value, 43),
            &fixture_tag_labels(tokens),
        )
    }

    async fn complete(db: &Database, value: u8, size: i64, tokens: &str) -> Item {
        let pending = db
            .create_upload([1; 32], &creation(value, size, tokens))
            .await
            .unwrap();
        for index in 0..pending.expected_chunk_count {
            let length = (size - index * CHUNK_PLAINTEXT_BYTES).min(CHUNK_PLAINTEXT_BYTES) + 16;
            db.put_chunk(
                [1; 32],
                &pending.id,
                index as u64,
                &vec![value; length as usize],
            )
            .await
            .unwrap();
        }
        db.metadata([1; 32], &pending.id).await.unwrap()
    }

    #[tokio::test]
    async fn pending_uploads_reserve_quota_and_publish_only_after_every_distinct_chunk() {
        let (db, admin, guard) = fixture().await;
        let token = URL_SAFE_NO_PAD.encode([3; 32]);
        let pending = db
            .create_upload([1; 32], &creation(1, CHUNK_PLAINTEXT_BYTES + 3, &token))
            .await
            .unwrap();
        assert_eq!(pending.expected_chunk_count, 2);
        assert_usage(&db, [1; 32], (CHUNK_PLAINTEXT_BYTES + 35, 1)).await;
        assert!(db.list([1; 32], &[], None).await.unwrap().0.is_empty());
        assert!(db.tags([1; 32]).await.unwrap().is_empty());
        assert!(matches!(
            db.metadata([1; 32], &pending.id).await,
            Err(Error::NotFound)
        ));
        assert!(matches!(
            db.content_chunk([1; 32], &pending.id, 0).await,
            Err(Error::NotFound)
        ));
        assert!(matches!(
            db.put_chunk([2; 32], &pending.id, 0, &[1; 19]).await,
            Err(Error::NotFound)
        ));
        assert!(matches!(
            db.put_chunk([1; 32], &pending.id, 2, &[1; 19]).await,
            Err(Error::BadRequest(_))
        ));
        assert!(matches!(
            db.put_chunk([1; 32], &pending.id, 1, &[1; 18]).await,
            Err(Error::BadRequest(_))
        ));
        let (a, b) = tokio::join!(
            db.put_chunk([1; 32], &pending.id, 1, &[1; 19]),
            db.put_chunk([1; 32], &pending.id, 1, &[1; 19])
        );
        a.unwrap();
        b.unwrap();
        sqlx::query("UPDATE files SET last_progress_at = 0 WHERE id = $1")
            .bind(&pending.id)
            .execute(&db.pool)
            .await
            .unwrap();
        db.put_chunk([1; 32], &pending.id, 1, &[1; 19])
            .await
            .unwrap();
        let state: (i64, i64) =
            sqlx::query_as("SELECT current_chunk_count,last_progress_at FROM files WHERE id = $1")
                .bind(&pending.id)
                .fetch_one(&db.pool)
                .await
                .unwrap();
        assert_eq!(state, (1, 0));
        assert!(matches!(
            db.put_chunk([1; 32], &pending.id, 1, &[2; 19]).await,
            Err(Error::Conflict)
        ));
        db.put_chunk(
            [1; 32],
            &pending.id,
            0,
            &vec![1; CHUNK_PLAINTEXT_BYTES as usize + 16],
        )
        .await
        .unwrap();
        assert_eq!(db.list([1; 32], &[token], None).await.unwrap().0.len(), 1);
        assert_eq!(db.tags([1; 32]).await.unwrap().len(), 1);
        assert_eq!(
            db.content_chunk([1; 32], &pending.id, 1).await.unwrap(),
            vec![1; 19]
        );
        assert!(matches!(
            db.content_chunk([1; 32], &pending.id, u64::MAX).await,
            Err(Error::NotFound)
        ));
        dispose(db, admin, guard).await;
    }

    #[tokio::test]
    async fn quota_reservations_serialize_and_release_exactly_once() {
        let (db, admin, guard) = fixture().await;
        db.set_limits(
            &[1; 32],
            StorageLimits {
                max_content_bytes: 21,
                max_files: 1,
            },
        )
        .await
        .unwrap();
        let a = creation(1, 5, "");
        let b = creation(2, 5, "");
        let (a, b) = tokio::join!(db.create_upload([1; 32], &a), db.create_upload([1; 32], &b));
        let saved = match (a, b) {
            (Ok(v), Err(Error::StorageLimit)) | (Err(Error::StorageLimit), Ok(v)) => v,
            _ => panic!("one reservation must win"),
        };
        assert_usage(&db, [1; 32], (21, 1)).await;
        assert!(matches!(
            db.remove([2; 32], &saved.id).await,
            Err(Error::NotFound)
        ));
        assert!(db
            .set_limits(
                &[1; 32],
                StorageLimits {
                    max_content_bytes: 20,
                    max_files: 1
                }
            )
            .await
            .is_err());
        let (a, b) = tokio::join!(db.remove([1; 32], &saved.id), db.remove([1; 32], &saved.id));
        assert!(matches!(
            (a, b),
            (Ok(()), Err(Error::NotFound)) | (Err(Error::NotFound), Ok(()))
        ));
        assert_usage(&db, [1; 32], (0, 0)).await;
        let pending = db
            .create_upload([1; 32], &creation(3, 5, ""))
            .await
            .unwrap();
        db.set_limits(
            &[1; 32],
            StorageLimits {
                max_content_bytes: 42,
                max_files: 2,
            },
        )
        .await
        .unwrap();
        assert!(matches!(
            db.create_upload([1; 32], &creation(3, 5, "")).await,
            Err(Error::Conflict)
        ));
        assert_usage(&db, [1; 32], (21, 1)).await;
        db.remove([1; 32], &pending.id).await.unwrap();
        dispose(db, admin, guard).await;
    }

    #[tokio::test]
    async fn cleanup_reclaims_partial_chunks_at_idle_boundary_and_preserves_complete_files() {
        let (db, admin, guard) = fixture().await;
        let stale = db
            .create_upload([1; 32], &creation(1, CHUNK_PLAINTEXT_BYTES + 1, ""))
            .await
            .unwrap();
        db.put_chunk([1; 32], &stale.id, 1, &[1; 17]).await.unwrap();
        let fresh = db
            .create_upload([1; 32], &creation(2, 0, ""))
            .await
            .unwrap();
        let ready = complete(&db, 3, 0, "").await;
        sqlx::query("UPDATE files SET last_progress_at=0 WHERE id <> $1")
            .bind(&fresh.id)
            .execute(&db.pool)
            .await
            .unwrap();
        sqlx::query("UPDATE files SET last_progress_at=1 WHERE id=$1")
            .bind(&fresh.id)
            .execute(&db.pool)
            .await
            .unwrap();
        assert_eq!(
            db.maintain(86400).await.unwrap(),
            (0, 0, 1, CHUNK_PLAINTEXT_BYTES + 33)
        );
        assert_usage(&db, [1; 32], (32, 2)).await;
        assert!(db.metadata([1; 32], &ready.id).await.is_ok());
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT count(*) FROM chunks WHERE file_id=$1")
                .bind(&stale.id)
                .fetch_one(&db.pool)
                .await
                .unwrap(),
            0
        );
        assert_eq!(db.maintain(86401).await.unwrap(), (0, 0, 1, 16));
        assert_usage(&db, [1; 32], (16, 1)).await;
        dispose(db, admin, guard).await;
    }

    #[tokio::test]
    async fn cleanup_rechecks_completion_after_waiting_on_quota_lock() {
        let (db, admin, guard) = fixture().await;
        let pending = db
            .create_upload([1; 32], &creation(1, 0, ""))
            .await
            .unwrap();
        sqlx::query("UPDATE files SET last_progress_at=0")
            .execute(&db.pool)
            .await
            .unwrap();
        let mut blocker = db.pool.begin().await.unwrap();
        sqlx::query("SELECT public_key FROM key_quotas FOR UPDATE")
            .execute(&mut *blocker)
            .await
            .unwrap();
        let cleaner = {
            let db = db.clone();
            tokio::spawn(async move { db.maintain(86400).await })
        };
        wait_for_locks(&db, "%FROM key_quotas%FOR UPDATE%", 1).await;
        db.put_chunk([1; 32], &pending.id, 0, &[1; 16])
            .await
            .unwrap();
        blocker.commit().await.unwrap();
        assert_eq!(cleaner.await.unwrap().unwrap(), (0, 0, 0, 0));
        assert!(db.metadata([1; 32], &pending.id).await.is_ok());
        assert_usage(&db, [1; 32], (16, 1)).await;
        dispose(db, admin, guard).await;
    }

    #[tokio::test]
    async fn chunk_and_delete_commit_failures_preserve_counts_and_reservations() {
        let (db, admin, guard) = fixture().await;
        let pending = db
            .create_upload([1; 32], &creation(1, 0, ""))
            .await
            .unwrap();
        sqlx::raw_sql("CREATE FUNCTION fail_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test'; END; $$; CREATE CONSTRAINT TRIGGER reject_chunk AFTER INSERT ON chunks DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fail_commit();").execute(&db.pool).await.unwrap();
        assert!(db
            .put_chunk([1; 32], &pending.id, 0, &[1; 16])
            .await
            .is_err());
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT current_chunk_count FROM files")
                .fetch_one(&db.pool)
                .await
                .unwrap(),
            0
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT count(*) FROM chunks")
                .fetch_one(&db.pool)
                .await
                .unwrap(),
            0
        );
        assert_usage(&db, [1; 32], (16, 1)).await;
        sqlx::query("DROP TRIGGER reject_chunk ON chunks")
            .execute(&db.pool)
            .await
            .unwrap();
        db.put_chunk([1; 32], &pending.id, 0, &[1; 16])
            .await
            .unwrap();
        sqlx::raw_sql("CREATE CONSTRAINT TRIGGER reject_delete AFTER DELETE ON files DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fail_commit();").execute(&db.pool).await.unwrap();
        assert!(db.remove([1; 32], &pending.id).await.is_err());
        assert_usage(&db, [1; 32], (16, 1)).await;
        assert_eq!(
            db.content_chunk([1; 32], &pending.id, 0).await.unwrap(),
            vec![1; 16]
        );
        dispose(db, admin, guard).await;
    }

    #[tokio::test]
    async fn metadata_conflicts_preserve_immutable_content_and_tag_snapshots() {
        let (db, admin, guard) = fixture().await;
        let item = complete(&db, 1, 0, "").await;
        let prev = crypto::body_hash_bytes(&item.meta);
        let a = encode_meta(
            &prev,
            &sealed_fixture(2, 43),
            &fixture_tag_labels(&URL_SAFE_NO_PAD.encode([2; 32])),
        );
        let b = encode_meta(
            &prev,
            &sealed_fixture(3, 43),
            &fixture_tag_labels(&URL_SAFE_NO_PAD.encode([3; 32])),
        );
        let (a, b) = tokio::join!(
            db.update_meta([1; 32], &item.id, &a),
            db.update_meta([1; 32], &item.id, &b)
        );
        let (winner, loser) = match (a.unwrap(), b.unwrap()) {
            (MetadataUpdate::Updated(a), MetadataUpdate::Conflict(b))
            | (MetadataUpdate::Conflict(b), MetadataUpdate::Updated(a)) => (a, b),
            _ => panic!("one metadata winner"),
        };
        assert_eq!(winner.meta, loser.meta);
        assert_eq!(winner.descriptor, item.descriptor);
        assert_eq!(db.tags([1; 32]).await.unwrap().len(), 1);
        assert_eq!(
            db.content_chunk([1; 32], &item.id, 0).await.unwrap(),
            vec![1; 16]
        );
        assert_usage(&db, [1; 32], (16, 1)).await;
        dispose(db, admin, guard).await;
    }

    #[tokio::test]
    async fn fresh_schema_reopens_with_one_migration_and_immutable_chunk_data() {
        let (db, admin, guard) = fixture().await;
        let item = complete(&db, 1, 1, "").await;
        let pending = db
            .create_upload([1; 32], &creation(2, 0, ""))
            .await
            .unwrap();
        db.initialize().await.unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT count(*) FROM _sqlx_migrations")
                .fetch_one(&db.pool)
                .await
                .unwrap(),
            1
        );
        for query in [
            "UPDATE chunks SET ciphertext=decode(repeat('00',17),'hex')",
            "UPDATE files SET plaintext_bytes=2",
            "UPDATE files SET current_chunk_count=99",
        ] {
            assert!(sqlx::query(query).execute(&db.pool).await.is_err());
        }
        assert_eq!(
            db.content_chunk([1; 32], &item.id, 0).await.unwrap(),
            vec![1; 17]
        );
        assert!(matches!(
            db.metadata([1; 32], &pending.id).await,
            Err(Error::NotFound)
        ));
        assert_usage(&db, [1; 32], (33, 2)).await;
        dispose(db, admin, guard).await;
    }

    #[tokio::test]
    async fn pagination_and_tag_filters_exclude_partial_and_foreign_files() {
        let (db, admin, guard) = fixture().await;
        let token = URL_SAFE_NO_PAD.encode([4; 32]);
        for value in 1..=25 {
            complete(&db, value, 0, &token).await;
        }
        db.create_upload([1; 32], &creation(26, 0, &token))
            .await
            .unwrap();
        let (page, next) = db
            .list([1; 32], std::slice::from_ref(&token), None)
            .await
            .unwrap();
        assert_eq!(page.len(), 24);
        let (ts, id) = next
            .unwrap()
            .split_once('.')
            .map(|(ts, id)| (ts.parse().unwrap(), id.to_owned()))
            .unwrap();
        let (last, next) = db.list([1; 32], &[token], Some((ts, id))).await.unwrap();
        assert_eq!(last.len(), 1);
        assert!(next.is_none());
        assert!(!page.iter().any(|item| item.id == last[0].id));
        assert!(db.list([2; 32], &[], None).await.unwrap().0.is_empty());
        dispose(db, admin, guard).await;
    }
}
