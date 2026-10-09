//! SQLite index plus one directory of ciphertext blobs.
//!
//! ```text
//! /var/lib/i2nclip/i2nclip.db
//! /var/lib/i2nclip/blobs/<uuid>
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
//! Every read and write includes `owner = ?`, so knowing a UUID is not enough
//! to fetch someone else's file.

use std::collections::HashSet;
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
use uuid::Uuid;

use crate::crypto;
use crate::frame;
use crate::Error;
use crate::MAX_CONTENT;
use crate::MAX_META;
use crate::PAGE;

const SCHEMA: &str = include_str!("../sql/001_init.sql");

/// One stored object, still encrypted. `meta` is the ciphertext blob.
#[derive(Debug)]
pub(crate) struct Item {
    pub id: String,
    pub meta: Vec<u8>,
    pub bytes: i64,
    pub created_at: i64,
    pub tokens: Vec<String>,
}

/// Default for [`gc_orphan_blobs`]: skip orphan blobs newer than this (upload
/// writes the file before the row exists).
pub const GC_BLOB_MIN_AGE: std::time::Duration = std::time::Duration::from_secs(3600);

/// Default lifetime for [`issue_registration_code`].
pub const DEFAULT_REGISTRATION_TTL_SECS: u64 = 86400;

/// Result of [`gc_orphan_blobs`]. `removed` lists lowercase ids. `ignored` counts
/// directory entries that are not a regular file named like a stored id.
/// `retained_young` counts uuid orphans left because their mtime is within `min_age`.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct GcBlobsReport {
    pub removed: Vec<String>,
    pub ignored: usize,
    pub retained_young: usize,
}

/// Shared state for the process. `Clone` is cheap: it clones the `Arc`
/// pointers, not the database. `Arc` is an atomic reference count, like
/// `shared_ptr` in C++ or a shared immutable handle. `Mutex` is the lock
/// around the single SQLite connection (SQLite allows one writer).
#[derive(Clone)]
pub(crate) struct AppState {
    data_dir: Arc<PathBuf>,
    db: Arc<Mutex<Connection>>,
    /// Public origin the signatures must name, such as `https://clip.example.com`.
    origin: String,
}

impl AppState {
    pub(crate) fn new(data_dir: PathBuf, conn: Connection, origin: String) -> Self {
        Self {
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
        // `id` has already been checked to be a UUID with no slashes, so this
        // join cannot escape `blobs/`.
        self.data_dir.join("blobs").join(id)
    }
}

/// Create the data and blob directories the first time. Modes are octal, the
/// same numbers `chmod` takes. `0o700` is owner-only on a directory.
pub(crate) fn prepare(data_dir: &Path) -> Result<(), Error> {
    ensure_dir(data_dir, 0o700)?;
    ensure_dir(&data_dir.join("blobs"), 0o700)?;
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
    // GC opens a second connection for a full-table read; WAL lets that overlap writes.
    conn.pragma_update(None, "journal_mode", "WAL")?;
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
    let id = parse_id(&parts.id)?;
    check_blob(&parts.meta, MAX_META)?;
    check_blob(&parts.content, MAX_CONTENT)?;
    {
        let conn = state.lock()?;
        if row_exists(&conn, &id)? {
            return Err(Error::Conflict);
        }
    }
    let path = state.blob_path(&id);
    // Write the ciphertext first. If we crash before the INSERT, the blob is
    // an orphan and is not listed. The other order would list a file that has
    // no bytes.
    if let Err(err) = write_new(&path, &parts.content) {
        if err.to_string().contains("File exists") || matches_already_exists(&err) {
            return Err(Error::Conflict);
        }
        return Err(err);
    }
    let created = i64::try_from(crypto::now_secs()).unwrap_or(i64::MAX);
    let bytes = i64::try_from(parts.content.len()).unwrap_or(i64::MAX);
    let conn = state.lock()?;
    let result = insert_file(
        &conn,
        &id,
        &owner,
        &parts.meta,
        bytes,
        created,
        &parts.tokens,
    );
    if let Err(err) = result {
        let _ = std::fs::remove_file(&path);
        return Err(err);
    }
    Ok(Item {
        id,
        meta: parts.meta,
        bytes,
        created_at: created,
        tokens: parts.tokens,
    })
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

pub(crate) fn read_content(state: &AppState, owner: [u8; 32], id: &str) -> Result<Vec<u8>, Error> {
    let id = parse_id(id)?;
    {
        let conn = state.lock()?;
        if !owned(&conn, &id, &owner)? {
            return Err(Error::NotFound);
        }
    }
    match std::fs::read(state.blob_path(&id)) {
        Ok(bytes) => Ok(bytes),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Err(Error::NotFound),
        Err(err) => Err(err.into()),
    }
}

pub(crate) fn update_meta(
    state: &AppState,
    owner: [u8; 32],
    id: &str,
    body: &[u8],
) -> Result<Item, Error> {
    let id = parse_id(id)?;
    let parts = frame::decode_meta(body)?;
    check_blob(&parts.meta, MAX_META)?;
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
        meta: parts.meta,
        bytes,
        created_at,
        tokens: parts.tokens,
    })
}

