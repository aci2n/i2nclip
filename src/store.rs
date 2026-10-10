//! SQLite index plus one directory of ciphertext blobs.
//!
//! ```text
//! /var/lib/i2nclip/i2nclip.db
//! /var/lib/i2nclip/blobs/<ciphertext_sha256>
//! /var/lib/i2nclip/staging/<ciphertext_sha256>
//! ```
//!
//! `rusqlite` is a blocking SQLite API, closer to JDBC than to an async
//! driver. These functions also read and write blob files with `std::fs`.
//! Callers in the HTTP layer run them on Tokio's blocking pool so a disk
//! wait does not stall the threads that read request bodies. `?1`, `?2` are
//! placeholders. We never format a value into the SQL string, except for the
//! `?N` placeholder numbers themselves.
//!
//! The owner column is the 32-byte public key taken from the signature.
//! Every read and write includes `owner = ?`, so knowing a content hash is not enough
//! to fetch someone else's file.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::MutexGuard;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rusqlite::params;
use rusqlite::Connection;
use rusqlite::OptionalExtension;
use rusqlite::Transaction;
use rusqlite::TransactionBehavior;
use sha2::Digest;
use sha2::Sha256;

use crate::crypto;
use crate::frame;
use crate::Error;
use crate::MAX_CONTENT;
use crate::MAX_META;
use crate::PAGE;

const SCHEMA: &str = include_str!("../sql/001_init.sql");
pub(crate) const UPLOAD_SLOTS: usize = 2;
const DOWNLOAD_SLOTS: usize = 2;

/// One stored object, still encrypted. `meta` is the ciphertext blob.
#[derive(Debug)]
pub(crate) struct Item {
    pub id: String,
    pub meta: Vec<u8>,
    pub bytes: i64,
    pub created_at: i64,
    pub tokens: Vec<String>,
}

pub(crate) const GC_MIN_AGE_SECS: i64 = 7 * 24 * 60 * 60;

/// Default lifetime for [`issue_registration_code`].
pub const DEFAULT_REGISTRATION_TTL_SECS: u64 = 86400;

#[derive(Debug, Default)]
pub(crate) struct GcReport {
    pub removed: usize,
    pub failed: usize,
}

/// Shared state for the process. `Clone` is cheap: it clones the `Arc`
/// pointers, not the database. `Arc` is an atomic reference count, like
/// `shared_ptr` in C++ or a shared immutable handle. `Mutex` is the lock
/// around the single SQLite connection (SQLite allows one writer).
#[derive(Clone)]
pub(crate) struct AppState {
    pub(crate) upload_slots: Arc<tokio::sync::Semaphore>,
    pub(crate) download_slots: Arc<tokio::sync::Semaphore>,
    data_dir: Arc<PathBuf>,
    db: Arc<Mutex<Connection>>,
    /// Public origin the signatures must name, such as `https://clip.example.com`.
    origin: String,
}

impl AppState {
    pub(crate) fn new(data_dir: PathBuf, conn: Connection, origin: String) -> Self {
        Self {
            upload_slots: Arc::new(tokio::sync::Semaphore::new(UPLOAD_SLOTS)),
            download_slots: Arc::new(tokio::sync::Semaphore::new(DOWNLOAD_SLOTS)),
            data_dir: Arc::new(data_dir),
            db: Arc::new(Mutex::new(conn)),
            origin,
        }
    }

    pub(crate) fn origin(&self) -> &str {
        &self.origin
    }

    pub(crate) fn lock(&self) -> Result<MutexGuard<'_, Connection>, Error> {
        // `lock()` returns Err if a thread panicked while holding the mutex.
        // The data inside might be half-updated, so we refuse to continue.
        self.db.lock().map_err(|_| Error::Poisoned)
    }

    fn blob_path(&self, id: &str) -> PathBuf {
        // `id` has already been checked to be a content hash with no slashes, so this
        // join cannot escape `blobs/`.
        self.data_dir.join("blobs").join(id)
    }
}

/// Create the data and blob directories the first time. Modes are octal, the
/// same numbers `chmod` takes. `0o700` is owner-only on a directory.
pub(crate) fn prepare(data_dir: &Path) -> Result<(), Error> {
    ensure_dir(data_dir, 0o700)?;
    ensure_dir(&data_dir.join("blobs"), 0o700)?;
    ensure_dir(&data_dir.join("staging"), 0o700)?;
    sync_dir(data_dir)?;
    Ok(())
}

