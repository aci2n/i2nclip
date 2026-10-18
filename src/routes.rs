//! Router assembly, health and registration endpoints, and shared HTTP helpers.

use std::time::Duration;

use axum::{
    body::Body,
    extract::State,
    http::{header, HeaderValue, Method, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Router,
};
use http_body_util::BodyExt;
use serde::{Deserialize, Serialize};
#[cfg(test)]
use serde_json::json;
use tower_http::{
    cors::{Any, CorsLayer},
    trace::TraceLayer,
};

use crate::{
    auth::{RegistrationRequest, SignedRequest},
    codec, media, pairing, AppState, Error, MAX_REGISTER_BODY,
};

pub(crate) const SHORT_BODY_DEADLINE: Duration = Duration::from_secs(10);

pub(crate) fn router(state: AppState) -> Router {
    Router::new()
        .route("/api/health", get(health))
        .route("/api/ping", get(ping))
        .route("/api/register-key", post(register_key))
        .merge(media::router())
        .merge(pairing::router())
        .layer(
            CorsLayer::new()
                .allow_origin(Any)
                .allow_methods([
                    Method::GET,
                    Method::HEAD,
                    Method::POST,
                    Method::PUT,
                    Method::DELETE,
                ])
                .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE]),
        )
        .layer(TraceLayer::new_for_http())
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
        Err(_) => Err(Box::new(error_response(
            StatusCode::REQUEST_TIMEOUT,
            "request body timed out",
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
    #[derive(Serialize)]
    struct Health {
        ok: bool,
    }
    document_response(StatusCode::OK, Health { ok: true })
}

async fn ping(request: SignedRequest) -> Response {
    match request.empty().await {
        Ok(_) => empty(StatusCode::NO_CONTENT),
        Err(response) => *response,
    }
}

#[derive(Deserialize)]
struct RegisterKeyDocument {
    otc: String,
}

async fn register_key(
    State(state): State<AppState>,
    RegistrationRequest(request): RegistrationRequest,
) -> Response {
    if let Err(response) = request.check_size(MAX_REGISTER_BODY) {
        return *response;
    }
    let (signer, bytes) = match request.read(MAX_REGISTER_BODY, SHORT_BODY_DEADLINE).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    match register_key_body(&state, signer, &bytes).await {
        Ok(()) => empty(StatusCode::NO_CONTENT),
        Err(err) => fail(err),
    }
}

async fn register_key_body(state: &AppState, signer: [u8; 32], body: &[u8]) -> Result<(), Error> {
    let payload: RegisterKeyDocument = codec::decode(body)?;
    if payload.otc.len() > 512 {
        return Err(Error::BadRequest("invalid registration payload".into()));
    }
    state.db.consume_code(&payload.otc, &signer).await
}

pub(crate) fn document_response(status: StatusCode, body: impl Serialize) -> Response {
    let mut response = match codec::encode(&body) {
        Ok(bytes) => (status, [(header::CONTENT_TYPE, codec::CONTENT_TYPE)], bytes).into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

pub(crate) fn error_response(status: StatusCode, message: &str) -> Response {
    #[derive(Serialize)]
    struct ErrorDocument<'a> {
        error: &'a str,
    }
    document_response(status, ErrorDocument { error: message })
}

pub(crate) fn empty(status: StatusCode) -> Response {
    let mut response = status.into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

pub(crate) fn too_large() -> Response {
    error_response(StatusCode::PAYLOAD_TOO_LARGE, "too large")
}

pub(crate) fn fail(err: Error) -> Response {
    let (status, message) = match &err {
        Error::Unavailable => (
            StatusCode::SERVICE_UNAVAILABLE,
            "service unavailable".into(),
        ),
        Error::Unauthorized => (StatusCode::UNAUTHORIZED, "unauthorized".to_string()),
        Error::TooEarly => (StatusCode::TOO_EARLY, "too early".to_string()),
        Error::NotFound => (StatusCode::NOT_FOUND, "not found".to_string()),
        Error::StorageLimit | Error::FileSizeLimit => (StatusCode::CONFLICT, err.to_string()),
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
    let mut response = error_response(status, &message);
    if status == StatusCode::SERVICE_UNAVAILABLE {
        response
            .headers_mut()
            .insert(header::RETRY_AFTER, HeaderValue::from_static("1"));
    }
    response
}

#[cfg(test)]
mod deadline_tests {
    use axum::body::Bytes;
    use http_body_util::Channel;

    use super::*;

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
            codec::decode::<serde_json::Value>(&bytes).unwrap(),
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

#[cfg(test)]
mod request_tests {
    use axum::http::Request;
    use tower::ServiceExt;

    use super::*;

    async fn app() -> Router {
        let db = crate::db::Database::closed_for_test().await;
        router(AppState::new(db, "http://i2nclip.test".into()))
    }

    #[tokio::test]
    async fn external_clients_can_preflight_and_read_success_and_auth_errors() {
        let app = app().await;
        for origin in ["https://client.example", "http://localhost:5173"] {
            for method in ["GET", "HEAD", "POST", "PUT", "DELETE"] {
                let response = app
                    .clone()
                    .oneshot(
                        Request::builder()
                            .method("OPTIONS")
                            .uri("/api/media")
                            .header(header::ORIGIN, origin)
                            .header(header::ACCESS_CONTROL_REQUEST_METHOD, method)
                            .header(
                                header::ACCESS_CONTROL_REQUEST_HEADERS,
                                "authorization,content-type",
                            )
                            .body(Body::empty())
                            .unwrap(),
                    )
                    .await
                    .unwrap();
                assert!(response.status().is_success());
                let headers = response.headers();
                assert_eq!(headers[header::ACCESS_CONTROL_ALLOW_ORIGIN], "*");
                assert!(headers[header::ACCESS_CONTROL_ALLOW_METHODS]
                    .to_str()
                    .unwrap()
                    .split(',')
                    .any(|allowed| allowed.trim() == method));
                let allowed = headers[header::ACCESS_CONTROL_ALLOW_HEADERS]
                    .to_str()
                    .unwrap();
                assert!(allowed.contains("authorization"));
                assert!(allowed.contains("content-type"));
                assert!(!headers.contains_key(header::ACCESS_CONTROL_ALLOW_CREDENTIALS));
            }
            for (path, status) in [
                ("/api/health", StatusCode::OK),
                ("/api/media", StatusCode::UNAUTHORIZED),
            ] {
                let response = app
                    .clone()
                    .oneshot(
                        Request::builder()
                            .uri(path)
                            .header(header::ORIGIN, origin)
                            .body(Body::empty())
                            .unwrap(),
                    )
                    .await
                    .unwrap();
                assert_eq!(response.status(), status);
                assert_eq!(response.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN], "*");
                assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
            }
        }
    }

    #[tokio::test]
    async fn health_needs_no_key_or_database() {
        let response = app()
            .await
            .oneshot(
                Request::builder()
                    .uri("/api/health")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = response.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(
            crate::reference_crypto::document_json(&body),
            json!({ "ok": true })
        );
    }

    #[tokio::test]
    async fn unsigned_application_requests_are_rejected_before_body_or_database() {
        let app = app().await;
        let item = format!("/api/media/{}", "a".repeat(64));
        let meta = format!("{item}/meta");
        for (method, path) in [
            ("POST", "/api/register-key"),
            ("GET", "/api/ping"),
            ("GET", "/api/quota"),
            ("GET", "/api/tags"),
            ("GET", "/api/media"),
            ("POST", "/api/media"),
            ("GET", item.as_str()),
            ("PUT", meta.as_str()),
            ("DELETE", item.as_str()),
        ] {
            let body = Body::new(
                Body::from("unread")
                    .map_frame(|_| panic!("unauthenticated request body was polled")),
            );
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method(method)
                        .uri(path)
                        .body(body)
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(
                response.status(),
                StatusCode::UNAUTHORIZED,
                "{method} {path}"
            );
            assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        }
    }

    #[tokio::test]
    async fn invalid_registration_documents_do_not_access_invitation_database() {
        let state = AppState::new(
            crate::db::Database::closed_for_test().await,
            "http://i2nclip.test".into(),
        );
        let signer = crate::reference_crypto::from_seed([1; 32]).public;
        let registration = crate::reference_crypto::registration_body;
        for body in [
            b"not MessagePack".to_vec(),
            codec::encode(&json!({})).unwrap(),
            registration(&"x".repeat(513)),
        ] {
            assert!(matches!(
                register_key_body(&state, signer, &body).await,
                Err(Error::BadRequest(_))
            ));
        }
    }
}