/// Delete files under `blobs/` whose names are valid ids with no `files` row.
/// Upload writes the blob before the INSERT; a crash in between leaves orphans.
/// Orphans whose modification time is newer than `min_age` are skipped so a slow
/// upload cannot lose its blob to a concurrent GC. Names that are not a lowercase
/// uuid are left alone. With `dry_run`, nothing is deleted but `removed` still
/// lists what would go.
pub fn gc_orphan_blobs(
    data_dir: &Path,
    dry_run: bool,
    min_age: std::time::Duration,
) -> Result<GcBlobsReport, Error> {
    let conn = open(data_dir)?;
    let mut ids = HashSet::new();
    let mut stmt = conn.prepare("SELECT id FROM files")?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
    for row in rows {
        ids.insert(row?);
    }
    drop(stmt);
    drop(conn);

    let blobs = data_dir.join("blobs");
    let read = match std::fs::read_dir(&blobs) {
        Ok(read) => read,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return Ok(GcBlobsReport::default())
        }
        Err(err) => return Err(err.into()),
    };

    let mut report = GcBlobsReport::default();
    for entry in read {
        let entry = entry?;
        let file_type = entry.file_type()?;
        if !file_type.is_file() {
            report.ignored += 1;
            continue;
        }
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            report.ignored += 1;
            continue;
        };
        let Ok(id) = parse_id(name) else {
            report.ignored += 1;
            continue;
        };
        if ids.contains(&id) {
            continue;
        }
        let meta = entry.metadata()?;
        let modified = match meta.modified() {
            Ok(t) => t,
            Err(_) => {
                report.retained_young += 1;
                continue;
            }
        };
        let Ok(age) = std::time::SystemTime::now().duration_since(modified) else {
            report.retained_young += 1;
            continue;
        };
        if age < min_age {
            report.retained_young += 1;
            continue;
        }
        if !dry_run {
            std::fs::remove_file(entry.path())?;
        }
        report.removed.push(id);
    }
    report.removed.sort();
    Ok(report)
}

pub(crate) fn remove(state: &AppState, owner: [u8; 32], id: &str) -> Result<(), Error> {
    let id = parse_id(id)?;
    let path = state.blob_path(&id);
    {
        let conn = state.lock()?;
        let deleted = conn.execute(
            "DELETE FROM files WHERE id = ?1 AND owner = ?2",
            params![id, owner.as_slice()],
        )?;
        if deleted == 0 {
            return Err(Error::NotFound);
        }
    }
    // The row is already gone, so a missing blob is not a failed delete.
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err.into()),
    }
}

