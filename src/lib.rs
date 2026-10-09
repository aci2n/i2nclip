//! Encrypted media store.
//!
//! Clients encrypt bytes and metadata before upload. This process checks
//! Ed25519 signatures against public keys in SQLite and stores ciphertext plus
//! HMAC tag tokens. It does not have the private key, so it cannot decrypt.

#![forbid(unsafe_code)]

mod auth;
mod error;
pub mod frame;
mod routes;
mod store;

pub mod crypto;

use std::path::Path;
use std::path::PathBuf;

use tokio::net::TcpListener;

pub use error::Error;
pub use store::gc_orphan_blobs;
pub use store::GcBlobsReport;
pub use store::GC_BLOB_MIN_AGE;
pub use store::DEFAULT_REGISTRATION_TTL_SECS;

/// Persistent state. One volume mount covers the database (including public keys) and blobs.
pub const DATA_DIR: &str = "/var/lib/i2nclip";

/// Fixed listen address. Publish a host port onto 8080 instead of configuring this.
pub const LISTEN: &str = "0.0.0.0:8080";

pub(crate) const MAX_PLAIN: usize = 32 * 1024 * 1024;
pub(crate) const MAX_CONTENT: usize = MAX_PLAIN + 64;
pub(crate) const MAX_META: usize = 64 * 1024;
pub(crate) const MAX_TAGS: usize = 32;
/// One page of the library list. The next page starts after the last row.
pub(crate) const PAGE: usize = 24;
pub(crate) const MAX_BODY: usize = 4 + 36 + 4 + MAX_META + 4 + MAX_CONTENT + 4 + 4096;
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

/// `https://host` or `http://host`, no path. A default port (`:443`, `:80`) is removed
/// so this matches `new URL(serverUrl).origin` in the extension.
pub fn normalize_origin(raw: &str) -> Result<String, Error> {
    let trimmed = raw.trim().trim_end_matches('/');
    let (scheme, rest) = if let Some(rest) = trimmed.strip_prefix("https://") {
        ("https", rest)
    } else if let Some(rest) = trimmed.strip_prefix("http://") {
        ("http", rest)
    } else {
        return Err(Error::Config(
            "I2N_ORIGIN must start with https:// or http://".into(),
        ));
    };
    if rest.is_empty() || rest.contains(['/', '?', '#', ' ']) {
        return Err(Error::Config(
            "I2N_ORIGIN must be scheme and host only, such as https://clip.example.com".into(),
        ));
    }
    let host = match (scheme, rest.rsplit_once(':')) {
        ("https", Some((host, "443"))) => host,
        ("http", Some((host, "80"))) => host,
        _ => rest,
    };
    if host.is_empty() {
        return Err(Error::Config("I2N_ORIGIN is missing a host".into()));
    }
    Ok(format!("{scheme}://{host}"))
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
