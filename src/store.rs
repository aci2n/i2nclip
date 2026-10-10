//! Shared application state and protocol validation.

use std::sync::Arc;

use crate::crypto;
use crate::db::Database;
use crate::Error;

pub(crate) const UPLOAD_SLOTS: usize = 2;
const DOWNLOAD_SLOTS: usize = 2;

/// Clones share the database pool, transfer permits, and public origin.
#[derive(Clone)]
pub(crate) struct AppState {
    pub(crate) db: Database,
    pub(crate) upload_slots: Arc<tokio::sync::Semaphore>,
    pub(crate) download_slots: Arc<tokio::sync::Semaphore>,
    /// Public origin named in request signatures, such as `https://clip.example.com`.
    origin: Arc<str>,
}

impl AppState {
    pub(crate) fn new(db: Database, origin: String) -> Self {
        Self {
            db,
            origin: origin.into(),
            upload_slots: Arc::new(tokio::sync::Semaphore::new(UPLOAD_SLOTS)),
            download_slots: Arc::new(tokio::sync::Semaphore::new(DOWNLOAD_SLOTS)),
        }
    }

    pub(crate) fn origin(&self) -> &str {
        &self.origin
    }
}

/// Decode the submitted page cursor and validate its content identifier.
pub(crate) fn parse_cursor(text: &str) -> Result<(i64, String), Error> {
    let Some((ts, id)) = text.split_once('.') else {
        return Err(Error::BadRequest("after must be created_at.id".into()));
    };
    let created_at: i64 = ts
        .parse()
        .map_err(|_| Error::BadRequest("after must be created_at.id".into()))?;
    Ok((created_at, parse_id(id)?))
}

/// Canonical SHA-256 of the complete sealed content.
pub(crate) fn parse_id(id: &str) -> Result<String, Error> {
    if id.len() != 64 || !id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
        return Err(Error::BadRequest(
            "id must be a lowercase SHA-256 hash".into(),
        ));
    }
    Ok(id.to_string())
}

pub(crate) fn check_blob(bytes: &[u8], max: usize) -> Result<(), Error> {
    if crypto::looks_sealed(bytes, max) {
        Ok(())
    } else {
        Err(Error::BadRequest(
            "encrypted blob required (version byte, not a raw file)".into(),
        ))
    }
}