fn insert_file(
    conn: &Connection,
    id: &str,
    owner: &[u8; 32],
    meta: &[u8],
    bytes: i64,
    created: i64,
    tokens: &[String],
) -> Result<(), Error> {
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "INSERT INTO files (id, owner, meta, bytes, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![id, owner.as_slice(), meta, bytes, created],
    )?;
    replace_tokens(&tx, id, tokens)?;
    tx.commit()?;
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

fn owned(conn: &Connection, id: &str, owner: &[u8; 32]) -> Result<bool, Error> {
    let found = conn
        .query_row(
            "SELECT 1 FROM files WHERE id = ?1 AND owner = ?2",
            params![id, owner.as_slice()],
            |_| Ok(()),
        )
        .optional()?;
    Ok(found.is_some())
}

fn row_exists(conn: &Connection, id: &str) -> Result<bool, Error> {
    let found = conn
        .query_row("SELECT 1 FROM files WHERE id = ?1", [id], |_| Ok(()))
        .optional()?;
    Ok(found.is_some())
}

/// `Uuid::parse_str` accepts uppercase hex. We refuse it. The exact string is
/// mixed into the AES-GCM associated data, so rewriting the id would make the
/// owner's own file fail to decrypt.
fn parse_id(id: &str) -> Result<String, Error> {
    let Ok(uuid) = Uuid::parse_str(id) else {
        return Err(Error::BadRequest("id must be a uuid".into()));
    };
    let canonical = uuid.as_hyphenated().to_string();
    if canonical != id {
        return Err(Error::BadRequest(
            "id must be a lowercase uuid, the same string used when encrypting".into(),
        ));
    }
    Ok(canonical)
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

fn matches_already_exists(err: &Error) -> bool {
    match err {
        Error::Io(err) => err.kind() == std::io::ErrorKind::AlreadyExists,
        _ => false,
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
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(bytes)?;
    Ok(())
}

#[cfg(test)]
mod gc_tests {
    use super::*;
    use std::fs;

    #[test]
    fn gc_removes_orphans_and_keeps_indexed_blobs() {
        let dir = std::env::temp_dir().join(format!(
            "i2nclip-gc-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        prepare(&dir).unwrap();
        let conn = open(&dir).unwrap();
        let kept = "11111111-1111-4111-8111-111111111111";
        let orphan = "22222222-2222-4222-8222-222222222222";
        insert_file(
            &conn,
            kept,
            &[7u8; 32],
            b"\x01\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00",
            16,
            1,
            &[],
        )
        .unwrap();
        drop(conn);
        fs::write(dir.join("blobs").join(kept), b"kept").unwrap();
        fs::write(dir.join("blobs").join(orphan), b"orphan").unwrap();
        fs::write(dir.join("blobs").join("not-a-uuid"), b"x").unwrap();

        let no_min = std::time::Duration::ZERO;
        let dry = gc_orphan_blobs(&dir, true, no_min).unwrap();
        assert_eq!(dry.removed, vec![orphan.to_string()]);
        assert!(dir.join("blobs").join(orphan).exists());

        let live = gc_orphan_blobs(&dir, false, no_min).unwrap();
        assert_eq!(live.removed, vec![orphan.to_string()]);
        assert!(!dir.join("blobs").join(orphan).exists());
        assert!(dir.join("blobs").join(kept).exists());
        assert_eq!(live.ignored, 1);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn gc_skips_young_orphans() {
        let dir = std::env::temp_dir().join(format!(
            "i2nclip-gc-young-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        prepare(&dir).unwrap();
        let orphan = "33333333-3333-4333-8333-333333333333";
        fs::write(dir.join("blobs").join(orphan), b"orphan").unwrap();

        let report = gc_orphan_blobs(&dir, false, GC_BLOB_MIN_AGE).unwrap();
        assert!(report.removed.is_empty());
        assert_eq!(report.retained_young, 1);
        assert!(dir.join("blobs").join(orphan).exists());

        let _ = fs::remove_dir_all(&dir);
    }
}
