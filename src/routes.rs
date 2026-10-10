//! HTTP handlers.
//!
//! Axum is a small web framework. A route is a path plus a function, like a
//! servlet mapped to a URL. `State` is the shared database handle. `Authed`
//! is our own extractor: before the handler runs, it checks the signature,
//! then reads the body, then checks that those bytes match the signed hash.
//! That is the same job as a servlet filter.
//!
//! Nothing in this file decrypts. Bodies are ciphertext the client already
//! sealed with the library identity.

use std::path::Path;
use std::time::Duration;

use axum::body::Body;
use axum::extract::FromRequest;
use axum::extract::Path as UrlPath;
use axum::extract::Request;
use axum::extract::State;
use axum::http::header;
use axum::http::HeaderValue;
use axum::http::Method;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::response::Response;
use axum::routing::get;
use axum::routing::post;
use axum::Json;
use axum::Router;
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use http_body_util::BodyExt;
use serde::Deserialize;
use serde::Serialize;
use serde_json::json;

use crate::auth;
use crate::frame;
use crate::store;
use crate::store::AppState;
use crate::store::Item;
use crate::Error;
use crate::MAX_BODY;
use crate::MAX_REGISTER_BODY;

const SHORT_BODY_DEADLINE: Duration = Duration::from_secs(10);
const META_BODY_DEADLINE: Duration = Duration::from_secs(30);
const UPLOAD_BODY_DEADLINE: Duration = Duration::from_secs(120);

fn media_body_deadline(method: &Method) -> Duration {
    match *method {
        Method::POST => UPLOAD_BODY_DEADLINE,
        Method::PUT => META_BODY_DEADLINE,
        _ => SHORT_BODY_DEADLINE,
    }
}

pub(crate) fn router(data_dir: &Path, origin: String) -> Result<Router, Error> {
    store::prepare(data_dir)?;
    let conn = store::open(data_dir)?;
    let state = AppState::new(data_dir.to_path_buf(), conn, origin);
    // `Router::new()` is the route table. `.with_state` is how every handler
    // receives the same `AppState` (like a singleton injected into servlets).
    Ok(Router::new()
        .route("/api/health", get(health))
        .route("/api/register-key", post(register_key))
        .route("/api/media", get(list).post(upload))
        .route("/api/media/{id}", get(download).put(retag).delete(remove))
        .layer(tower_http::trace::TraceLayer::new_for_http())
        .with_state(state))
}

/// What [`Authed`] pulls off a request after the signature checks out.
/// `owner` is the public key. It is not read from the body.
struct Authed {
    owner: [u8; 32],
    body: Vec<u8>,
    query: Vec<String>,
    after: Option<(i64, String)>,
}

impl FromRequest<AppState> for Authed {
    type Rejection = Response;

    async fn from_request(req: Request, state: &AppState) -> Result<Self, Self::Rejection> {
        // The signature is checked here, before any body byte. It already
        // covers the body hash from the Authorization header. Knowing a
        // public key is not enough to reach `read_body`. The allow-list lives
        // in SQLite, so authentication runs on the blocking pool.
        let (parts, body) = req.into_parts();
        let shared = state.clone();
        let method = parts.method.clone();
        let uri = parts.uri.clone();
        let headers = parts.headers.clone();
        let verified =
            match blocking(move || auth::verify_request(&shared, &method, &uri, &headers)).await {
                Ok(verified) => verified,
                Err(err) => return Err(fail(err)),
            };
        let (query, after) = match list_query(parts.uri.query()) {
            Ok(parsed) => parsed,
            Err(err) => return Err(fail(err)),
        };
        if let Some(value) = parts.headers.get(header::CONTENT_LENGTH) {
            if let Ok(text) = value.to_str() {
                if let Ok(len) = text.parse::<usize>() {
                    if len > MAX_BODY {
                        return Err(too_large());
                    }
                }
            }
        }
        let bytes =
            match read_body_with_deadline(body, MAX_BODY, media_body_deadline(&parts.method)).await
            {
                Ok(bytes) => bytes,
                Err(response) => return Err(*response),
            };
        // SHA-256 of the body is CPU, not disk, but a 32 MB digest would still
        // hold an async worker for the whole hash. Same pool as the file IO.
        let (owner, bytes) = match blocking(move || {
            let owner = auth::verify_body(&verified, &bytes)?;
            Ok((owner, bytes))
        })
        .await
        {
            Ok(pair) => pair,
            Err(err) => return Err(fail(err)),
        };
        Ok(Authed {
            owner,
            body: bytes,
            query,
            after,
        })
    }
}

/// One deadline for the complete body read; chunks do not reset the timer.
/// Timeout drops the reader, its partial buffer, and the request body.
async fn read_body_with_deadline(
    body: Body,
    max: usize,
    deadline: Duration,
) -> Result<Vec<u8>, Box<Response>> {
    match tokio::time::timeout(deadline, read_body_with_limit(body, max)).await {
        Ok(result) => result,
        Err(_) => Err(Box::new(json_response(
            StatusCode::REQUEST_TIMEOUT,
            json!({ "error": "request body timed out" }),
        ))),
    }
}

