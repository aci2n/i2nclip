//! Media endpoints and authenticated request policy.
//!
//! Signature checks precede body limits, upload admission, reading, and hashing.
//! Buffered upload bodies retain their permits through blocking storage work.

use std::time::Duration;

use axum::body::{Body, Bytes};
use tokio::io::AsyncReadExt;

use axum::extract::{FromRequest, Path as UrlPath, Request, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde::Serialize;
use serde_json::json;

use crate::routes::{
    blocking, empty, fail, json_response, read_body_with_deadline, too_large, SHORT_BODY_DEADLINE,
};
use crate::store::{AppState, Item};
use crate::{auth, frame, store, Error, MAX_BODY, MAX_META_BODY};

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/media", get(list).post(upload))
        .route("/api/media/{id}", get(download).put(retag).delete(remove))
}

const META_BODY_DEADLINE: Duration = Duration::from_secs(30);
const UPLOAD_BODY_DEADLINE: Duration = Duration::from_secs(120);

/// Header-authenticated request. Endpoint handlers own body/query policy.
struct MediaRequest {
    verified: auth::VerifiedRequest,
    parts: axum::http::request::Parts,
    body: Body,
}

// Field order releases buffered bytes before returning upload capacity.
struct BufferedBody {
    bytes: Vec<u8>,
    _upload_permit: Option<tokio::sync::OwnedSemaphorePermit>,
}

impl FromRequest<AppState> for MediaRequest {
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
        Ok(Self {
            verified,
            parts,
            body,
        })
    }
}

impl MediaRequest {
    fn check_size(&self, max: usize) -> Result<(), Response> {
        if self
            .parts
            .headers
            .get(header::CONTENT_LENGTH)
            .and_then(|value| value.to_str().ok())
            .and_then(|text| text.parse::<usize>().ok())
            .is_some_and(|len| len > max)
        {
            return Err(too_large());
        }
        Ok(())
    }

    async fn read(
        self,
        max: usize,
        deadline: Duration,
        permit: Option<tokio::sync::OwnedSemaphorePermit>,
    ) -> Result<([u8; 32], BufferedBody), Response> {
        let bytes = read_body_with_deadline(self.body, max, deadline)
            .await
            .map_err(|response| *response)?;
        let buffered = BufferedBody {
            bytes,
            _upload_permit: permit,
        };
        // Bytes and admission travel together even if this waiter is cancelled.
        blocking(move || {
            let owner = auth::verify_body(&self.verified, &buffered.bytes)?;
            Ok((owner, buffered))
        })
        .await
        .map_err(fail)
    }

