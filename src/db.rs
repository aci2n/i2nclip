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

use crate::{crypto, frame, Error, StorageLimits, MAX_CONTENT, MAX_META, PAGE, SKEW_SECS};

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
#[derive(Debug)]
pub(crate) struct Item {
    pub id: String,
    pub meta: Vec<u8>,
    pub bytes: i64,
    pub created_at: i64,
}

#[derive(Debug, Serialize)]
pub(crate) struct Quota {
    pub max_content_bytes: i64,
    pub max_files: i64,
    pub max_file_plaintext_bytes: i64,
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
            INSERT INTO registration_codes (code_hash, expires_at, max_content_bytes, max_files, max_file_plaintext_bytes)
            VALUES ($1, $2, $3, $4, $5)
            "#,
        )
        .bind(hash.as_slice())
        .bind(expires)
        .bind(limits.max_content_bytes)
        .bind(limits.max_files)
        .bind(limits.max_file_plaintext_bytes)
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
            RETURNING max_content_bytes, max_files, max_file_plaintext_bytes
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
            "INSERT INTO key_quotas (public_key, max_content_bytes, max_files, max_file_plaintext_bytes) VALUES ($1, $2, $3, $4) ON CONFLICT (public_key) DO NOTHING",
        )
        .bind(public.as_slice())
        .bind(limits.try_get::<i64, _>("max_content_bytes")?)
        .bind(limits.try_get::<i64, _>("max_files")?)
        .bind(limits.try_get::<i64, _>("max_file_plaintext_bytes")?)
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
            "UPDATE key_quotas SET max_content_bytes = $2, max_files = $3, max_file_plaintext_bytes = $4 WHERE public_key = $1",
        )
        .bind(public.as_slice())
        .bind(limits.max_content_bytes)
        .bind(limits.max_files)
        .bind(limits.max_file_plaintext_bytes)
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
            "SELECT max_content_bytes, max_files, max_file_plaintext_bytes, used_content_bytes, file_count FROM key_quotas WHERE public_key = $1",
        ).bind(owner.as_slice()).fetch_optional(&self.pool).await?.ok_or(Error::NotFound)?;
        Ok(Quota {
            max_content_bytes: row.try_get("max_content_bytes")?,
            max_files: row.try_get("max_files")?,
            max_file_plaintext_bytes: row.try_get("max_file_plaintext_bytes")?,
            used_content_bytes: row.try_get("used_content_bytes")?,
            file_count: row.try_get("file_count")?,
        })
    }

    /// Commit sealed content, metadata, and tags together. An existing hash conflicts.
    pub(crate) async fn add(&self, owner: [u8; 32], body: &[u8]) -> Result<Item, Error> {
        let parts = frame::decode_upload(body)?;
        crypto::check_blob(parts.meta, MAX_META)?;
        let sealed = crypto::check_blob(parts.content, MAX_CONTENT)?;
        let plaintext_bytes = sealed.ct.len() - 16;
        let id = crypto::body_hash_async(parts.content).await;
        let created_at = crypto::now_secs() as i64;
        let mut tx = self.pool.begin().await?;
        // All media mutations lock the quota before touching file rows.
        let max_file_plaintext_bytes: i64 = sqlx::query_scalar(
            "SELECT max_file_plaintext_bytes FROM key_quotas WHERE public_key = $1 FOR UPDATE",
        )
        .bind(owner.as_slice())
        .fetch_optional(&mut *tx)
        .await?
        .ok_or(Error::Unauthorized)?;
        // Keep the existing duplicate response even when the library is full.
        let duplicate: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM files WHERE id = $1)")
                .bind(&id)
                .fetch_one(&mut *tx)
                .await?;
        if duplicate {
            return Err(Error::Conflict);
        }
        if max_file_plaintext_bytes == 0 || plaintext_bytes as i64 > max_file_plaintext_bytes {
            return Err(Error::FileSizeLimit);
        }
        // Reserve in this transaction. Subtract before comparison so values near
        // BIGINT's maximum cannot overflow. Failed insertion rolls this back.
        let reserved = sqlx::query(
            r#"
            UPDATE key_quotas
            SET used_content_bytes = used_content_bytes + $2, file_count = file_count + 1
            WHERE public_key = $1
              AND used_content_bytes <= max_content_bytes - $2
              AND file_count < max_files
            "#,
        )
        .bind(owner.as_slice())
        .bind(parts.content.len() as i64)
        .execute(&mut *tx)
        .await?;
        if reserved.rows_affected() == 0 {
            return Err(Error::StorageLimit);
        }
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
        insert_tags(&mut tx, &id, &parts.tags).await?;
        tx.commit().await?;
        Ok(Item {
            id,
            meta: parts.meta.to_vec(),
            bytes: parts.content.len() as i64,
            created_at,
        })
    }

    /// One encrypted spelling per owner-scoped token; no media payload is read.
    pub(crate) async fn tags(&self, owner: [u8; 32]) -> Result<Vec<TagLabel>, Error> {
        let rows = sqlx::query(
            r#"
            SELECT DISTINCT ON (t.token) t.token, t.label
            FROM tags t
            JOIN files f ON f.id = t.file_id
            WHERE f.owner = $1
            ORDER BY t.token, t.file_id
            "#,
        )
        .bind(owner.as_slice())
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter()
            .map(|row| {
                Ok(TagLabel {
                    token: row.try_get("token")?,
                    label: row.try_get("label")?,
                })
            })
            .collect()
    }

    /// Return one owner-filtered metadata page without fetching content bytes.
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
            SELECT id, meta, content_bytes AS bytes, created_at
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

    /// Read one authorized summary without fetching encrypted content bytes.
    pub(crate) async fn metadata(&self, owner: [u8; 32], id: &str) -> Result<Item, Error> {
        let id = frame::parse_id(id)?;
        let row = sqlx::query(
            "SELECT id, meta, content_bytes AS bytes, created_at FROM files WHERE owner = $1 AND id = $2",
        )
        .bind(owner.as_slice())
        .bind(id)
        .fetch_optional(&self.pool)
        .await?
        .ok_or(Error::NotFound)?;
        Ok(Item {
            id: row.try_get("id")?,
            meta: row.try_get("meta")?,
            bytes: row.try_get("bytes")?,
            created_at: row.try_get("created_at")?,
        })
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
    ) -> Result<MetadataUpdate, Error> {
        let id = frame::parse_id(id)?;
        let parts = frame::decode_meta(body)?;
        crypto::check_blob(parts.meta, MAX_META)?;
        let mut tx = self.pool.begin().await?;
        // Lock before comparing so concurrent replacements serialize. Under
        // READ COMMITTED this sees the preceding transaction's committed row.
        let current = sqlx::query(
            r#"
            SELECT meta, content_bytes AS bytes, created_at
            FROM files
            WHERE id = $1 AND owner = $2
            FOR UPDATE
            "#,
        )
        .bind(&id)
        .bind(owner.as_slice())
        .fetch_optional(&mut *tx)
        .await?
        .ok_or(Error::NotFound)?;
        let current_meta: Vec<u8> = current.try_get("meta")?;
        let bytes: i64 = current.try_get("bytes")?;
        let created_at: i64 = current.try_get("created_at")?;
        if crypto::body_hash_bytes(&current_meta) != parts.prev_meta_hash {
            tx.commit().await?;
            return Ok(MetadataUpdate::Conflict(Item {
                id,
                meta: current_meta,
                bytes,
                created_at,
            }));
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
            id,
            meta: parts.meta.to_vec(),
            bytes,
            created_at,
        }))
    }

    /// Delete the authorized file; the foreign key cascades deletion to its tags.
    pub(crate) async fn remove(&self, owner: [u8; 32], id: &str) -> Result<(), Error> {
        let id = frame::parse_id(id)?;
        let mut tx = self.pool.begin().await?;
        sqlx::query("SELECT public_key FROM key_quotas WHERE public_key = $1 FOR UPDATE")
            .bind(owner.as_slice())
            .fetch_optional(&mut *tx)
            .await?
            .ok_or(Error::NotFound)?;
        let bytes: i64 = sqlx::query_scalar(
            "DELETE FROM files WHERE id = $1 AND owner = $2 RETURNING content_bytes",
        )
        .bind(id)
        .bind(owner.as_slice())
        .fetch_optional(&mut *tx)
        .await?
        .ok_or(Error::NotFound)?;
        sqlx::query(
            "UPDATE key_quotas SET used_content_bytes = used_content_bytes - $2, file_count = file_count - 1 WHERE public_key = $1",
        )
        .bind(owner.as_slice())
        .bind(bytes)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
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
    use crate::reference_crypto::fixture_tag_labels;

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

    fn sealed_blob(value: u8) -> Vec<u8> {
        crate::reference_crypto::sealed_fixture(value, 42)
    }

    fn labeled(tokens: &[String]) -> Vec<frame::Tag> {
        frame::decode_upload(&crate::reference_crypto::encode_upload(
            b"",
            b"",
            &fixture_tag_labels(&tokens.join("\n")),
        ))
        .unwrap()
        .tags
    }

    #[tokio::test]
    async fn tag_labels_are_required_and_bounded_in_the_current_schema() {
        let (db, admin, name) = fixture().await;
        let body =
            crate::reference_crypto::encode_upload(&sealed_blob(1), &sealed_blob(1), b"\x90");
        let item = db.add([1; 32], &body).await.unwrap();
        let token = URL_SAFE_NO_PAD.encode([7; 32]);
        let missing = sqlx::query("INSERT INTO tags (file_id, token) VALUES ($1, $2)")
            .bind(&item.id)
            .bind(&token)
            .execute(&db.pool)
            .await
            .unwrap_err();
        assert_eq!(
            missing.as_database_error().unwrap().code().as_deref(),
            Some("23502")
        );
        for size in [0, 42, crate::MAX_TAG_LABEL + 1] {
            let error = sqlx::query("INSERT INTO tags (file_id, token, label) VALUES ($1, $2, $3)")
                .bind(&item.id)
                .bind(&token)
                .bind(vec![0_u8; size])
                .execute(&db.pool)
                .await
                .unwrap_err();
            assert_eq!(
                error.as_database_error().unwrap().code().as_deref(),
                Some("23514")
            );
        }
        for size in [43, crate::MAX_TAG_LABEL] {
            let label = crate::reference_crypto::sealed_fixture(1, size);
            sqlx::query("INSERT INTO tags (file_id, token, label) VALUES ($1, $2, $3) ON CONFLICT (file_id, token) DO UPDATE SET label = EXCLUDED.label")
                .bind(&item.id).bind(&token).bind(&label).execute(&db.pool).await.unwrap();
            db.initialize().await.unwrap();
            let labels = db.tags([1; 32]).await.unwrap();
            assert_eq!(labels.len(), 1);
            assert_eq!(labels[0].label, label);
        }
        dispose(db, admin, name).await;
    }

    #[tokio::test]
    async fn tag_catalog_is_owner_scoped_distinct_and_tracks_replacements_and_deletions() {
        let (db, admin, name) = fixture().await;
        let token = URL_SAFE_NO_PAD.encode([7; 32]);
        let body = |value| {
            crate::reference_crypto::encode_upload(
                &sealed_blob(value),
                &sealed_blob(value),
                &fixture_tag_labels(&token),
            )
        };
        let a = db.add([1; 32], &body(1)).await.unwrap();
        let b = db.add([1; 32], &body(2)).await.unwrap();
        let code = db.issue_code(3600, StorageLimits::default()).await.unwrap();
        db.consume_code(&code, &[2; 32]).await.unwrap();
        db.add([2; 32], &body(3)).await.unwrap();
        assert_eq!(db.tags([1; 32]).await.unwrap().len(), 1);
        assert!(db.tags([3; 32]).await.unwrap().is_empty());
        db.remove([1; 32], &b.id).await.unwrap();
        assert_eq!(db.tags([1; 32]).await.unwrap().len(), 1);
        assert_eq!(
            db.list([1; 32], std::slice::from_ref(&token), None)
                .await
                .unwrap()
                .0
                .len(),
            1
        );
        let update = crate::reference_crypto::encode_meta(
            &crypto::body_hash_bytes(&a.meta),
            &sealed_blob(4),
            &fixture_tag_labels(&token),
        );
        assert!(matches!(
            db.update_meta([1; 32], &a.id, &update).await.unwrap(),
            MetadataUpdate::Updated(_)
        ));
        assert_eq!(db.tags([1; 32]).await.unwrap()[0].token, token);
        let conflict = crate::reference_crypto::encode_meta(&[0; 32], &sealed_blob(5), b"\x90");
        assert!(matches!(
            db.update_meta([1; 32], &a.id, &conflict).await.unwrap(),
            MetadataUpdate::Conflict(_)
        ));
        assert_eq!(db.tags([1; 32]).await.unwrap().len(), 1);
        db.remove([1; 32], &a.id).await.unwrap();
        assert!(db.tags([1; 32]).await.unwrap().is_empty());
        assert_eq!(db.tags([2; 32]).await.unwrap().len(), 1);
        db.initialize().await.unwrap();
        assert_eq!(db.tags([2; 32]).await.unwrap().len(), 1);
        dispose(db, admin, name).await;
    }

    #[tokio::test]
    async fn bulk_tags_support_maximum_set_replacement_and_clearing() {
        let (db, admin, name) = fixture().await;
        let tokens: Vec<_> = (0..crate::MAX_TAGS)
            .map(|value| URL_SAFE_NO_PAD.encode([value as u8; 32]))
            .collect();
        let item = db
            .add(
                [1; 32],
                &crate::reference_crypto::encode_upload(
                    &sealed_blob(1),
                    &sealed_blob(1),
                    &fixture_tag_labels(&tokens.join("\n")),
                ),
            )
            .await
            .unwrap();
        let (listed, _) = db.list([1; 32], &tokens, None).await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, item.id);

        // Replace a full set with a different full set, not just append rows.
        let replacement: Vec<_> = (32..32 + crate::MAX_TAGS)
            .map(|value| URL_SAFE_NO_PAD.encode([value as u8; 32]))
            .collect();
        let result = db
            .update_meta(
                [1; 32],
                &item.id,
                &crate::reference_crypto::encode_meta(
                    &crypto::body_hash_bytes(&item.meta),
                    &sealed_blob(2),
                    &fixture_tag_labels(&replacement.join("\n")),
                ),
            )
            .await
            .unwrap();
        let MetadataUpdate::Updated(updated) = result else {
            panic!("current metadata must update");
        };
        assert!(db.list([1; 32], &tokens, None).await.unwrap().0.is_empty());
        let (listed, _) = db.list([1; 32], &replacement, None).await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, item.id);

        let result = db
            .update_meta(
                [1; 32],
                &item.id,
                &crate::reference_crypto::encode_meta(
                    &crypto::body_hash_bytes(&updated.meta),
                    &sealed_blob(3),
                    b"\x90",
                ),
            )
            .await
            .unwrap();
        assert!(matches!(result, MetadataUpdate::Updated(_)));
        let (listed, _) = db.list([1; 32], &[], None).await.unwrap();
        assert_eq!(listed[0].id, item.id);
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM tags WHERE file_id = $1")
            .bind(&item.id)
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert_eq!(count, 0);
        dispose(db, admin, name).await;
    }

    #[tokio::test]
    async fn concurrent_initialization_preserves_data() {
        let (db, admin, name) = empty_fixture().await;
        // Hold SQLx's migration lock so both starters contend on a fresh database.
        use sqlx::migrate::Migrate;

        let mut blocker = db.pool.acquire().await.unwrap();
        blocker.lock().await.unwrap();
        let release = async {
            wait_for_locks(&db, "%SELECT pg_advisory_lock%", 2).await;
            blocker.unlock().await.unwrap();
        };
        let (a, b, ()) = tokio::time::timeout(Duration::from_secs(10), async {
            tokio::join!(db.initialize(), db.initialize(), release)
        })
        .await
        .unwrap();
        a.unwrap();
        b.unwrap();
        let applied: i64 =
            sqlx::query_scalar("SELECT count(*) FROM _sqlx_migrations WHERE success")
                .fetch_one(&db.pool)
                .await
                .unwrap();
        assert_eq!(applied, 2);
        // Reinitialization must skip 001, rather than recreate a schema object.
        sqlx::query("DROP TRIGGER files_immutable_content ON files")
            .execute(&db.pool)
            .await
            .unwrap();
        db.remember_nonce("preserved", 100).await.unwrap();
        let (a, b) = tokio::join!(db.initialize(), db.initialize());
        a.unwrap();
        b.unwrap();
        assert!(matches!(
            db.remember_nonce("preserved", 100).await,
            Err(Error::Unauthorized)
        ));
        let recreated: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname = 'files_immutable_content')",
        )
        .fetch_one(&db.pool)
        .await
        .unwrap();
        assert!(!recreated);
        dispose(db, admin, name).await;
    }

    #[tokio::test]
    async fn per_file_migration_preserves_baseline_data_and_defaults() {
        use std::borrow::Cow;

        let (db, admin, name) = empty_fixture().await;
        let mut baseline = sqlx::migrate!("./sql");
        baseline.migrations = Cow::Owned(baseline.iter().take(1).cloned().collect());
        baseline.run(&db.pool).await.unwrap();
        sqlx::query("INSERT INTO registered_keys (public_key) VALUES ($1)")
            .bind([1_u8; 32].as_slice())
            .execute(&db.pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO key_quotas (public_key, max_content_bytes, max_files, used_content_bytes, file_count) VALUES ($1, 123, 4, 42, 1)")
            .bind([1_u8; 32].as_slice()).execute(&db.pool).await.unwrap();
        sqlx::query(
            "INSERT INTO files (id, owner, meta, content, created_at) VALUES ($1, $2, $3, $3, 100)",
        )
        .bind("a".repeat(64))
        .bind([1_u8; 32].as_slice())
        .bind(sealed_blob(1))
        .execute(&db.pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO registration_codes (code_hash, expires_at) VALUES ($1, $2)")
            .bind(crypto::body_hash_bytes(b"old-code").as_slice())
            .bind(crypto::now_secs() as i64 + 3600)
            .execute(&db.pool)
            .await
            .unwrap();
        db.initialize().await.unwrap();
        let quota = db.quota([1; 32]).await.unwrap();
        assert_eq!(
            (
                quota.max_content_bytes,
                quota.max_files,
                quota.max_file_plaintext_bytes
            ),
            (123, 4, 33_554_432)
        );
        assert_usage(&db, [1; 32], (42, 1)).await;
        assert_eq!(
            db.content([1; 32], &"a".repeat(64)).await.unwrap(),
            sealed_blob(1)
        );
        db.consume_code("old-code", &[2; 32]).await.unwrap();
        assert_eq!(
            db.quota([2; 32]).await.unwrap().max_file_plaintext_bytes,
            33_554_432
        );
        db.set_limits(
            &[1; 32],
            StorageLimits {
                max_content_bytes: 123,
                max_files: 4,
                max_file_plaintext_bytes: 1,
            },
        )
        .await
        .unwrap();
        db.initialize().await.unwrap();
        assert_eq!(db.quota([1; 32]).await.unwrap().max_file_plaintext_bytes, 1);
        for limit in [-1_i64, 536_870_913] {
            assert!(
                sqlx::query("UPDATE key_quotas SET max_file_plaintext_bytes = $1")
                    .bind(limit)
                    .execute(&db.pool)
                    .await
                    .is_err()
            );
            assert!(sqlx::query("INSERT INTO registration_codes (code_hash, expires_at, max_file_plaintext_bytes) VALUES ($1, 0, $2)")
                .bind([0_u8; 32].as_slice()).bind(limit).execute(&db.pool).await.is_err());
        }
        // Ensure the whole migration set is still recorded exactly once.
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT count(*) FROM _sqlx_migrations WHERE success")
                .fetch_one(&db.pool)
                .await
                .unwrap(),
            2
        );
        dispose(db, admin, name).await;
    }

    #[tokio::test]
    async fn per_file_limits_recheck_locked_quota_and_preserve_existing_files() {
        let (db, admin, name) = fixture().await;
        let upload = |value, size| {
            let content = crate::reference_crypto::encrypt(
                &[1; 32],
                &crate::reference_crypto::content_aad(),
                &vec![value; size],
            )
            .unwrap();
            crate::reference_crypto::encode_upload(&sealed_blob(1), &content, b"\x90")
        };
        let limits = StorageLimits {
            max_file_plaintext_bytes: 8,
            ..StorageLimits::default()
        };
        db.set_limits(&[1; 32], limits).await.unwrap();
        let first = upload(1, 8);
        let saved = db.add([1; 32], &first).await.unwrap();
        assert!(matches!(
            db.add([1; 32], &upload(2, 9)).await,
            Err(Error::FileSizeLimit)
        ));
        assert_usage(&db, [1; 32], (saved.bytes, 1)).await;

        // The upload must observe a quota reduction committed after it began.
        let mut blocker = db.pool.begin().await.unwrap();
        sqlx::query("UPDATE key_quotas SET max_file_plaintext_bytes = 0 WHERE public_key = $1")
            .bind([1_u8; 32].as_slice())
            .execute(&mut *blocker)
            .await
            .unwrap();
        let pending = upload(2, 8);
        let release = async {
            wait_for_locks(&db, "%FROM key_quotas%FOR UPDATE%", 1).await;
            blocker.commit().await.unwrap();
        };
        let (result, ()) = tokio::join!(db.add([1; 32], &pending), release);
        assert!(matches!(result, Err(Error::FileSizeLimit)));
        assert!(matches!(
            db.add([1; 32], &upload(3, 0)).await,
            Err(Error::FileSizeLimit)
        ));
        assert!(matches!(
            db.add([1; 32], &first).await,
            Err(Error::Conflict)
        ));
        assert_usage(&db, [1; 32], (saved.bytes, 1)).await;
        assert!(!db.content([1; 32], &saved.id).await.unwrap().is_empty());
        db.remove([1; 32], &saved.id).await.unwrap();
        assert_usage(&db, [1; 32], (0, 0)).await;
        dispose(db, admin, name).await;
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
    async fn waiting_metadata_update_reads_committed_metadata_and_tags() {
        let (db, admin, name) = fixture().await;
        let original = sealed_blob(1);
        let committed = sealed_blob(2);
        let token = URL_SAFE_NO_PAD.encode([3; 32]);
        let item = db
            .add(
                [1; 32],
                &crate::reference_crypto::encode_upload(&original, &sealed_blob(1), b"\x90"),
            )
            .await
            .unwrap();
        let mut writer = db.pool.begin().await.unwrap();
        sqlx::query("UPDATE files SET meta = $1 WHERE id = $2")
            .bind(committed.as_slice())
            .bind(&item.id)
            .execute(&mut *writer)
            .await
            .unwrap();
        replace_tags(
            &mut writer,
            &item.id,
            &labeled(std::slice::from_ref(&token)),
        )
        .await
        .unwrap();
        // A filtered list must not expose uncommitted tag/metadata changes.
        let (listed, _) = db.list([1; 32], &[], None).await.unwrap();
        assert_eq!(listed[0].meta, original);
        assert!(db
            .list([1; 32], std::slice::from_ref(&token), None)
            .await
            .unwrap()
            .0
            .is_empty());
        let updater = {
            let db = db.clone();
            let id = item.id.clone();
            tokio::spawn(async move {
                db.update_meta(
                    [1; 32],
                    &id,
                    &crate::reference_crypto::encode_meta(
                        &crypto::body_hash_bytes(&original),
                        &sealed_blob(4),
                        b"\x90",
                    ),
                )
                .await
            })
        };
        wait_for_locks(&db, "%FOR UPDATE%", 1).await;
        writer.commit().await.unwrap();
        let result = tokio::time::timeout(Duration::from_secs(5), updater)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let MetadataUpdate::Conflict(current) = result else {
            panic!("stale metadata must not overwrite the preceding writer");
        };
        assert_eq!(current.meta, committed);
        let (listed, _) = db
            .list([1; 32], std::slice::from_ref(&token), None)
            .await
            .unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].meta, current.meta);
        dispose(db, admin, name).await;
    }

    #[tokio::test]
    async fn competing_metadata_updates_have_one_winner() {
        let (db, admin, name) = fixture().await;
        let original = sealed_blob(1);
        let item = db
            .add(
                [1; 32],
                &crate::reference_crypto::encode_upload(&original, &sealed_blob(1), b"\x90"),
            )
            .await
            .unwrap();
        let mut blocker = db.pool.begin().await.unwrap();
        sqlx::query("SELECT id FROM files WHERE id = $1 FOR UPDATE")
            .bind(&item.id)
            .fetch_one(&mut *blocker)
            .await
            .unwrap();
        let mut tasks = Vec::new();
        for value in [2, 3] {
            let db = db.clone();
            let id = item.id.clone();
            let original = original.clone();
            tasks.push(tokio::spawn(async move {
                let token = URL_SAFE_NO_PAD.encode([value; 32]);
                db.update_meta(
                    [1; 32],
                    &id,
                    &crate::reference_crypto::encode_meta(
                        &crypto::body_hash_bytes(&original),
                        &sealed_blob(value),
                        &fixture_tag_labels(&token),
                    ),
                )
                .await
            }));
        }
        wait_for_locks(&db, "%FOR UPDATE%", 2).await;
        blocker.commit().await.unwrap();
        let mut winner = None;
        let mut loser = None;
        for task in tasks {
            match tokio::time::timeout(Duration::from_secs(5), task)
                .await
                .unwrap()
                .unwrap()
                .unwrap()
            {
                MetadataUpdate::Updated(item) => assert!(winner.replace(item).is_none()),
                MetadataUpdate::Conflict(item) => assert!(loser.replace(item).is_none()),
            }
        }
        let winner = winner.expect("one update succeeds");
        let loser = loser.expect("one update conflicts");
        assert_eq!(winner.meta, loser.meta);
        for value in [2, 3] {
            let token = URL_SAFE_NO_PAD.encode([value; 32]);
            let (listed, _) = db.list([1; 32], &[token], None).await.unwrap();
            if winner.meta == sealed_blob(value) {
                assert_eq!(listed.len(), 1);
                assert_eq!(listed[0].meta, winner.meta);
            } else {
                assert!(listed.is_empty());
            }
        }
        dispose(db, admin, name).await;
    }

    #[tokio::test]
    async fn committed_deletion_prevents_waiting_metadata_update() {
        let (db, admin, name) = fixture().await;
        let original = sealed_blob(1);
        let token = URL_SAFE_NO_PAD.encode([2; 32]);
        let item = db
            .add(
                [1; 32],
                &crate::reference_crypto::encode_upload(
                    &original,
                    &sealed_blob(1),
                    &fixture_tag_labels(&token),
                ),
            )
            .await
            .unwrap();
        let mut deletion = db.pool.begin().await.unwrap();
        sqlx::query(
            "UPDATE key_quotas SET used_content_bytes = 0, file_count = 0 WHERE public_key = $1",
        )
        .bind([1_u8; 32].as_slice())
        .execute(&mut *deletion)
        .await
        .unwrap();
        sqlx::query("DELETE FROM files WHERE id = $1 AND owner = $2")
            .bind(&item.id)
            .bind([1_u8; 32].as_slice())
            .execute(&mut *deletion)
            .await
            .unwrap();
        let updater = {
            let db = db.clone();
            let id = item.id;
            tokio::spawn(async move {
                db.update_meta(
                    [1; 32],
                    &id,
                    &crate::reference_crypto::encode_meta(
                        &crypto::body_hash_bytes(&original),
                        &sealed_blob(3),
                        b"\x90",
                    ),
                )
                .await
            })
        };
        wait_for_locks(&db, "%FOR UPDATE%", 1).await;
        deletion.commit().await.unwrap();
        assert!(matches!(
            tokio::time::timeout(Duration::from_secs(5), updater)
                .await
                .unwrap()
                .unwrap(),
            Err(Error::NotFound)
        ));
        let counts: (i64, i64) =
            sqlx::query_as("SELECT (SELECT count(*) FROM files), (SELECT count(*) FROM tags)")
                .fetch_one(&db.pool)
                .await
                .unwrap();
        assert_eq!(counts, (0, 0));
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
        let content = crate::reference_crypto::sealed_fixture(1, 100_000);
        let body = crate::reference_crypto::encode_upload(&sealed_blob(1), &content, b"\x90");
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
    async fn list_preserves_owner_and_tag_filters_across_cursor_ties() {
        let (db, admin, name) = fixture().await;
        let owner = [7_u8; 32];
        let other = [8_u8; 32];
        let tags = vec![
            URL_SAFE_NO_PAD.encode([1; 32]),
            URL_SAFE_NO_PAD.encode([2; 32]),
        ];
        let ids: Vec<_> = (0..28).map(|n| format!("{n:064x}")).collect();
        let mut tx = db.pool.begin().await.unwrap();
        let mut records: Vec<_> = ids
            .iter()
            .enumerate()
            .map(|(n, id)| {
                (
                    id.clone(),
                    owner,
                    if n < 26 { 100_i64 } else { 99 },
                    tags.clone(),
                )
            })
            .collect();
        records.extend([
            ("c".repeat(64), owner, 98, tags[..1].to_vec()),
            ("d".repeat(64), owner, 98, tags[1..].to_vec()),
            ("e".repeat(64), other, 101, tags.clone()),
        ]);
        for (id, owner, created_at, tokens) in records {
            sqlx::query(
                r#"
                                INSERT INTO files (id, owner, meta, content, created_at)
                                VALUES ($1, $2, $3, $4, $5)
                                "#,
            )
            .bind(&id)
            .bind(owner.as_slice())
            .bind(&[1_u8; 42][..])
            .bind(&[1_u8; 42][..])
            .bind(created_at)
            .execute(&mut *tx)
            .await
            .unwrap();
            replace_tags(&mut tx, &id, &labeled(&tokens)).await.unwrap();
        }
        tx.commit().await.unwrap();
        let (first, cursor) = db.list(owner, &tags, None).await.unwrap();
        assert_eq!(
            first.iter().map(|item| &item.id).collect::<Vec<_>>(),
            ids[..PAGE].iter().collect::<Vec<_>>()
        );
        assert!(first.iter().all(|item| item.bytes == 42));
        assert_eq!(cursor, Some(format!("100.{}", ids[PAGE - 1])));
        let after = Some((
            first.last().unwrap().created_at,
            first.last().unwrap().id.clone(),
        ));
        let (last, next) = db.list(owner, &tags, after).await.unwrap();
        assert_eq!(
            last.iter().map(|item| &item.id).collect::<Vec<_>>(),
            ids[PAGE..].iter().collect::<Vec<_>>()
        );
        assert!(next.is_none());
        let (first, _) = db.list(owner, &[], None).await.unwrap();
        let after = Some((
            first.last().unwrap().created_at,
            first.last().unwrap().id.clone(),
        ));
        let (last, next) = db.list(owner, &[], after).await.unwrap();
        assert_eq!(last.len(), 6);
        assert!(next.is_none());
        let (foreign, next) = db.list(other, &tags, None).await.unwrap();
        assert_eq!(foreign.len(), 1);
        assert_eq!(foreign[0].id, "e".repeat(64));
        assert!(next.is_none());
        dispose(db, admin, name).await;
    }

    #[tokio::test]
    async fn schema_bounds_and_immutable_content_protect_downloads() {
        let (db, admin, name) = fixture().await;
        let storage: String = sqlx::query_scalar("SELECT attstorage::text FROM pg_attribute WHERE attrelid = 'files'::regclass AND attname = 'content'")
            .fetch_one(&db.pool).await.unwrap();
        assert_eq!(storage, "e");

        for (meta_size, content_size) in [(41_i32, 42_i32), (65537, 42), (42, 41), (42, 536870977)]
        {
            // PostgreSQL's hex error rendering would itself exceed the 1 GiB
            // allocation limit for this boundary; escape output keeps it bounded.
            let mut tx = db.pool.begin().await.unwrap();
            sqlx::query("SET LOCAL bytea_output = 'escape'")
                .execute(&mut *tx)
                .await
                .unwrap();
            let error = sqlx::query(
                r#"
                                INSERT INTO files (id, owner, meta, content, created_at)
                                VALUES ($1, $2, convert_to(repeat('x', $3), 'UTF8'), convert_to(repeat('x', $4), 'UTF8'), 100)
                                "#,
            )
            .bind("a".repeat(64))
            .bind(&[1_u8; 32][..])
            .bind(meta_size)
            .bind(content_size)
            .execute(&mut *tx)
            .await
            .unwrap_err();
            assert_eq!(
                error.as_database_error().unwrap().code().as_deref(),
                Some("23514"),
                "{error}"
            );
        }
        let content = crate::reference_crypto::sealed_fixture(1, 100_000);
        let body = crate::reference_crypto::encode_upload(&sealed_blob(1), &content, b"\x90");
        let item = db.add([1; 32], &body).await.unwrap();
        let error = sqlx::query("UPDATE files SET content = $1 WHERE id = $2")
            .bind(&[2_u8; 42][..])
            .bind(&item.id)
            .execute(&db.pool)
            .await
            .unwrap_err();
        assert_eq!(
            error.as_database_error().unwrap().code().as_deref(),
            Some("23514")
        );
        assert_eq!(db.content([1; 32], &item.id).await.unwrap(), content);
        let (items, _) = db.list([1; 32], &[], None).await.unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].bytes, content.len() as i64);
        db.remove([1; 32], &item.id).await.unwrap();
        assert!(matches!(
            db.content([1; 32], &item.id).await,
            Err(Error::NotFound)
        ));
        dispose(db, admin, name).await;
    }

    #[tokio::test]
    async fn failed_upload_commit_rolls_back_content_metadata_and_tags() {
        let (db, admin, name) = fixture().await;
        db.set_limits(
            &[1; 32],
            StorageLimits {
                max_file_plaintext_bytes: crate::DEFAULT_MAX_FILE_PLAINTEXT_BYTES,
                max_content_bytes: 42,
                max_files: 1,
            },
        )
        .await
        .unwrap();
        sqlx::raw_sql(
            r#"
                            CREATE FUNCTION reject_commit() RETURNS trigger LANGUAGE plpgsql AS $$
                            BEGIN
                                RAISE EXCEPTION 'test commit failure';
                            END;
                            $$;
                            CREATE CONSTRAINT TRIGGER reject_commit
                                AFTER INSERT ON files DEFERRABLE INITIALLY DEFERRED
                                FOR EACH ROW EXECUTE FUNCTION reject_commit();
                "#,
        )
        .execute(&db.pool)
        .await
        .unwrap();
        let token = "A".repeat(43);
        let body = crate::reference_crypto::encode_upload(
            &sealed_blob(1),
            &sealed_blob(1),
            &fixture_tag_labels(&token),
        );
        assert!(matches!(db.add([1; 32], &body).await, Err(Error::Db(_))));
        let counts: (i64, i64) =
            sqlx::query_as("SELECT (SELECT count(*) FROM files), (SELECT count(*) FROM tags)")
                .fetch_one(&db.pool)
                .await
                .unwrap();
        assert_eq!(counts, (0, 0));
        assert_usage(&db, [1; 32], (0, 0)).await;
        sqlx::query("DROP TRIGGER reject_commit ON files")
            .execute(&db.pool)
            .await
            .unwrap();
        let item = db.add([1; 32], &body).await.unwrap();
        assert_eq!(db.content([1; 32], &item.id).await.unwrap(), sealed_blob(1));
        assert_usage(&db, [1; 32], (42, 1)).await;
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
    async fn storage_limits_enforce_boundaries_without_charging_failed_uploads() {
        let (db, admin, name) = fixture().await;
        let owner = [1; 32];
        let first =
            crate::reference_crypto::encode_upload(&sealed_blob(1), &sealed_blob(1), b"\x90");
        let second =
            crate::reference_crypto::encode_upload(&sealed_blob(2), &sealed_blob(2), b"\x90");
        let limits = StorageLimits {
            max_file_plaintext_bytes: crate::DEFAULT_MAX_FILE_PLAINTEXT_BYTES,
            max_content_bytes: 42,
            max_files: 1,
        };
        db.set_limits(&owner, limits).await.unwrap();
        let saved = db.add(owner, &first).await.unwrap();
        assert_eq!(saved.bytes, 42);
        assert!(matches!(db.add(owner, &first).await, Err(Error::Conflict)));
        assert!(matches!(
            db.add(owner, &second).await,
            Err(Error::StorageLimit)
        ));
        assert_usage(&db, owner, (42, 1)).await;
        // Exercise each limit independently, including limits near BIGINT max.
        for limits in [
            StorageLimits {
                max_file_plaintext_bytes: crate::DEFAULT_MAX_FILE_PLAINTEXT_BYTES,
                max_content_bytes: 57,
                max_files: i64::MAX,
            },
            StorageLimits {
                max_file_plaintext_bytes: crate::DEFAULT_MAX_FILE_PLAINTEXT_BYTES,
                max_content_bytes: i64::MAX,
                max_files: 1,
            },
        ] {
            db.set_limits(&owner, limits).await.unwrap();
            assert!(matches!(
                db.add(owner, &second).await,
                Err(Error::StorageLimit)
            ));
            assert_eq!(db.content(owner, &saved.id).await.unwrap(), sealed_blob(1));
        }
        // Reductions below usage fail, while metadata at the limit can change.
        for limits in [
            StorageLimits {
                max_file_plaintext_bytes: crate::DEFAULT_MAX_FILE_PLAINTEXT_BYTES,
                max_content_bytes: 28,
                max_files: 1,
            },
            StorageLimits {
                max_file_plaintext_bytes: crate::DEFAULT_MAX_FILE_PLAINTEXT_BYTES,
                max_content_bytes: 42,
                max_files: 0,
            },
        ] {
            assert!(matches!(
                db.set_limits(&owner, limits).await,
                Err(Error::BadRequest(_))
            ));
        }
        db.update_meta(
            owner,
            &saved.id,
            &crate::reference_crypto::encode_meta(
                &crypto::body_hash_bytes(&saved.meta),
                &sealed_blob(3),
                b"\x90",
            ),
        )
        .await
        .unwrap();
        assert_usage(&db, owner, (42, 1)).await;
        db.remove(owner, &saved.id).await.unwrap();
        assert_usage(&db, owner, (0, 0)).await;
        for limits in [
            StorageLimits {
                max_file_plaintext_bytes: crate::DEFAULT_MAX_FILE_PLAINTEXT_BYTES,
                max_content_bytes: 0,
                max_files: 10,
            },
            StorageLimits {
                max_file_plaintext_bytes: crate::DEFAULT_MAX_FILE_PLAINTEXT_BYTES,
                max_content_bytes: 100,
                max_files: 0,
            },
        ] {
            db.set_limits(&owner, limits).await.unwrap();
            assert!(matches!(
                db.add(owner, &second).await,
                Err(Error::StorageLimit)
            ));
            assert_usage(&db, owner, (0, 0)).await;
        }
        db.set_limits(&owner, limits).await.unwrap();
        let saved = db.add(owner, &second).await.unwrap();
        assert_eq!(db.list(owner, &[], None).await.unwrap().0.len(), 1);
        assert_eq!(saved.bytes, 42);
        // Another owner has its own capacity.
        sqlx::query("INSERT INTO registered_keys (public_key) VALUES ($1)")
            .bind([2_u8; 32].as_slice())
            .execute(&db.pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO key_quotas (public_key) VALUES ($1)")
            .bind([2_u8; 32].as_slice())
            .execute(&db.pool)
            .await
            .unwrap();
        db.add([2; 32], &first).await.unwrap();
        assert_usage(&db, owner, (42, 1)).await;
        assert_usage(&db, [2; 32], (42, 1)).await;
        assert!(matches!(
            db.set_limits(&[3; 32], limits).await,
            Err(Error::NotFound)
        ));
        assert!(matches!(
            db.set_limits(
                &owner,
                StorageLimits {
                    max_files: -1,
                    ..limits
                }
            )
            .await,
            Err(Error::BadRequest(_))
        ));
        assert!(matches!(
            db.add([3; 32], &first).await,
            Err(Error::Unauthorized)
        ));
        dispose(db, admin, name).await;
    }

    #[tokio::test]
    async fn storage_limits_serialize_uploads_and_observe_committed_limit_changes() {
        for limits in [
            StorageLimits {
                max_file_plaintext_bytes: crate::DEFAULT_MAX_FILE_PLAINTEXT_BYTES,
                max_content_bytes: 42,
                max_files: 100,
            },
            StorageLimits {
                max_file_plaintext_bytes: crate::DEFAULT_MAX_FILE_PLAINTEXT_BYTES,
                max_content_bytes: 1000,
                max_files: 1,
            },
        ] {
            let (db, admin, name) = fixture().await;
            db.set_limits(&[1; 32], limits).await.unwrap();
            let first =
                crate::reference_crypto::encode_upload(&sealed_blob(1), &sealed_blob(1), b"\x90");
            let second =
                crate::reference_crypto::encode_upload(&sealed_blob(2), &sealed_blob(2), b"\x90");
            let mut blocker = db.pool.begin().await.unwrap();
            sqlx::query("SELECT public_key FROM key_quotas FOR UPDATE")
                .execute(&mut *blocker)
                .await
                .unwrap();
            let release = async {
                wait_for_locks(&db, "%FROM key_quotas%FOR UPDATE%", 2).await;
                blocker.commit().await.unwrap();
            };
            let (a, b, ()) = tokio::time::timeout(Duration::from_secs(10), async {
                tokio::join!(db.add([1; 32], &first), db.add([1; 32], &second), release)
            })
            .await
            .unwrap();
            assert!(matches!(
                (a, b),
                (Ok(_), Err(Error::StorageLimit)) | (Err(Error::StorageLimit), Ok(_))
            ));
            assert_eq!(db.list([1; 32], &[], None).await.unwrap().0.len(), 1);
            assert_usage(&db, [1; 32], (42, 1)).await;
            dispose(db, admin, name).await;
        }
        let (db, admin, name) = fixture().await;
        let body =
            crate::reference_crypto::encode_upload(&sealed_blob(1), &sealed_blob(1), b"\x90");
        let mut blocker = db.pool.begin().await.unwrap();
        sqlx::query("UPDATE key_quotas SET max_files = 0")
            .execute(&mut *blocker)
            .await
            .unwrap();
        let release = async {
            wait_for_locks(&db, "%FROM key_quotas%FOR UPDATE%", 1).await;
            blocker.commit().await.unwrap();
        };
        let (result, ()) = tokio::join!(db.add([1; 32], &body), release);
        assert!(matches!(result, Err(Error::StorageLimit)));
        // Cancelling a queued upload leaves no state or held lock.
        db.set_limits(&[1; 32], StorageLimits::default())
            .await
            .unwrap();
        let mut blocker = db.pool.begin().await.unwrap();
        sqlx::query("SELECT public_key FROM key_quotas FOR UPDATE")
            .execute(&mut *blocker)
            .await
            .unwrap();
        let upload_db = db.clone();
        let upload_body = body.clone();
        let upload = tokio::spawn(async move { upload_db.add([1; 32], &upload_body).await });
        wait_for_locks(&db, "%FROM key_quotas%FOR UPDATE%", 1).await;
        upload.abort();
        assert!(upload.await.unwrap_err().is_cancelled());
        blocker.commit().await.unwrap();
        tokio::time::timeout(Duration::from_secs(5), db.add([1; 32], &body))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(db.list([1; 32], &[], None).await.unwrap().0.len(), 1);
        dispose(db, admin, name).await;
    }

    #[tokio::test]
    async fn quota_usage_rolls_back_failed_deletes_and_releases_only_owned_files() {
        let (db, admin, name) = fixture().await;
        let owner = [1; 32];
        let other = [2; 32];
        let code = db.issue_code(3600, StorageLimits::default()).await.unwrap();
        db.consume_code(&code, &other).await.unwrap();
        let body =
            crate::reference_crypto::encode_upload(&sealed_blob(1), &sealed_blob(1), b"\x90");
        let item = db.add(owner, &body).await.unwrap();
        assert!(matches!(
            db.remove(other, &item.id).await,
            Err(Error::NotFound)
        ));
        assert_usage(&db, owner, (42, 1)).await;
        assert_usage(&db, other, (0, 0)).await;
        sqlx::raw_sql(
            "CREATE FUNCTION reject_delete() RETURNS trigger LANGUAGE plpgsql AS $$
             BEGIN RAISE EXCEPTION 'test delete commit failure'; END; $$;
             CREATE CONSTRAINT TRIGGER reject_delete AFTER DELETE ON files
             DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_delete();",
        )
        .execute(&db.pool)
        .await
        .unwrap();
        assert!(matches!(
            db.remove(owner, &item.id).await,
            Err(Error::Db(_))
        ));
        assert_usage(&db, owner, (42, 1)).await;
        assert_eq!(db.content(owner, &item.id).await.unwrap(), sealed_blob(1));
        sqlx::query("DROP TRIGGER reject_delete ON files")
            .execute(&db.pool)
            .await
            .unwrap();
        let (a, b) = tokio::join!(db.remove(owner, &item.id), db.remove(owner, &item.id));
        assert!(matches!(
            (a, b),
            (Ok(()), Err(Error::NotFound)) | (Err(Error::NotFound), Ok(()))
        ));
        assert_usage(&db, owner, (0, 0)).await;
        assert!(matches!(
            db.remove(owner, &item.id).await,
            Err(Error::NotFound)
        ));
        assert_usage(&db, owner, (0, 0)).await;
        dispose(db, admin, name).await;
    }

    #[tokio::test]
    async fn cancelled_upload_rolls_back_reserved_usage() {
        let (db, admin, name) = fixture().await;
        let body =
            crate::reference_crypto::encode_upload(&sealed_blob(1), &sealed_blob(1), b"\x90");
        // Allow the quota reservation and duplicate lookup, but block insertion.
        let mut blocker = db.pool.begin().await.unwrap();
        sqlx::query("LOCK TABLE files IN SHARE MODE")
            .execute(&mut *blocker)
            .await
            .unwrap();
        let upload_db = db.clone();
        let upload_body = body.clone();
        let upload = tokio::spawn(async move { upload_db.add([1; 32], &upload_body).await });
        wait_for_locks(&db, "%INSERT INTO files%", 1).await;
        upload.abort();
        assert!(upload.await.unwrap_err().is_cancelled());
        blocker.commit().await.unwrap();
        // This takes the same quota lock, so it waits for cancellation rollback.
        tokio::time::timeout(
            Duration::from_secs(5),
            db.set_limits(&[1; 32], StorageLimits::default()),
        )
        .await
        .unwrap()
        .unwrap();
        assert_usage(&db, [1; 32], (0, 0)).await;
        db.add([1; 32], &body).await.unwrap();
        assert_usage(&db, [1; 32], (42, 1)).await;
        dispose(db, admin, name).await;
    }

    #[tokio::test]
    async fn concurrent_upload_and_delete_preserve_exact_usage() {
        let (db, admin, name) = fixture().await;
        db.set_limits(
            &[1; 32],
            StorageLimits {
                max_file_plaintext_bytes: crate::DEFAULT_MAX_FILE_PLAINTEXT_BYTES,
                max_content_bytes: 42,
                max_files: 1,
            },
        )
        .await
        .unwrap();
        let first =
            crate::reference_crypto::encode_upload(&sealed_blob(1), &sealed_blob(1), b"\x90");
        let second =
            crate::reference_crypto::encode_upload(&sealed_blob(2), &sealed_blob(2), b"\x90");
        let item = db.add([1; 32], &first).await.unwrap();
        let mut blocker = db.pool.begin().await.unwrap();
        sqlx::query("SELECT public_key FROM key_quotas FOR UPDATE")
            .execute(&mut *blocker)
            .await
            .unwrap();
        let release = async {
            wait_for_locks(&db, "%FROM key_quotas%FOR UPDATE%", 2).await;
            blocker.commit().await.unwrap();
        };
        let (upload, deletion, ()) = tokio::time::timeout(Duration::from_secs(10), async {
            tokio::join!(
                db.add([1; 32], &second),
                db.remove([1; 32], &item.id),
                release
            )
        })
        .await
        .unwrap();
        deletion.unwrap();
        match upload {
            Ok(_) => assert_usage(&db, [1; 32], (42, 1)).await,
            Err(Error::StorageLimit) => assert_usage(&db, [1; 32], (0, 0)).await,
            Err(error) => panic!("unexpected upload failure: {error}"),
        }
        dispose(db, admin, name).await;
    }

    #[tokio::test]
    async fn invitations_transfer_limits_only_to_new_keys() {
        let (db, admin, name) = fixture().await;
        let custom = StorageLimits {
            max_file_plaintext_bytes: 99,
            max_content_bytes: 123,
            max_files: 4,
        };
        let code = db.issue_code(3600, custom).await.unwrap();
        db.consume_code(&code, &[2; 32]).await.unwrap();
        let current: (i64, i64, i64) = sqlx::query_as(
            "SELECT max_content_bytes, max_files, max_file_plaintext_bytes FROM key_quotas WHERE public_key = $1",
        )
        .bind([2_u8; 32].as_slice())
        .fetch_one(&db.pool)
        .await
        .unwrap();
        assert_eq!(current, (123, 4, 99));
        let code = db.issue_code(3600, StorageLimits::default()).await.unwrap();
        db.consume_code(&code, &[2; 32]).await.unwrap();
        let current: (i64, i64, i64) = sqlx::query_as(
            "SELECT max_content_bytes, max_files, max_file_plaintext_bytes FROM key_quotas WHERE public_key = $1",
        )
        .bind([2_u8; 32].as_slice())
        .fetch_one(&db.pool)
        .await
        .unwrap();
        assert_eq!(current, (123, 4, 99));
        assert!(matches!(
            db.consume_code(&code, &[3; 32]).await,
            Err(Error::RegistrationFailed)
        ));
        let defaults: (i64, i64, i64) = sqlx::query_as(
            "SELECT max_content_bytes, max_files, max_file_plaintext_bytes FROM key_quotas WHERE public_key = $1",
        )
        .bind([1_u8; 32].as_slice())
        .fetch_one(&db.pool)
        .await
        .unwrap();
        assert_eq!(defaults, (536_870_912, 10_000, 33_554_432));
        dispose(db, admin, name).await;
    }

    #[tokio::test]
    async fn quota_state_survives_reinitialization() {
        let (db, admin, name) = fixture().await;
        let content = sealed_blob(1);
        let body = crate::reference_crypto::encode_upload(&content, &content, b"\x90");
        let item = db.add([1; 32], &body).await.unwrap();
        db.set_limits(
            &[1; 32],
            StorageLimits {
                max_file_plaintext_bytes: crate::DEFAULT_MAX_FILE_PLAINTEXT_BYTES,
                max_content_bytes: 42,
                max_files: 1,
            },
        )
        .await
        .unwrap();
        db.initialize().await.unwrap();
        assert_eq!(db.content([1; 32], &item.id).await.unwrap(), content);
        let quota = db.quota([1; 32]).await.unwrap();
        assert_eq!((quota.max_content_bytes, quota.max_files), (42, 1));
        assert_usage(&db, [1; 32], (42, 1)).await;
        db.set_limits(&[1; 32], StorageLimits::default())
            .await
            .unwrap();
        let next =
            crate::reference_crypto::encode_upload(&sealed_blob(2), &sealed_blob(2), b"\x90");
        db.add([1; 32], &next).await.unwrap();
        db.initialize().await.unwrap();
        assert_usage(&db, [1; 32], (84, 2)).await;
        db.remove([1; 32], &item.id).await.unwrap();
        assert_usage(&db, [1; 32], (42, 1)).await;
        dispose(db, admin, name).await;
    }

    #[tokio::test]
    async fn quota_checks_reject_invalid_usage_and_limit_reductions() {
        let (db, admin, name) = fixture().await;
        let body =
            crate::reference_crypto::encode_upload(&sealed_blob(1), &sealed_blob(1), b"\x90");
        db.add([1; 32], &body).await.unwrap();
        db.set_limits(
            &[1; 32],
            StorageLimits {
                max_file_plaintext_bytes: crate::DEFAULT_MAX_FILE_PLAINTEXT_BYTES,
                max_content_bytes: 42,
                max_files: 1,
            },
        )
        .await
        .unwrap();
        for (sql, constraint) in [
            (
                "UPDATE key_quotas SET used_content_bytes = 43",
                "key_quotas_content_limit",
            ),
            (
                "UPDATE key_quotas SET max_content_bytes = 28",
                "key_quotas_content_limit",
            ),
            (
                "UPDATE key_quotas SET file_count = 2",
                "key_quotas_files_limit",
            ),
            (
                "UPDATE key_quotas SET max_files = 0",
                "key_quotas_files_limit",
            ),
        ] {
            let error = sqlx::query(sql).execute(&db.pool).await.unwrap_err();
            let error = error.as_database_error().unwrap();
            assert_eq!(error.code().as_deref(), Some("23514"));
            assert_eq!(error.constraint(), Some(constraint));
            assert_usage(&db, [1; 32], (42, 1)).await;
        }
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
        assert_eq!(db.maintain(100 + SKEW_SECS as i64).await.unwrap(), (0, 0));
        assert_eq!(db.maintain(101 + SKEW_SECS as i64).await.unwrap(), (1, 0));
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
}