async fn read_body_with_limit(mut body: Body, max: usize) -> Result<Vec<u8>, Box<Response>> {
    let mut buf = Vec::new();
    while let Some(next) = body.frame().await {
        let frame = next.map_err(|_| Box::new(fail(Error::BadRequest("bad body".into()))))?;
        // Trailers and other non-data frames are ignored. `into_data` is
        // `Ok` only for the bytes of the body.
        let Ok(data) = frame.into_data() else {
            continue;
        };
        if buf.len().saturating_add(data.len()) > max {
            return Err(Box::new(too_large()));
        }
        buf.extend_from_slice(&data);
    }
    Ok(buf)
}

/// `?tag=TOKEN&tag=TOKEN&after=<created_at>.<id>`. Tokens are base64url, so
/// they need no escaping. `after` is the cursor of the last row already shown.
type ListQuery = (Vec<String>, Option<(i64, String)>);

fn list_query(query: Option<&str>) -> Result<ListQuery, Error> {
    let Some(query) = query else {
        return Ok((Vec::new(), None));
    };
    let mut values = Vec::new();
    let mut after = None;
    for pair in query.split('&') {
        if pair.is_empty() {
            continue;
        }
        let mut pieces = pair.splitn(2, '=');
        let key = pieces.next().unwrap_or("");
        let value = pieces.next().unwrap_or("");
        if key == "tag" {
            values.push(value.to_string());
        } else if key == "after" {
            after = Some(store::parse_cursor(value)?);
        }
    }
    Ok((frame::parse_query_tokens(values)?, after))
}

async fn health() -> Response {
    json_response(StatusCode::OK, json!({ "ok": true }))
}

#[derive(Deserialize)]
struct RegisterKeyJson {
    otc: String,
    public_key: String,
}

async fn register_key(State(state): State<AppState>, request: Request) -> Response {
    let (_parts, body) = request.into_parts();
    let bytes = match read_body_with_deadline(body, MAX_REGISTER_BODY, SHORT_BODY_DEADLINE).await {
        Ok(bytes) => bytes,
        Err(response) => return *response,
    };
    match blocking(move || register_key_body(&state, &bytes)).await {
        Ok(()) => empty(StatusCode::NO_CONTENT),
        Err(err) => fail(err),
    }
}

fn register_key_body(state: &AppState, body: &[u8]) -> Result<(), Error> {
    let payload: RegisterKeyJson =
        serde_json::from_slice(body).map_err(|_| Error::BadRequest("invalid json".into()))?;
    if payload.otc.len() > 512 || payload.public_key.len() != 43 {
        return Err(Error::BadRequest("invalid registration payload".into()));
    }
    let public = auth::parse_public_key(&payload.public_key)?;
    let mut conn = state.lock()?;
    store::consume_registration_code(&mut conn, &payload.otc, &public)
}

async fn list(State(state): State<AppState>, authed: Authed) -> Response {
    let owner = authed.owner;
    let query = authed.query;
    let after = authed.after;
    match blocking(move || store::list(&state, owner, &query, after)).await {
        Ok((items, next)) => json_response(
            StatusCode::OK,
            json!({ "media": items_json(items), "next": next }),
        ),
        Err(err) => fail(err),
    }
}

async fn upload(State(state): State<AppState>, authed: Authed) -> Response {
    let owner = authed.owner;
    let body = authed.body;
    match blocking(move || store::add(&state, owner, &body)).await {
        Ok(item) => {
            tracing::info!(id = %item.id, bytes = item.bytes, "stored");
            json_response(StatusCode::CREATED, item_json(item))
        }
        Err(err) => fail(err),
    }
}

async fn download(
    State(state): State<AppState>,
    UrlPath(id): UrlPath<String>,
    authed: Authed,
) -> Response {
    let owner = authed.owner;
    match blocking(move || store::read_content(&state, owner, &id)).await {
        Ok(bytes) => bytes_response(bytes),
        Err(err) => fail(err),
    }
}

async fn retag(
    State(state): State<AppState>,
    UrlPath(id): UrlPath<String>,
    authed: Authed,
) -> Response {
    let owner = authed.owner;
    let body = authed.body;
    match blocking(move || store::update_meta(&state, owner, &id, &body)).await {
        Ok(item) => json_response(StatusCode::OK, item_json(item)),
        Err(err) => fail(err),
    }
}

async fn remove(
    State(state): State<AppState>,
    UrlPath(id): UrlPath<String>,
    authed: Authed,
) -> Response {
    let owner = authed.owner;
    match blocking(move || store::remove(&state, owner, &id)).await {
        Ok(()) => empty(StatusCode::NO_CONTENT),
        Err(err) => fail(err),
    }
}