    async fn empty(self) -> Result<[u8; 32], Response> {
        self.check_size(0)?;
        let (owner, _) = self.read(0, SHORT_BODY_DEADLINE, None).await?;
        Ok(owner)
    }
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

async fn list(State(state): State<AppState>, media: MediaRequest) -> Response {
    let (query, after) = match list_query(media.parts.uri.query()) {
        Ok(query) => query,
        Err(err) => return fail(err),
    };
    let owner = match media.empty().await {
        Ok(owner) => owner,
        Err(response) => return response,
    };
    match blocking(move || store::list(&state, owner, &query, after)).await {
        Ok((items, next)) => json_response(
            StatusCode::OK,
            json!({ "media": items_json(items), "next": next }),
        ),
        Err(err) => fail(err),
    }
}

async fn upload(State(state): State<AppState>, media: MediaRequest) -> Response {
    if let Err(response) = media.check_size(MAX_BODY) {
        return response;
    }
    let permit = match state.upload_slots.clone().try_acquire_owned() {
        Ok(permit) => permit,
        Err(_) => return uploads_busy(),
    };
    let (owner, body) = match media
        .read(MAX_BODY, UPLOAD_BODY_DEADLINE, Some(permit))
        .await
    {
        Ok(body) => body,
        Err(response) => return response,
    };
    match blocking(move || {
        let result = store::add(&state, owner, &body.bytes);
        drop(body);
        result
    })
    .await
    {
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
    media: MediaRequest,
) -> Response {
    let owner = match media.empty().await {
        Ok(owner) => owner,
        Err(response) => return response,
    };
    let permit = match state.download_slots.clone().try_acquire_owned() {
        Ok(permit) => permit,
        Err(_) => return transfers_busy("downloads busy; try again"),
    };
    // Opening owns the permit as well, including if this HTTP task is cancelled.
    match blocking(move || {
        let (file, bytes) = store::open_content(&state, owner, &id)?;
        Ok((file, bytes, permit))
    })
    .await
    {
        Ok((file, bytes, permit)) => content_response(file, bytes, permit),
        Err(err) => fail(err),
    }
}

async fn retag(
    State(state): State<AppState>,
    UrlPath(id): UrlPath<String>,
    media: MediaRequest,
) -> Response {
    if let Err(response) = media.check_size(MAX_META_BODY) {
        return response;
    }
    let (owner, body) = match media.read(MAX_META_BODY, META_BODY_DEADLINE, None).await {
        Ok(body) => body,
        Err(response) => return response,
    };
    match blocking(move || store::update_meta(&state, owner, &id, &body.bytes)).await {
        Ok(item) => json_response(StatusCode::OK, item_json(item)),
        Err(err) => fail(err),
    }
}

async fn remove(
    State(state): State<AppState>,
    UrlPath(id): UrlPath<String>,
    media: MediaRequest,
) -> Response {
    let owner = match media.empty().await {
        Ok(owner) => owner,
        Err(response) => return response,
    };
    match blocking(move || store::remove(&state, owner, &id)).await {
        Ok(()) => empty(StatusCode::NO_CONTENT),
        Err(err) => fail(err),
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

const DOWNLOAD_CHUNK: usize = 64 * 1024;

struct Download {
    file: tokio::fs::File,
    remaining: u64,
    _permit: tokio::sync::OwnedSemaphorePermit,
}

fn content_response(
    file: std::fs::File,
    bytes: u64,
    permit: tokio::sync::OwnedSemaphorePermit,
) -> Response {
    let mut file = tokio::fs::File::from_std(file);
    file.set_max_buf_size(DOWNLOAD_CHUNK);
    let download = Download {
        file,
        remaining: bytes,
        _permit: permit,
    };
    let stream = futures_util::stream::try_unfold(download, |mut download| async move {
        if download.remaining == 0 {
            return Ok::<_, std::io::Error>(None);
        }
        let mut chunk = vec![0; download.remaining.min(DOWNLOAD_CHUNK as u64) as usize];
        // A truncation after headers becomes a body error, never a clean short response.
        download.file.read_exact(&mut chunk).await?;
        download.remaining -= chunk.len() as u64;
        Ok(Some((Bytes::from(chunk), download)))
    });
    let mut response = Body::from_stream(stream).into_response();
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );
    response
        .headers_mut()
        .insert(header::CONTENT_LENGTH, HeaderValue::from(bytes));
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, max-age=31536000, immutable"),
    );
    response
}

fn uploads_busy() -> Response {
    transfers_busy("uploads busy; try again")
}

fn transfers_busy(message: &'static str) -> Response {
    let mut response = json_response(StatusCode::SERVICE_UNAVAILABLE, json!({ "error": message }));
    response
        .headers_mut()
        .insert(header::RETRY_AFTER, HeaderValue::from_static("1"));
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn cancelled_blocking_work_retains_buffer_and_permit() {
        let slots = std::sync::Arc::new(tokio::sync::Semaphore::new(1));
        let buffered = BufferedBody {
            bytes: vec![1; 1024],
            _upload_permit: Some(slots.clone().try_acquire_owned().unwrap()),
        };
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (finish_tx, finish_rx) = std::sync::mpsc::channel();
        let (done_tx, done_rx) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(blocking(move || {
            started_tx.send(()).unwrap();
            finish_rx.recv().unwrap();
            assert_eq!(buffered.bytes.len(), 1024);
            drop(buffered);
            done_tx.send(()).unwrap();
            Ok(())
        }));
        started_rx.await.unwrap();
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        assert!(slots.clone().try_acquire_owned().is_err());
        finish_tx.send(()).unwrap();
        done_rx.await.unwrap();
        assert_eq!(slots.available_permits(), 1);
    }
}
