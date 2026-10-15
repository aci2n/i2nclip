//! Media endpoints and authenticated request policy.
//!
//! Signature checks precede body limits, upload admission, reading, and hashing.
//! Buffered upload bodies retain their permits through database writes.

use std::time::Duration;

use axum::{
    body::{Body, Bytes},
    extract::{Path as UrlPath, State},
    http::{header, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, put},
    Router,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use serde_json::json;

use crate::{
    auth::SignedRequest,
    db::{Item, MetadataUpdate},
    frame,
    permits::TransferPermit,
    routes::{empty, fail, json_response},
    AppState, Error, MAX_BODY, MAX_META_BODY,
};

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/quota", get(quota))
        .route("/api/media", get(list).post(upload))
        .route("/api/media/{id}", get(download).delete(remove))
        .route("/api/media/{id}/meta", put(update_metadata))
}

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

async fn quota(State(state): State<AppState>, media: SignedRequest) -> Response {
    let owner = match media.empty().await {
        Ok(owner) => owner,
        Err(response) => return *response,
    };
    match state.db.quota(owner).await {
        Ok(quota) => json_response(StatusCode::OK, quota),
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
        Ok((items, next)) => json_response(
            StatusCode::OK,
            json!({ "media": items_json(items), "next": next }),
        ),
        Err(err) => fail(err),
    }
}

async fn upload(State(state): State<AppState>, media: SignedRequest) -> Response {
    if let Err(response) = media.check_size(MAX_BODY) {
        return *response;
    }
    let permit = match state.permits.upload(media.owner()).await {
        Ok(permit) => permit,
        Err(error) => return fail(error),
    };
    let (owner, body) = match media.read(MAX_BODY, UPLOAD_BODY_DEADLINE).await {
        Ok(body) => body,
        Err(response) => return *response,
    };
    let body = BufferedBody {
        bytes: body,
        _upload_permit: permit,
    };
    match state.db.add(owner, &body.bytes).await {
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
    match state.db.content(owner, &id).await {
        Ok(content) => content_response(content, permit),
        Err(err) => fail(err),
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
        Ok(MetadataUpdate::Updated(item)) => json_response(StatusCode::OK, item_json(item)),
        Ok(MetadataUpdate::Conflict(item)) => json_response(
            StatusCode::CONFLICT,
            json!({
                "error": "metadata changed in another page",
                "code": "metadata_conflict",
                "media": item_json(item),
            }),
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

fn content_response(content: Vec<u8>, permit: TransferPermit) -> Response {
    let bytes = content.len() as u64;
    let stream = futures_util::stream::unfold(
        (Bytes::from(content), permit),
        |(mut content, permit)| async move {
            if content.is_empty() {
                return None;
            }
            let chunk = content.split_to(content.len().min(DOWNLOAD_CHUNK));
            Some((Ok::<_, std::io::Error>(chunk), (content, permit)))
        },
    );
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

#[cfg(test)]
mod tests {
    use std::{
        future::{poll_fn, Future},
        task::Poll,
    };

    use http_body_util::BodyExt;

    use super::*;
    use crate::permits::Permits;

    #[test]
    fn list_query_validates_cursor_and_deduplicates_tags_without_database() {
        assert_eq!(list_query(None).unwrap(), (vec![], None));
        let token = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([1_u8; 32]);
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
        let response = content_response(content.clone(), permit);
        assert_eq!(
            response.headers()[header::CONTENT_LENGTH],
            content.len().to_string()
        );
        assert_held(&permits).await;
        drop(response);
        assert_released(&permits).await;

        let permit = permits.download([1; 32]).await.unwrap();
        let mut body = content_response(content.clone(), permit).into_body();
        let first = body.frame().await.unwrap().unwrap().into_data().unwrap();
        assert_eq!(first.len(), DOWNLOAD_CHUNK);
        assert_held(&permits).await;
        drop(body);
        assert_released(&permits).await;

        let permit = permits.download([1; 32]).await.unwrap();
        let mut body = content_response(content.clone(), permit).into_body();
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