/// Whether `public` is registered (`POST /api/register-key`, or direct SQL in tests).
pub(crate) fn is_allowed_public_key(conn: &Connection, public: &[u8; 32]) -> Result<bool, Error> {
    let found = conn
        .query_row(
            "SELECT 1 FROM registered_keys WHERE public_key = ?1",
            params![public.as_slice()],
            |_| Ok(()),
        )
        .optional()?;
    Ok(found.is_some())
}

fn registration_code_hash(otc: &str) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(otc.trim().as_bytes());
    hasher.finalize().into()
}

/// Insert a new one-time code. Returns the plaintext code once (for the admin to copy).
pub(crate) fn issue_registration_code(
    conn: &mut Connection,
    ttl_secs: u64,
) -> Result<String, Error> {
    let mut secret = [0u8; 16];
    getrandom::getrandom(&mut secret).map_err(|err| std::io::Error::other(err.to_string()))?;
    let code = URL_SAFE_NO_PAD.encode(secret);
    let hash = registration_code_hash(&code);
    let now = crypto::now_secs();
    let expires = i64::try_from(now.saturating_add(ttl_secs)).unwrap_or(i64::MAX);
    let now_i64 = i64::try_from(now).unwrap_or(i64::MAX);
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    tx.execute(
        "DELETE FROM registration_codes WHERE expires_at < ?1",
        [now_i64],
    )?;
    tx.execute(
        "INSERT INTO registration_codes (code_hash, expires_at) VALUES (?1, ?2)",
        params![hash.as_slice(), expires],
    )?;
    tx.commit()?;
    Ok(code)
}

/// Void a valid code and allow `public`. Idempotent if the key is already registered.
pub(crate) fn consume_registration_code(
    conn: &mut Connection,
    otc: &str,
    public: &[u8; 32],
) -> Result<(), Error> {
    if otc.trim().is_empty() {
        return Err(Error::RegistrationFailed);
    }
    let hash = registration_code_hash(otc);
    let now = i64::try_from(crypto::now_secs()).unwrap_or(0);
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let deleted = tx.execute(
        "DELETE FROM registration_codes WHERE code_hash = ?1 AND expires_at > ?2",
        params![hash.as_slice(), now],
    )?;
    if deleted == 0 {
        return Err(Error::RegistrationFailed);
    }
    tx.execute(
        "INSERT OR IGNORE INTO registered_keys (public_key) VALUES (?1)",
        params![public.as_slice()],
    )?;
    tx.commit()?;
    Ok(())
}

pub(crate) fn open(data_dir: &Path) -> Result<Connection, Error> {
    let path = data_dir.join("i2nclip.db");
    let conn = Connection::open(&path)?;
    set_mode(&path, 0o600)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "FULL")?;
    // Unlike Postgres, SQLite leaves foreign keys off until each connection
    // asks. Without this, `ON DELETE CASCADE` would not remove tag rows.
    conn.pragma_update(None, "foreign_keys", "ON")?;
    // Overwrite deleted pages so a removed tag token does not linger in the file.
    conn.pragma_update(None, "secure_delete", "ON")?;
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    conn.execute_batch(SCHEMA)?;
    Ok(conn)
}

pub(crate) fn remember_nonce(conn: &Connection, nonce: &str, ts: u64) -> Result<(), Error> {
    let now = i64::try_from(crypto::now_secs()).unwrap_or(i64::MAX);
    // The nonce only needs to be remembered while the timestamp would still
    // be accepted. After that, the clock check rejects the replay by itself.
    let expires = i64::try_from(ts.saturating_add(crate::SKEW_SECS)).unwrap_or(i64::MAX);
    let tx = conn.unchecked_transaction()?;
    tx.execute("DELETE FROM nonces WHERE expires < ?1", [now])?;
    let inserted = tx.execute(
        "INSERT INTO nonces (nonce, expires) VALUES (?1, ?2)",
        params![nonce, expires],
    );
    match inserted {
        Ok(_) => {
            tx.commit()?;
            Ok(())
        }
        Err(rusqlite::Error::SqliteFailure(err, _))
            if err.code == rusqlite::ErrorCode::ConstraintViolation =>
        {
            Err(Error::Unauthorized)
        }
        Err(err) => Err(err.into()),
    }
}

