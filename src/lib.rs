//! Encrypted media store.
//!
//! Clients encrypt bytes and metadata before upload. This process checks
//! Ed25519 signatures against public keys in PostgreSQL and stores ciphertext plus
//! HMAC tag tokens. It does not have the private key, so it cannot decrypt.

#![forbid(unsafe_code)]

mod auth;
mod db;
mod error;
mod frame;
mod maintenance;
mod media;
#[cfg(test)]
mod reference_crypto;
mod routes;

pub mod crypto;

use std::sync::Arc;

use db::Database;
use tokio::net::TcpListener;

pub use db::DEFAULT_REGISTRATION_TTL_SECS;
pub use error::Error;

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
pub(crate) const MAX_BODY: usize = 4 + MAX_META + 4 + MAX_CONTENT + 4 + MAX_TOKEN_TEXT;
pub(crate) const MAX_META_BODY: usize = 4 + MAX_META + 4 + MAX_TOKEN_TEXT;
/// `POST /api/register-key` accepts a small JSON object only.
pub(crate) const MAX_REGISTER_BODY: usize = 4096;
pub(crate) const SKEW_SECS: u64 = 300;

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

/// Issue a code against an already initialized database.
pub async fn issue_registration_otc(database_url: &str, ttl_secs: u64) -> Result<String, Error> {
    let db = db::Database::connect(database_url).await?;
    let result = db.issue_code(ttl_secs).await;
    db.close().await;
    result
}

/// Build the HTTP router after connecting and initializing the database.
pub async fn router(database_url: &str, origin: &str) -> Result<axum::Router, Error> {
    let state = open_state(database_url, normalize_origin(origin)?).await?;
    Ok(routes::router(state))
}

async fn open_state(database_url: &str, origin: String) -> Result<AppState, Error> {
    let db = db::Database::connect(database_url).await?;
    db.initialize().await?;
    Ok(AppState::new(db, origin))
}

/// Read the required connection setting without including credentials in errors.
pub fn database_url_from_env() -> Result<String, Error> {
    std::env::var("I2N_DATABASE_URL")
        .map_err(|_| Error::Config("set I2N_DATABASE_URL to a PostgreSQL connection URL".into()))
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

fn origin_from_env() -> Result<String, Error> {
    let raw = std::env::var("I2N_ORIGIN").map_err(|_| {
        Error::Config(
            "set I2N_ORIGIN to the public origin, such as https://clip.example.com".into(),
        )
    })?;
    normalize_origin(&raw)
}

/// Serve until Ctrl-C or SIGTERM, then drain work and close PostgreSQL.
pub async fn run() -> Result<(), Error> {
    init_tracing();
    let origin = origin_from_env()?;
    let state = open_state(&database_url_from_env()?, origin).await?;
    let app = routes::router(state.clone());
    let listener = TcpListener::bind(LISTEN).await?;
    tracing::info!(listen = LISTEN, origin = state.origin(), "listening");
    let (stop, receiver) = tokio::sync::watch::channel(false);
    let stop_shutdown = stop.clone();
    let maintenance = tokio::spawn(maintenance::run(state.db.clone(), receiver));
    let served = axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            shutdown_signal().await;
            let _ = stop_shutdown.send(true);
        })
        .await;
    // Also stop maintenance if serving exits with an error.
    let _ = stop.send(true);
    if let Err(err) = maintenance.await {
        tracing::error!(%err, "maintenance task failed");
    }
    state.db.close().await;
    served?;
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