/// Run `job` on Tokio's blocking pool.
///
/// The async workers are the threads that accept connections and read bodies.
/// `std::fs` and SQLite do not yield: they hold their thread until the disk
/// answers. One upload would then stall every other request sharing that
/// worker, including the signature check that is supposed to reject a body
/// before it is read. The pool is a separate set of threads for this kind of
/// work. The database lock is still one mutex, so writes stay serialized.
async fn blocking<T: Send + 'static>(
    job: impl FnOnce() -> Result<T, Error> + Send + 'static,
) -> Result<T, Error> {
    match tokio::task::spawn_blocking(job).await {
        Ok(result) => result,
        // The closure panicked. The mutex poison path is a different error,
        // raised from inside `job` and returned as `Ok(Err(Poisoned))`.
        Err(_) => Err(std::io::Error::other("blocking task panicked").into()),
    }
}

fn items_json(items: Vec<Item>) -> Vec<MediaJson> {
    items.into_iter().map(item_json).collect()
}

fn item_json(item: Item) -> MediaJson {
    MediaJson {
        id: item.id,
        created_at: item.created_at,
        bytes: item.bytes,
        tokens: item.tokens,
        // Base64 because JSON is text. The bytes are already ciphertext.
        meta: STANDARD.encode(item.meta),
    }
}

#[derive(Serialize)]
struct MediaJson {
    id: String,
    created_at: i64,
    bytes: i64,
    tokens: Vec<String>,
    meta: String,
}

fn json_response(status: StatusCode, body: impl Serialize) -> Response {
    let mut response = (status, Json(body)).into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

/// Ciphertext for one id. The bytes never change, so the browser may keep
/// them. `private` keeps that copy out of any shared cache.
fn bytes_response(body: Vec<u8>) -> Response {
    (
        StatusCode::OK,
        [
            (
                header::CONTENT_TYPE,
                HeaderValue::from_static("application/octet-stream"),
            ),
            (
                header::CACHE_CONTROL,
                HeaderValue::from_static("private, max-age=31536000, immutable"),
            ),
        ],
        body,
    )
        .into_response()
}

fn empty(status: StatusCode) -> Response {
    let mut response = status.into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

fn too_large() -> Response {
    json_response(
        StatusCode::PAYLOAD_TOO_LARGE,
        json!({ "error": "too large" }),
    )
}

fn fail(err: Error) -> Response {
    let (status, message) = match &err {
        Error::Unauthorized => (StatusCode::UNAUTHORIZED, "unauthorized".to_string()),
        Error::NotFound => (StatusCode::NOT_FOUND, "not found".to_string()),
        Error::Conflict => (StatusCode::CONFLICT, "already exists".to_string()),
        Error::BadRequest(message) => (StatusCode::BAD_REQUEST, message.clone()),
        Error::RegistrationFailed => (StatusCode::FORBIDDEN, "registration failed".to_string()),
        other => {
            tracing::error!(error = %other, "request failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "something went wrong".to_string(),
            )
        }
    };
    json_response(status, json!({ "error": message }))
}

#[cfg(test)]
mod deadline_tests {
    use super::*;
    use axum::body::Bytes;
    use http_body_util::Channel;

    #[tokio::test(start_paused = true)]
    async fn trickling_body_does_not_extend_deadline_and_is_dropped() {
        let (mut sender, body) = Channel::<Bytes>::new(1);
        sender
            .send_data(Bytes::from_static(b"first"))
            .await
            .unwrap();
        let read = tokio::spawn(read_body_with_deadline(
            Body::new(body),
            100,
            Duration::from_secs(10),
        ));
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_secs(9)).await;
        assert!(!read.is_finished());
        sender
            .send_data(Bytes::from_static(b"second"))
            .await
            .unwrap();
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_secs(1)).await;
        let response = read.await.unwrap().unwrap_err();
        assert_eq!(response.status(), StatusCode::REQUEST_TIMEOUT);
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&bytes).unwrap(),
            json!({ "error": "request body timed out" })
        );
        assert!(sender.send_data(Bytes::from_static(b"late")).await.is_err());
    }

    #[tokio::test(start_paused = true)]
    async fn completed_oversized_and_broken_bodies_keep_existing_results() {
        let deadline = Duration::from_secs(10);
        assert_eq!(
            read_body_with_deadline(Body::from("abc"), 3, deadline)
                .await
                .unwrap(),
            b"abc"
        );
        let oversized = read_body_with_deadline(Body::from("abc"), 2, deadline)
            .await
            .unwrap_err();
        assert_eq!(oversized.status(), StatusCode::PAYLOAD_TOO_LARGE);
        let (sender, body) = Channel::<Bytes, std::io::Error>::new(1);
        sender.abort(std::io::Error::other("broken body"));
        let broken = read_body_with_deadline(Body::new(body), 3, deadline)
            .await
            .unwrap_err();
        assert_eq!(broken.status(), StatusCode::BAD_REQUEST);
    }
}