pub(crate) fn add(state: &AppState, owner: [u8; 32], body: &[u8]) -> Result<Item, Error> {
    let parts = frame::decode_post(body)?;
    check_blob(parts.meta, MAX_META)?;
    check_blob(parts.content, MAX_CONTENT)?;
    let id = crypto::body_hash(parts.content);
    let created = i64::try_from(crypto::now_secs()).unwrap_or(i64::MAX);
    // Commit the cleanup intent before creating any file. Reserving the hash
    // also makes concurrent identical uploads conflict without filesystem locks.
    {
        let mut conn = state.lock()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let exists: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM files WHERE id = ?1)",
            [&id],
            |row| row.get(0),
        )?;
        if exists {
            return Err(Error::Conflict);
        }
        insert_staged_file(&tx, &id, created)?;
        tx.commit()?;
    }
    let bytes = parts.content.len() as i64;
    let temporary = state.data_dir.join("staging").join(&id);
    write_new(&temporary, parts.content)?;
    let mut conn = state.lock()?;
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if tx.execute("DELETE FROM staged_files WHERE id = ?1", [&id])? != 1 {
        return Err(Error::Conflict);
    }
    let path = state.blob_path(&id);
    // All publishers reserve their hash in SQLite; trusted storage directories
    // have no other writers. Never overwrite a pre-existing destination.
    match std::fs::symlink_metadata(&path) {
        Ok(_) => return Err(Error::Conflict),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => return Err(err.into()),
    }
    std::fs::rename(&temporary, &path)?;
    sync_dir(&state.data_dir.join("staging"))?;
    sync_dir(&state.data_dir.join("blobs"))?;
    insert_file(&tx, &id, &owner, parts.meta, bytes, created, &parts.tokens)?;
    // Failure leaves the committed intent to clean either filename later.
    tx.commit()?;
    Ok(Item {
        id,
        meta: parts.meta.to_vec(),
        bytes,
        created_at: created,
        tokens: parts.tokens,
    })
}

fn sync_dir(path: &Path) -> Result<(), Error> {
    #[cfg(unix)]
    std::fs::File::open(path)?.sync_all()?;
    Ok(())
}

/// `after` is `(created_at, id)` of the last row already shown. Order is
/// newest first, and equal timestamps break ties by id ascending, so the next
/// row is an older timestamp or the same timestamp with a greater id.
pub(crate) fn list(
    state: &AppState,
    owner: [u8; 32],
    tokens: &[String],
    after: Option<(i64, String)>,
) -> Result<(Vec<Item>, Option<String>), Error> {
    let conn = state.lock()?;
    // The owner filter is always present. Tag tokens, when asked for, are an
    // AND: the file must contain every token, not merely one of them.
    let mut sql = String::from("SELECT id, meta, bytes, created_at FROM files WHERE owner = ?1");
    let mut boxed: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
    boxed.push(Box::new(owner.to_vec()));
    if !tokens.is_empty() {
        let mut placeholders = Vec::new();
        for token in tokens {
            boxed.push(Box::new(token.clone()));
            placeholders.push(format!("?{}", boxed.len()));
        }
        boxed.push(Box::new(tokens.len() as i64));
        let count_slot = boxed.len();
        sql.push_str(&format!(
            " AND (SELECT COUNT(DISTINCT token) FROM tags WHERE file_id = files.id AND token IN ({})) = ?{count_slot}",
            placeholders.join(", ")
        ));
    }
    if let Some((created_at, id)) = after {
        boxed.push(Box::new(created_at));
        let older = boxed.len();
        boxed.push(Box::new(created_at));
        let same = boxed.len();
        boxed.push(Box::new(id));
        let tie = boxed.len();
        sql.push_str(&format!(
            " AND (created_at < ?{older} OR (created_at = ?{same} AND id > ?{tie}))"
        ));
    }
    sql.push_str(&format!(
        " ORDER BY created_at DESC, id ASC LIMIT {}",
        PAGE + 1
    ));
    let mut stmt = conn.prepare(&sql)?;
    let refs: Vec<&dyn rusqlite::types::ToSql> = boxed.iter().map(|value| value.as_ref()).collect();
    let rows = stmt.query_map(refs.as_slice(), |row| {
        Ok(Item {
            id: row.get(0)?,
            meta: row.get(1)?,
            bytes: row.get(2)?,
            created_at: row.get(3)?,
            tokens: Vec::new(),
        })
    })?;
    let mut items = Vec::new();
    for row in rows {
        items.push(row?);
    }
    drop(stmt);
    let more = items.len() > PAGE;
    if more {
        items.truncate(PAGE);
    }
    for item in &mut items {
        let mut tag_stmt =
            conn.prepare("SELECT token FROM tags WHERE file_id = ?1 ORDER BY token")?;
        let tags = tag_stmt.query_map([&item.id], |row| row.get::<_, String>(0))?;
        for tag in tags {
            item.tokens.push(tag?);
        }
    }
    let next = more.then(|| {
        let last = items.last().expect("a full page has a last row");
        format!("{}.{}", last.created_at, last.id)
    });
    Ok((items, next))
}

