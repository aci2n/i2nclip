//! Media endpoints and authenticated request policy.
//!
//! Signature checks precede body limits, upload admission, reading, and hashing.
//! Buffered upload bodies retain their permits through database writes.

use std::{
    io,
    pin::Pin,
    sync::{Arc, Mutex},
    task::{Context, Poll},
    time::Duration,
};

use axum::{
    body::{Body, Bytes},
    extract::{Path as UrlPath, State},
    http::{header, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::{delete, get},
    Router,
};
use futures_util::Stream;
use serde::Serialize;
use tokio::{task::JoinHandle, time::Instant};

use crate::{
    auth::SignedRequest,
    db::{Item, MetadataUpdate},
    frame,
    permits::TransferPermit,
    routes::{document_response, empty, fail},
    AppState, Error, MAX_CHUNK_BYTES, MAX_CREATE_BODY, MAX_META_BODY,
};

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/quota", get(quota))
        .route("/api/tags", get(tags))
        .route("/api/media", get(list).post(upload))
        .route("/api/media/{id}", delete(remove))
        .route(
            "/api/media/{id}/chunks/{index}",
            get(download).put(upload_chunk),
        )
        .route("/api/media/{id}/meta", get(metadata).put(update_metadata))
}

const DOWNLOAD_DEADLINE: Duration = Duration::from_secs(180);
const META_BODY_DEADLINE: Duration = Duration::from_secs(30);
const UPLOAD_BODY_DEADLINE: Duration = Duration::from_secs(120);

// Field order releases buffered bytes before returning upload capacity.
struct BufferedBody {
    bytes: Vec<u8>,
    _upload_permit: TransferPermit,
}

/// `?tag=TOKEN&tag=TOKEN&after=<created_at>.<id>`. Tokens are base64url, so
/// they need no escaping. `after` is the cursor of the last row already shown.
type ListQuery = (Vec<String>, Option<(i64, String)>);

/// Decode the submitted page cursor and validate its content identifier.
fn parse_cursor(text: &str) -> Result<(i64, String), Error> {
    let Some((ts, id)) = text.split_once('.') else {
        return Err(Error::BadRequest("after must be created_at.id".into()));
    };
    let created_at: i64 = ts
        .parse()
        .map_err(|_| Error::BadRequest("after must be created_at.id".into()))?;
    Ok((created_at, frame::parse_id(id)?))
}

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
            after = Some(parse_cursor(value)?);
        }
    }
    Ok((frame::parse_query_tokens(values)?, after))
}

async fn tags(State(state): State<AppState>, request: SignedRequest) -> Response {
    let owner = match request.empty().await {
        Ok(owner) => owner,
        Err(response) => return *response,
    };
    match state.db.tags(owner).await {
        Ok(tags) => document_response(StatusCode::OK, Catalog { tags }),
        Err(error) => fail(error),
    }
}

async fn quota(State(state): State<AppState>, media: SignedRequest) -> Response {
    let owner = match media.empty().await {
        Ok(owner) => owner,
        Err(response) => return *response,
    };
    match state.db.quota(owner).await {
        Ok(quota) => document_response(StatusCode::OK, quota),
        Err(error) => fail(error),
    }
}

async fn list(State(state): State<AppState>, media: SignedRequest) -> Response {
    let (query, after) = match list_query(media.query()) {
        Ok(query) => query,
        Err(err) => return fail(err),
    };
    let owner = match media.empty().await {
        Ok(owner) => owner,
        Err(response) => return *response,
    };
    match state.db.list(owner, &query, after).await {
        Ok((items, next)) => document_response(
            StatusCode::OK,
            MediaPage {
                media: items.into_iter().map(item_document).collect(),
                next,
            },
        ),
        Err(err) => fail(err),
    }
}

