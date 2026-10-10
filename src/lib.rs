//! Encrypted media store.
//!
//! Clients encrypt bytes and metadata before upload. This process checks
//! Ed25519 signatures against public keys in SQLite and stores ciphertext plus
//! HMAC tag tokens. It does not have the private key, so it cannot decrypt.

#![forbid(unsafe_code)]

mod auth;
mod error;
pub mod frame;
mod media;
mod routes;
mod store;

pub mod crypto;

use std::path::Path;
use std::path::PathBuf;

use tokio::net::TcpListener;

pub use error::Error;
pub use store::gc_orphan_blobs;
pub use store::GcBlobsReport;
pub use store::DEFAULT_REGISTRATION_TTL_SECS;
pub use store::GC_BLOB_MIN_AGE;

/// Persistent state. One volume mount covers the database (including public keys) and blobs.
pub const DATA_DIR: &str = "/var/lib/i2nclip";

/// Fixed listen address. Publish a host port onto 8080 instead of configuring this.
pub const LISTEN: &str = "0.0.0.0:8080";

pub(crate) const MAX_PLAIN: usize = 32 * 1024 * 1024;
pub(crate) const MAX_CONTENT: usize = MAX_PLAIN + 64;
pub(crate) const MAX_META: usize = 64 * 1024;
pub(crate) const MAX_TAGS: usize = 32;
/// Bound on newline-separated search-token text, including ignored empty lines.
pub(crate) const MAX_TOKEN_TEXT: usize = 4096;
/// One page of the library list. The next page starts after the last row.
pub(crate) const PAGE: usize = 24;
pub(crate) const MAX_BODY: usize = 4 + 36 + 4 + MAX_META + 4 + MAX_CONTENT + 4 + MAX_TOKEN_TEXT;
pub(crate) const MAX_META_BODY: usize = 4 + MAX_META + 4 + MAX_TOKEN_TEXT;
/// `POST /api/register-key` accepts a small JSON object only.
pub(crate) const MAX_REGISTER_BODY: usize = 4096;
pub(crate) const SKEW_SECS: u64 = 300;

/// Create a one-time registration code in `data_dir` and return the plaintext (once).
pub fn issue_registration_otc(data_dir: &Path, ttl_secs: u64) -> Result<String, Error> {
    store::prepare(data_dir)?;
    let mut conn = store::open(data_dir)?;
    store::issue_registration_code(&mut conn, ttl_secs)
}

/// Router over `data_dir`. `origin` is the public scheme and host signatures
/// must name. Tests pass both. The binary reads `I2N_ORIGIN`.
pub fn router(data_dir: &Path, origin: &str) -> Result<axum::Router, Error> {
    routes::router(data_dir, normalize_origin(origin)?)
}

/// An HTTP(S) origin with an optional root slash, serialized like the browser's
/// `new URL(serverUrl).origin`. Reject credentials and non-origin components.
pub fn normalize_origin(raw: &str) -> Result<String, Error> {
    let invalid = || {
        Error::Config(
            "I2N_ORIGIN must be an HTTP(S) origin without credentials, path, query, or fragment"
                .into(),
        )
    };
    let raw = raw.trim();
    // URL parsers repair slashes, remove controls, and collapse dot segments.
    // Configuration must be an explicit origin, not a repaired full URL.
    let (_, authority) = raw.split_once("://").ok_or_else(invalid)?;
    if raw.contains('\\')
        || raw.chars().any(char::is_whitespace)
        || raw.chars().any(char::is_control)
        || authority.contains('@')
        || authority
            .split_once('/')
            .is_some_and(|(_, path)| !path.is_empty())
    {
        return Err(invalid());
    }
    let url = url::Url::parse(raw).map_err(|_| invalid())?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.has_host()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(invalid());
    }
    Ok(url.origin().ascii_serialization())
}

#[cfg(test)]
mod origin_tests {
    use super::*;

    #[test]
    fn origins_match_browser_vectors_and_reject_non_origins() {
        let vectors: serde_json::Value =
            serde_json::from_str(include_str!("../client/tests/origin-vectors.json")).unwrap();
        for case in vectors["accepted"].as_array().unwrap() {
            let input = case["input"].as_str().unwrap();
            assert_eq!(
                normalize_origin(input).unwrap(),
                case["origin"].as_str().unwrap(),
                "{input}"
            );
        }
        for case in vectors["rejected"].as_array().unwrap() {
            let input = case.as_str().unwrap();
            assert!(
                matches!(normalize_origin(input), Err(Error::Config(_))),
                "{input}"
            );
        }
    }
}

fn origin_from_env() -> Result<String, Error> {
    let raw = std::env::var("I2N_ORIGIN").map_err(|_| {
        Error::Config(
            "set I2N_ORIGIN to the public origin, such as https://clip.example.com".into(),
        )
    })?;
    normalize_origin(&raw)
}

/// Serve `/var/lib/i2nclip` on [`LISTEN`] until Ctrl-C or SIGTERM.
pub async fn run() -> Result<(), Error> {
    init_tracing();
    let origin = origin_from_env()?;
    let data_dir = PathBuf::from(DATA_DIR);
    let app = router(&data_dir, &origin)?;
    let listener = TcpListener::bind(LISTEN).await?;
    tracing::info!(listen = LISTEN, data = DATA_DIR, %origin, "listening");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

fn init_tracing() {
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| "i2nclip=info,tower_http=info".into());
    tracing_subscriber::fmt().with_env_filter(filter).init();
}

async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c().await.ok();
    };
    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut signal) => {
                signal.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {}
        _ = terminate => {}
    }
    tracing::info!("shutting down");
}