pub(crate) fn parse_cursor(text: &str) -> Result<(i64, String), Error> {
    let Some((ts, id)) = text.split_once('.') else {
        return Err(Error::BadRequest("after must be created_at.id".into()));
    };
    let created_at: i64 = ts
        .parse()
        .map_err(|_| Error::BadRequest("after must be created_at.id".into()))?;
    Ok((created_at, parse_id(id)?))
}

/// Open the authorized blob while holding the database lock used by deletion.
/// The returned handle pins this file even if its hash is deleted and reused.
pub(crate) fn open_content(
    state: &AppState,
    owner: [u8; 32],
    id: &str,
) -> Result<(std::fs::File, u64), Error> {
    let id = parse_id(id)?;
    let conn = state.lock()?;
    let bytes: i64 = conn
        .query_row(
            "SELECT bytes FROM files WHERE id = ?1 AND owner = ?2",
            params![id, owner.as_slice()],
            |row| row.get(0),
        )
        .optional()?
        .ok_or(Error::NotFound)?;
    if !(29..=MAX_CONTENT as i64).contains(&bytes) {
        return Err(std::io::Error::other("invalid stored content size").into());
    }
    let file = match std::fs::File::open(state.blob_path(&id)) {
        Ok(file) => file,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Err(Error::NotFound),
        Err(err) => return Err(err.into()),
    };
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.len() != bytes as u64 {
        return Err(std::io::Error::other("stored content length mismatch").into());
    }
    Ok((file, bytes as u64))
}

pub(crate) fn update_meta(
    state: &AppState,
    owner: [u8; 32],
    id: &str,
    body: &[u8],
) -> Result<Item, Error> {
    let id = parse_id(id)?;
    let parts = frame::decode_meta(body)?;
    check_blob(parts.meta, MAX_META)?;
    let conn = state.lock()?;
    let tx = conn.unchecked_transaction()?;
    let updated = tx.execute(
        "UPDATE files SET meta = ?1 WHERE id = ?2 AND owner = ?3",
        params![parts.meta, id, owner.as_slice()],
    )?;
    if updated == 0 {
        return Err(Error::NotFound);
    }
    replace_tokens(&tx, &id, &parts.tokens)?;
    let (bytes, created_at): (i64, i64) = tx.query_row(
        "SELECT bytes, created_at FROM files WHERE id = ?1",
        [&id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    tx.commit()?;
    Ok(Item {
        id,
        meta: parts.meta.to_vec(),
        bytes,
        created_at,
        tokens: parts.tokens,
    })
}

/// The caller holds every upload permit until this blocking sweep returns.
pub(crate) fn gc_staged_files(state: &AppState, cutoff: i64) -> Result<GcReport, Error> {
    let candidates = {
        let conn = state.lock()?;
        let mut stmt = conn.prepare("SELECT id FROM staged_files WHERE created_at < ?1")?;
        let rows = stmt.query_map([cutoff], |row| row.get::<_, String>(0))?;
        rows.collect::<Result<Vec<_>, _>>()?
    };
    let mut report = GcReport::default();
    for id in candidates {
        let result = state
            .lock()
            .and_then(|mut conn| clean_staged_file(&mut conn, &state.data_dir, &id, cutoff));
        match result {
            Ok(true) => report.removed += 1,
            Ok(false) => {}
            Err(err) => {
                report.failed += 1;
                tracing::error!(%id, %err, "GC cleanup failed; intent retained");
            }
        }
    }
    Ok(report)
}

fn clean_staged_file(
    conn: &mut Connection,
    data_dir: &Path,
    id: &str,
    cutoff: i64,
) -> Result<bool, Error> {
    let id = parse_id(id)?;
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let eligible: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM staged_files WHERE id = ?1 AND created_at < ?2)",
        params![id, cutoff],
        |row| row.get(0),
    )?;
    if !eligible {
        return Ok(false);
    }
    let live: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM files WHERE id = ?1)",
        [&id],
        |row| row.get(0),
    )?;
    if live {
        return Err(std::io::Error::other("staged hash also has a live file row").into());
    }
    for directory in ["staging", "blobs"] {
        match std::fs::remove_file(data_dir.join(directory).join(&id)) {
            Ok(()) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => return Err(err.into()),
        }
        // Persist removals before forgetting their cleanup intent.
        sync_dir(&data_dir.join(directory))?;
    }
    tx.execute("DELETE FROM staged_files WHERE id = ?1", [&id])?;
    tx.commit()?;
    Ok(true)
}