async fn upload(State(state): State<AppState>, media: SignedRequest) -> Response {
    if let Err(response) = media.check_size(MAX_CREATE_BODY) {
        return *response;
    }
    let permit = match state.permits.upload(media.owner()).await {
        Ok(permit) => permit,
        Err(error) => return fail(error),
    };
    let (owner, body) = match media.read(MAX_CREATE_BODY, META_BODY_DEADLINE).await {
        Ok(body) => body,
        Err(response) => return *response,
    };
    let body = BufferedBody {
        bytes: body,
        _upload_permit: permit,
    };
    match state.db.create_upload(owner, &body.bytes).await {
        Ok(item) => {
            tracing::info!(id = %item.id, "upload created");
            document_response(StatusCode::CREATED, item)
        }
        Err(err) => fail(err),
    }
}

async fn upload_chunk(
    State(state): State<AppState>,
    UrlPath((id, index)): UrlPath<(String, u64)>,
    media: SignedRequest,
) -> Response {
    if let Err(response) = media.check_size(MAX_CHUNK_BYTES) {
        return *response;
    }
    let permit = match state.permits.upload(media.owner()).await {
        Ok(permit) => permit,
        Err(error) => return fail(error),
    };
    let (owner, body) = match media.read(MAX_CHUNK_BYTES, UPLOAD_BODY_DEADLINE).await {
        Ok(body) => body,
        Err(response) => return *response,
    };
    let body = BufferedBody {
        bytes: body,
        _upload_permit: permit,
    };
    match state.db.put_chunk(owner, &id, index, &body.bytes).await {
        Ok(()) => empty(StatusCode::NO_CONTENT),
        Err(error) => fail(error),
    }
}

async fn download(
    State(state): State<AppState>,
    UrlPath((id, index)): UrlPath<(String, u64)>,
    media: SignedRequest,
) -> Response {
    let owner = match media.empty().await {
        Ok(owner) => owner,
        Err(response) => return *response,
    };
    let permit = match state.permits.download(owner).await {
        Ok(permit) => permit,
        Err(error) => return fail(error),
    };
    match state.db.content_chunk(owner, &id, index).await {
        Ok(content) => content_response(content, &id, index, permit),
        Err(err) => fail(err),
    }
}

async fn metadata(
    State(state): State<AppState>,
    UrlPath(id): UrlPath<String>,
    media: SignedRequest,
) -> Response {
    let owner = match media.empty().await {
        Ok(owner) => owner,
        Err(response) => return *response,
    };
    match state.db.metadata(owner, &id).await {
        Ok(item) => document_response(StatusCode::OK, item_document(item)),
        Err(error) => fail(error),
    }
}

async fn update_metadata(
    State(state): State<AppState>,
    UrlPath(id): UrlPath<String>,
    media: SignedRequest,
) -> Response {
    if let Err(response) = media.check_size(MAX_META_BODY) {
        return *response;
    }
    let (owner, body) = match media.read(MAX_META_BODY, META_BODY_DEADLINE).await {
        Ok(body) => body,
        Err(response) => return *response,
    };
    match state.db.update_meta(owner, &id, &body).await {
        Ok(MetadataUpdate::Updated(item)) => document_response(StatusCode::OK, item_document(item)),
        Ok(MetadataUpdate::Conflict(item)) => document_response(
            StatusCode::CONFLICT,
            MetadataConflict {
                error: "metadata changed in another page",
                code: "metadata_conflict",
                media: item_document(item),
            },
        ),
        Err(err) => fail(err),
    }
}

async fn remove(
    State(state): State<AppState>,
    UrlPath(id): UrlPath<String>,
    media: SignedRequest,
) -> Response {
    let owner = match media.empty().await {
        Ok(owner) => owner,
        Err(response) => return *response,
    };
    match state.db.remove(owner, &id).await {
        Ok(()) => empty(StatusCode::NO_CONTENT),
        Err(err) => fail(err),
    }
}

fn item_document(item: Item) -> MediaDocument {
    MediaDocument {
        id: item.id,
        created_at: item.created_at,
        bytes: item.bytes,
        meta: item.meta,
        descriptor: item.descriptor,
        expected_chunk_count: item.expected_chunk_count,
    }
}

