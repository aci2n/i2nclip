//! Router assembly, health and registration endpoints, and shared HTTP helpers.

use std::time::Duration;

use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use http_body_util::BodyExt;
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::store::AppState;
use crate::{auth, media, store, Error, MAX_REGISTER_BODY};

pub(crate) const SHORT_BODY_DEADLINE: Duration = Duration::from_secs(10);

pub(crate) fn router(state: AppState) -> Router {
    Router::new()
        .route("/api/health", get(health))
        .route("/api/register-key", post(register_key))
        .merge(media::router())
        .layer(tower_http::trace::TraceLayer::new_for_http())
        .with_state(state)
}

/// One deadline for the complete body read; chunks do not reset the timer.
/// Timeout drops the reader, its partial buffer, and the request body.
pub(crate) async fn read_body_with_deadline(
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
        // Ignore trailers and other non-data frames.
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

/// Run synchronous disk/SQLite work and large hashes off the async workers.
pub(crate) async fn blocking<T: Send + 'static>(
    job: impl FnOnce() -> Result<T, Error> + Send + 'static,
) -> Result<T, Error> {
    match tokio::task::spawn_blocking(job).await {
        Ok(result) => result,
        // The closure panicked. The mutex poison path is a different error,
        // raised from inside `job` and returned as `Ok(Err(Poisoned))`.
        Err(_) => Err(std::io::Error::other("blocking task panicked").into()),
    }
}

pub(crate) fn json_response(status: StatusCode, body: impl Serialize) -> Response {
    let mut response = (status, Json(body)).into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

pub(crate) fn empty(status: StatusCode) -> Response {
    let mut response = status.into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

pub(crate) fn too_large() -> Response {
    json_response(
        StatusCode::PAYLOAD_TOO_LARGE,
        json!({ "error": "too large" }),
    )
}

pub(crate) fn fail(err: Error) -> Response {
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