pub(crate) fn remove(state: &AppState, owner: [u8; 32], id: &str) -> Result<(), Error> {
    let id = parse_id(id)?;
    // Keep the process mutex across both transactions and unlinking so another
    // request cannot reserve this hash between cleanup and its final commit.
    let mut conn = state.lock()?;
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if tx.execute(
        "DELETE FROM files WHERE id = ?1 AND owner = ?2",
        params![id, owner.as_slice()],
    )? == 0
    {
        return Err(Error::NotFound);
    }
    insert_staged_file(
        &tx,
        &id,
        i64::try_from(crypto::now_secs()).unwrap_or(i64::MAX),
    )?;
    tx.commit()?;
    clean_staged_file(&mut conn, &state.data_dir, &id, i64::MAX)?;
    Ok(())
}

fn insert_file(
    tx: &Transaction<'_>,
    id: &str,
    owner: &[u8; 32],
    meta: &[u8],
    bytes: i64,
    created: i64,
    tokens: &[String],
) -> Result<(), Error> {
    tx.execute(
        "INSERT INTO files (id, owner, meta, bytes, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![id, owner.as_slice(), meta, bytes, created],
    )?;
    replace_tokens(tx, id, tokens)?;
    Ok(())
}

fn insert_staged_file(tx: &Transaction<'_>, id: &str, created: i64) -> Result<(), Error> {
    let inserted = tx.execute(
        "INSERT INTO staged_files (id, created_at) VALUES (?1, ?2) ON CONFLICT (id) DO NOTHING",
        params![id, created],
    )?;
    if inserted != 1 {
        return Err(Error::Conflict);
    }
    Ok(())
}

fn replace_tokens(tx: &Transaction<'_>, id: &str, tokens: &[String]) -> Result<(), Error> {
    tx.execute("DELETE FROM tags WHERE file_id = ?1", [id])?;
    for token in tokens {
        tx.execute(
            "INSERT INTO tags (file_id, token) VALUES (?1, ?2)",
            params![id, token],
        )?;
    }
    Ok(())
}

/// Canonical SHA-256 of the complete sealed content.
fn parse_id(id: &str) -> Result<String, Error> {
    if id.len() != 64 || !id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
        return Err(Error::BadRequest(
            "id must be a lowercase SHA-256 hash".into(),
        ));
    }
    Ok(id.to_string())
}

fn check_blob(bytes: &[u8], max: usize) -> Result<(), Error> {
    if crypto::looks_sealed(bytes, max) {
        Ok(())
    } else {
        Err(Error::BadRequest(
            "encrypted blob required (version byte, not a raw file)".into(),
        ))
    }
}

fn ensure_dir(path: &Path, mode: u32) -> Result<(), Error> {
    std::fs::create_dir_all(path)?;
    set_mode(path, mode)
}