#[derive(Serialize)]
struct MediaDocument {
    id: String,
    created_at: i64,
    bytes: i64,
    #[serde(with = "serde_bytes")]
    meta: Vec<u8>,
    #[serde(with = "serde_bytes")]
    descriptor: Vec<u8>,
    expected_chunk_count: i64,
}

#[derive(Serialize)]
struct Catalog {
    tags: Vec<crate::db::TagLabel>,
}
#[derive(Serialize)]
struct MediaPage {
    media: Vec<MediaDocument>,
    next: Option<String>,
}
#[derive(Serialize)]
struct MetadataConflict {
    error: &'static str,
    code: &'static str,
    media: MediaDocument,
}

const DOWNLOAD_CHUNK: usize = 64 * 1024;

// Only active responses retain the original allocation and admission permit.
// Emitted chunks own separate allocations so the deadline can free this buffer.
enum DownloadState {
    Active {
        content: Bytes,
        _permit: TransferPermit,
    },
    Complete,
    Expired,
}

struct DownloadStream {
    state: Arc<Mutex<DownloadState>>,
    deadline: Instant,
    timer: JoinHandle<()>,
}

impl DownloadStream {
    fn new(content: Vec<u8>, permit: TransferPermit) -> Self {
        let state = Arc::new(Mutex::new(DownloadState::Active {
            content: Bytes::from(content),
            _permit: permit,
        }));
        let weak = Arc::downgrade(&state);
        let deadline = Instant::now() + DOWNLOAD_DEADLINE;
        let timer = tokio::spawn(async move {
            tokio::time::sleep_until(deadline).await;
            if let Some(state) = weak.upgrade() {
                let mut state = state.lock().unwrap();
                if matches!(*state, DownloadState::Active { .. }) {
                    *state = DownloadState::Expired;
                    tracing::warn!("download response timed out");
                }
            }
        });
        Self {
            state,
            deadline,
            timer,
        }
    }
}

impl Stream for DownloadStream {
    type Item = Result<Bytes, io::Error>;

    fn poll_next(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let mut state = self.state.lock().unwrap();
        // Enforce the absolute deadline even if the timer has not been scheduled yet.
        if Instant::now() >= self.deadline && matches!(*state, DownloadState::Active { .. }) {
            *state = DownloadState::Expired;
        }
        let result = match &mut *state {
            DownloadState::Active { content, .. } => {
                let chunk = Bytes::copy_from_slice(&content[..content.len().min(DOWNLOAD_CHUNK)]);
                let _ = content.split_to(chunk.len());
                if content.is_empty() {
                    *state = DownloadState::Complete;
                    self.timer.abort();
                }
                Some(Ok(chunk))
            }
            DownloadState::Expired => {
                *state = DownloadState::Complete;
                Some(Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "download response timed out",
                )))
            }
            DownloadState::Complete => None,
        };
        // This stream never returns Pending; expiry needs no stored body waker.
        Poll::Ready(result)
    }
}

impl Drop for DownloadStream {
    fn drop(&mut self) {
        self.timer.abort();
    }
}

