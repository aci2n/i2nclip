use thiserror::Error;

// `enum` is a closed set of variants, closer to a Java sealed interface than to
// a C enum. Each variant can carry its own data. `Error` here is the single
// failure type for the whole program, like one checked exception hierarchy.
//
// `#[derive(Debug, Error)]` generates the debug printer and the standard
// `std::error::Error` trait (Rust's equivalent of a base exception type).
// `#[error("...")]` is the message returned by `to_string()`, like getMessage().
// `#[from]` lets `?` convert that inner error into this one automatically,
// the way a catch block might wrap a SQLException in your own exception.

/// Failures that stop a request or startup.
///
/// Handlers turn these into HTTP status codes. The text is for logs.
/// Clients only see a short message, never a stack trace or a key.
#[derive(Debug, Error)]
pub enum Error {
    /// Startup setting is missing or not an origin (`https://host`).
    #[error("config: {0}")]
    Config(String),
    #[error("unauthorized")]
    Unauthorized,
    /// Invalid, expired, or already used one-time registration code.
    #[error("registration failed")]
    RegistrationFailed,
    #[error("not found")]
    NotFound,
    #[error("already exists")]
    Conflict,
    /// 400. The String is a safe explanation, not an echo of the request body.
    #[error("{0}")]
    BadRequest(String),
    /// `Mutex` was poisoned: a thread panicked while holding the database lock.
    #[error("database lock poisoned")]
    Poisoned,
    /// Encrypt or decrypt failed. Almost always a wrong key, wrong associated
    /// data, or a truncated blob. Details are intentionally not included.
    #[error("crypto")]
    Crypto,
    #[error(transparent)]
    Db(#[from] rusqlite::Error),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}