fn set_mode(path: &Path, mode: u32) -> Result<(), Error> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))?;
    }
    #[cfg(not(unix))]
    {
        let _ = (path, mode);
    }
    Ok(())
}

fn write_new(path: &Path, bytes: &[u8]) -> Result<(), Error> {
    write_new_with(path, |file| file.write_all(bytes))
}

fn write_new_with(
    path: &Path,
    write: impl FnOnce(&mut std::fs::File) -> std::io::Result<()>,
) -> Result<(), Error> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    write(&mut file)?;
    file.sync_all()?;
    sync_dir(path.parent().expect("file parent"))?;
    Ok(())
}

#[cfg(test)]
mod journal_tests {
    use super::*;
    struct Fixture(AppState, PathBuf);
    impl Fixture {
        fn new() -> Self {
            let dir =
                std::env::temp_dir().join(format!("i2nclip-journal-{}", crypto::fresh_nonce()));
            prepare(&dir).unwrap();
            Self(
                AppState::new(
                    dir.clone(),
                    open(&dir).unwrap(),
                    "http://i2nclip.test".into(),
                ),
                dir,
            )
        }
        fn intent(&self, id: &str, created: i64) {
            self.0
                .lock()
                .unwrap()
                .execute(
                    "INSERT INTO staged_files VALUES (?1, ?2)",
                    params![id, created],
                )
                .unwrap();
        }
        fn count(&self, table: &str) -> i64 {
            self.0
                .lock()
                .unwrap()
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
                .unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.1);
        }
    }
    fn body() -> (String, Vec<u8>) {
        let content = crypto::encrypt(&[7; 32], &crypto::content_aad(), b"content").unwrap();
        let id = crypto::body_hash(&content);
        let meta = crypto::encrypt(&[7; 32], &crypto::meta_aad(&id), b"{}").unwrap();
        (id, frame::encode_post(&meta, &content, ""))
    }
    #[test]
    fn successful_publication_conflict_and_journaled_deletion() {
        let f = Fixture::new();
        let (id, body) = body();
        add(&f.0, [7; 32], &body).unwrap();
        assert_eq!(f.count("staged_files"), 0);
        assert_eq!(std::fs::read_dir(f.1.join("staging")).unwrap().count(), 0);
        assert!(!f.1.join("locks").exists());
        assert!(matches!(add(&f.0, [8; 32], &body), Err(Error::Conflict)));
        let (mut file, _) = open_content(&f.0, [7; 32], &id).unwrap();
        remove(&f.0, [7; 32], &id).unwrap();
        assert_eq!(f.count("files"), 0);
        assert_eq!(f.count("staged_files"), 0);
        assert!(!f.1.join("blobs").join(id).exists());
        use std::io::Read;
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes).unwrap();
        assert!(!bytes.is_empty());
    }
    #[test]
    fn failed_publication_commit_preserves_cleanup_intent() {
        let f = Fixture::new();
        let (id, body) = body();
        f.0.lock().unwrap().execute_batch("CREATE TABLE guard_keys (id INTEGER PRIMARY KEY);
        CREATE TABLE commit_guard (id INTEGER REFERENCES guard_keys(id) DEFERRABLE INITIALLY DEFERRED);
        CREATE TRIGGER fail_commit AFTER INSERT ON files BEGIN INSERT INTO commit_guard VALUES (1); END;").unwrap();
        assert!(add(&f.0, [7; 32], &body).is_err());
        assert_eq!(f.count("files"), 0);
        assert_eq!(f.count("staged_files"), 1);
        assert!(f.1.join("blobs").join(&id).exists());
        assert!(matches!(add(&f.0, [7; 32], &body), Err(Error::Conflict)));
        assert_eq!(gc_staged_files(&f.0, i64::MAX).unwrap().removed, 1);
        assert!(!f.1.join("blobs").join(&id).exists());
        f.0.lock()
            .unwrap()
            .execute_batch("DROP TRIGGER fail_commit")
            .unwrap();
        add(&f.0, [7; 32], &body).unwrap();
    }
    #[test]
    fn gc_handles_every_interrupted_upload_state_and_keeps_fresh_intents() {
        let f = Fixture::new();
        for (index, dirs) in [
            vec![],
            vec!["staging"],
            vec!["blobs"],
            vec!["staging", "blobs"],
        ]
        .into_iter()
        .enumerate()
        {
            let id = format!("{index:064x}");
            f.intent(&id, 1);
            for dir in dirs {
                std::fs::write(f.1.join(dir).join(&id), b"partial").unwrap();
            }
        }
        let fresh = "f".repeat(64);
        f.intent(&fresh, 10);
        assert_eq!(gc_staged_files(&f.0, 10).unwrap().removed, 4);
        assert_eq!(f.count("staged_files"), 1);
        assert_eq!(std::fs::read_dir(f.1.join("blobs")).unwrap().count(), 0);
        assert_eq!(std::fs::read_dir(f.1.join("staging")).unwrap().count(), 0);
    }
    #[test]
    fn cleanup_errors_retain_intents_and_do_not_stop_other_candidates() {
        let f = Fixture::new();
        let bad = "a".repeat(64);
        let good = "b".repeat(64);
        f.intent(&bad, 1);
        f.intent(&good, 1);
        std::fs::create_dir(f.1.join("staging").join(&bad)).unwrap();
        let report = gc_staged_files(&f.0, 2).unwrap();
        assert_eq!(report.failed, 1);
        assert_eq!(report.removed, 1);
        assert_eq!(f.count("staged_files"), 1);
        std::fs::remove_dir(f.1.join("staging").join(&bad)).unwrap();
        assert_eq!(gc_staged_files(&f.0, 2).unwrap().removed, 1);
    }
    #[test]
    fn failed_cleanup_commit_is_retryable_after_unlink() {
        let f = Fixture::new();
        let id = "a".repeat(64);
        f.intent(&id, 1);
        std::fs::write(f.1.join("blobs").join(&id), b"abandoned").unwrap();
        f.0.lock().unwrap().execute_batch("CREATE TABLE guard_keys(id INTEGER PRIMARY KEY);
        CREATE TABLE commit_guard(id INTEGER REFERENCES guard_keys(id) DEFERRABLE INITIALLY DEFERRED);
        CREATE TRIGGER fail_cleanup AFTER DELETE ON staged_files BEGIN INSERT INTO commit_guard VALUES(1); END;").unwrap();
        assert_eq!(gc_staged_files(&f.0, 2).unwrap().failed, 1);
        assert_eq!(f.count("staged_files"), 1);
        assert!(!f.1.join("blobs").join(&id).exists());
        f.0.lock()
            .unwrap()
            .execute_batch("DROP TRIGGER fail_cleanup")
            .unwrap();
        assert_eq!(gc_staged_files(&f.0, 2).unwrap().removed, 1);
    }
    #[test]
    fn partial_write_and_interrupted_delete_stay_tracked() {
        let f = Fixture::new();
        let partial = "c".repeat(64);
        f.intent(&partial, 1);
        let path = f.1.join("staging").join(&partial);
        assert!(write_new_with(&path, |file| {
            file.write_all(b"partial")?;
            Err(std::io::Error::other("injected write failure"))
        })
        .is_err());
        assert!(path.exists());
        let (id, body) = body();
        add(&f.0, [7; 32], &body).unwrap();
        {
            let mut conn = f.0.lock().unwrap();
            let tx = conn
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .unwrap();
            tx.execute("DELETE FROM files WHERE id = ?1", [&id])
                .unwrap();
            insert_staged_file(&tx, &id, 1).unwrap();
            tx.commit().unwrap();
        }
        assert!(f.1.join("blobs").join(&id).exists());
        assert_eq!(gc_staged_files(&f.0, 2).unwrap().removed, 2);
        assert!(!path.exists());
        assert!(!f.1.join("blobs").join(&id).exists());
        assert_eq!(f.count("staged_files"), 0);
    }

    #[test]
    fn stale_gc_candidate_cannot_delete_a_live_blob() {
        let f = Fixture::new();
        let (id, body) = body();
        add(&f.0, [7; 32], &body).unwrap();
        assert!(!clean_staged_file(&mut f.0.lock().unwrap(), &f.1, &id, i64::MAX).unwrap());
        assert!(f.1.join("blobs").join(&id).exists());
        f.intent(&id, 1);
        assert_eq!(gc_staged_files(&f.0, 2).unwrap().failed, 1);
        assert!(f.1.join("blobs").join(&id).exists());
    }
}