fn content_response(content: Vec<u8>, id: &str, index: u64, permit: TransferPermit) -> Response {
    let bytes = content.len() as u64;
    let stream = DownloadStream::new(content, permit);
    let mut response = Body::from_stream(stream).into_response();
    response.headers_mut().insert(
        header::ETAG,
        HeaderValue::from_str(&format!("\"{id}.{index}\"")).unwrap(),
    );
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

#[cfg(test)]
mod tests {
    use std::{
        future::{poll_fn, Future},
        task::Poll,
    };

    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    use http_body_util::BodyExt;

    use super::*;
    use crate::permits::Permits;

    #[tokio::test(start_paused = true)]
    async fn unpolled_and_partial_responses_expire_and_release_original_allocations() {
        use futures_util::StreamExt;

        for partial in [false, true] {
            let permits = Permits::new();
            let permit = permits.download([1; 32]).await.unwrap();
            let content = vec![7; DOWNLOAD_CHUNK * 4];
            let original = content.as_ptr() as usize;
            let mut stream = DownloadStream::new(content, permit);
            let state = Arc::downgrade(&stream.state);
            let retained = if partial {
                let chunk = stream.next().await.unwrap().unwrap();
                assert_eq!(chunk.len(), DOWNLOAD_CHUNK);
                assert_ne!(chunk.as_ptr() as usize, original);
                Some(chunk)
            } else {
                None
            };
            let other = permits.download([1; 32]).await.unwrap();
            let mut waiting = Box::pin(permits.download([1; 32]));
            assert!(poll_fn(|cx| Poll::Ready(waiting.as_mut().poll(cx)))
                .await
                .is_pending());
            drop(waiting);
            tokio::time::advance(DOWNLOAD_DEADLINE - Duration::from_secs(1)).await;
            let mut waiting = Box::pin(permits.download([1; 32]));
            if partial {
                stream.next().await.unwrap().unwrap();
            }
            assert!(poll_fn(|cx| Poll::Ready(waiting.as_mut().poll(cx)))
                .await
                .is_pending());
            tokio::time::advance(Duration::from_secs(1)).await;
            tokio::task::yield_now().await;
            assert!(matches!(
                *state.upgrade().unwrap().lock().unwrap(),
                DownloadState::Expired
            ));
            let replacement = waiting.await.unwrap();
            assert_eq!(
                stream.next().await.unwrap().unwrap_err().kind(),
                io::ErrorKind::TimedOut
            );
            assert!(stream.next().await.is_none());
            if let Some(chunk) = retained {
                assert!(chunk.iter().all(|byte| *byte == 7));
            }
            drop(stream);
            assert!(state.upgrade().is_none());
            drop((other, replacement));
        }
    }

    #[tokio::test(start_paused = true)]
    async fn completion_and_drop_cancel_deadline_tasks() {
        use futures_util::StreamExt;

        let permits = Permits::new();
        for complete in [false, true] {
            let permit = permits.download([1; 32]).await.unwrap();
            let mut stream = DownloadStream::new(vec![1; 16], permit);
            let timer = stream.timer.abort_handle();
            let state = Arc::downgrade(&stream.state);
            if complete {
                assert_eq!(stream.next().await.unwrap().unwrap().len(), 16);
                assert!(matches!(
                    *stream.state.lock().unwrap(),
                    DownloadState::Complete
                ));
            }
            drop(stream);
            tokio::task::yield_now().await;
            assert!(timer.is_finished());
            assert!(state.upgrade().is_none());
        }
    }

    #[tokio::test(start_paused = true)]
    async fn tcp_slow_reader_cannot_hold_application_resources_past_deadline() {
        use axum::routing::get;
        use tokio::{
            io::{AsyncReadExt, AsyncWriteExt},
            net::TcpSocket,
        };

        struct Server(JoinHandle<()>);
        impl Drop for Server {
            fn drop(&mut self) {
                self.0.abort();
            }
        }
        // Prevent paused time from auto-advancing during real socket I/O.
        let clock = Server(tokio::spawn(async {
            loop {
                tokio::task::yield_now().await;
            }
        }));
        let permits = Permits::new();
        let other = permits.download([1; 32]).await.unwrap();
        let permit = permits.download([1; 32]).await.unwrap();
        let stream = DownloadStream::new(vec![7; MAX_CHUNK_BYTES], permit);
        let state = stream.state.clone();
        let mut response = Body::from_stream(stream).into_response();
        response
            .headers_mut()
            .insert(header::CONTENT_LENGTH, HeaderValue::from(MAX_CHUNK_BYTES));
        let response = Arc::new(Mutex::new(Some(response)));
        let app = Router::new().route(
            "/",
            get(move || {
                let response = response.lock().unwrap().take().unwrap();
                async { response }
            }),
        );
        let socket = TcpSocket::new_v4().unwrap();
        socket.set_send_buffer_size(32 * 1024).unwrap();
        socket.bind("127.0.0.1:0".parse().unwrap()).unwrap();
        let listener = socket.listen(1).unwrap();
        let address = listener.local_addr().unwrap();
        let server = Server(tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        }));
        let socket = TcpSocket::new_v4().unwrap();
        socket.set_recv_buffer_size(4096).unwrap();
        let mut client = socket.connect(address).await.unwrap();
        client
            .write_all(b"GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
            .await
            .unwrap();
        let mut header = [0; 1024];
        let length = client.read(&mut header).await.unwrap();
        assert!(header[..length].starts_with(b"HTTP/1.1 200"));
        // Let Hyper fill the socket while this client stops reading.
        for _ in 0..100 {
            tokio::task::yield_now().await;
        }
        assert!(
            matches!(*state.lock().unwrap(), DownloadState::Active { .. }),
            "transport must actually exercise backpressure"
        );
        tokio::time::advance(DOWNLOAD_DEADLINE).await;
        tokio::task::yield_now().await;
        assert!(!matches!(
            *state.lock().unwrap(),
            DownloadState::Active { .. }
        ));
        let replacement = permits.download([1; 32]).await.unwrap();
        drop((replacement, other, client, server, clock));
    }

    #[test]
    fn list_query_validates_cursor_and_deduplicates_tags_without_database() {
        assert_eq!(list_query(None).unwrap(), (vec![], None));
        let token = URL_SAFE_NO_PAD.encode([1_u8; 32]);
        let id = "a".repeat(64);
        let query = format!("tag={token}&tag={token}&after=123.{id}&unknown=value&");
        assert_eq!(
            list_query(Some(&query)).unwrap(),
            (vec![token], Some((123, id)))
        );
        for query in [
            "tag=invalid",
            "after=invalid",
            "after=123.BAD",
            "after=overflow.hash",
        ] {
            assert!(
                matches!(list_query(Some(query)), Err(Error::BadRequest(_))),
                "{query}"
            );
        }
    }

    #[tokio::test]
    async fn download_body_owns_bytes_and_releases_permit_without_database() {
        let permits = Permits::new();
        // Hold the other per-key download slot so one response saturates this key.
        let _other = permits.download([1; 32]).await.unwrap();
        async fn assert_held(permits: &Permits) {
            let mut waiting = Box::pin(permits.download([1; 32]));
            assert!(poll_fn(|cx| Poll::Ready(waiting.as_mut().poll(cx)))
                .await
                .is_pending());
        }
        async fn assert_released(permits: &Permits) {
            drop(
                tokio::time::timeout(Duration::from_secs(1), permits.download([1; 32]))
                    .await
                    .unwrap()
                    .unwrap(),
            );
        }
        let content = vec![7_u8; DOWNLOAD_CHUNK * 2 + 1];
        let permit = permits.download([1; 32]).await.unwrap();
        let response = content_response(content.clone(), "content-hash", 0, permit);
        assert_eq!(
            response.headers()[header::CONTENT_LENGTH],
            content.len().to_string()
        );
        assert_held(&permits).await;
        drop(response);
        assert_released(&permits).await;

        let permit = permits.download([1; 32]).await.unwrap();
        let mut body = content_response(content.clone(), "content-hash", 0, permit).into_body();
        let first = body.frame().await.unwrap().unwrap().into_data().unwrap();
        assert_eq!(first.len(), DOWNLOAD_CHUNK);
        assert_held(&permits).await;
        drop(body);
        assert_released(&permits).await;

        let permit = permits.download([1; 32]).await.unwrap();
        let mut body = content_response(content.clone(), "content-hash", 0, permit).into_body();
        let mut received = Vec::new();
        while let Some(frame) = body.frame().await {
            let chunk = frame.unwrap().into_data().unwrap();
            assert!(chunk.len() <= DOWNLOAD_CHUNK);
            received.extend_from_slice(&chunk);
        }
        assert_eq!(received, content);
        assert_released(&permits).await;
    }
}
