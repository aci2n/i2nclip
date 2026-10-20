//! Opaque bounded blob transport. Hashes address ciphertext, never plaintext.

use std::time::Duration;

use axum::{
    body::{Body, Bytes},
    extract::{Path, State},
    http::{header, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Router,
};
use serde::Deserialize;
use serde_bytes::ByteBuf;

use crate::{
    auth::SignedRequest,
    chain, codec,
    permits::TransferPermit,
    routes::{document_response, fail},
    AppState,
};

const MAX_UPLOAD_BODY: usize = chain::MAX_BLOB_BYTES + 64;
const UPLOAD_DEADLINE: Duration = Duration::from_secs(120);

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/blobs", post(upload))
        .route("/api/blobs/{file_id}/{hash}", get(download))
        .route("/api/quota", get(quota))
}

#[derive(Deserialize)]
struct Upload<'a>(
    #[serde(with = "serde_bytes", borrow)] &'a [u8],
    #[serde(with = "serde_bytes", borrow)] &'a [u8],
);

async fn upload(State(state): State<AppState>, request: SignedRequest) -> Response {
    if let Err(response) = request.check_size(MAX_UPLOAD_BODY) {
        return *response;
    }
    let _permit = match state.permits.upload(request.owner()).await {
        Ok(permit) => permit,
        Err(error) => return fail(error),
    };
    let (signer, bytes) = match request.read(MAX_UPLOAD_BODY, UPLOAD_DEADLINE).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let frame: Upload<'_> = match codec::decode(&bytes) {
        Ok(frame) => frame,
        Err(error) => return fail(error),
    };
    let file = match frame.0.try_into() {
        Ok(file) => file,
        Err(_) => return fail(crate::Error::BadRequest("invalid file ID".into())),
    };
    match state.db.stage_blob(signer, file, frame.1).await {
        Ok(hash) => document_response(StatusCode::OK, (ByteBuf::from(hash.to_vec()),)),
        Err(error) => fail(error),
    }
}

async fn download(
    State(state): State<AppState>,
    Path((file, hash)): Path<(String, String)>,
    request: SignedRequest,
) -> Response {
    let (file, hash) = match chain::parse_hash(&file)
        .and_then(|file| chain::parse_hash(&hash).map(|hash| (file, hash)))
    {
        Ok(ids) => ids,
        Err(error) => return fail(error),
    };
    let signer = match request.empty().await {
        Ok(signer) => signer,
        Err(response) => return *response,
    };
    let permit = match state.permits.download(signer).await {
        Ok(permit) => permit,
        Err(error) => return fail(error),
    };
    match state.db.read_blob(signer, file, hash).await {
        Ok(ciphertext) => ciphertext_response(ciphertext, permit),
        Err(error) => fail(error),
    }
}

fn ciphertext_response(ciphertext: Vec<u8>, permit: TransferPermit) -> Response {
    let length = ciphertext.len();
    let stream = futures_util::stream::unfold(
        (Bytes::from(ciphertext), permit),
        |(mut bytes, permit)| async move {
            if bytes.is_empty() {
                return None;
            }
            let chunk = bytes.split_to(bytes.len().min(64 * 1024));
            Some((Ok::<_, std::io::Error>(chunk), (bytes, permit)))
        },
    );
    let mut response = Body::from_stream(stream).into_response();
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );
    response
        .headers_mut()
        .insert(header::CONTENT_LENGTH, HeaderValue::from(length));
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, max-age=31536000, immutable"),
    );
    response
}

async fn quota(State(state): State<AppState>, request: SignedRequest) -> Response {
    let signer = match request.empty().await {
        Ok(signer) => signer,
        Err(response) => return *response,
    };
    let quota = match state.db.quota(signer).await {
        Ok(quota) => quota,
        Err(error) => return fail(error),
    };
    match state.db.log_bytes(signer).await {
        Ok(log_bytes) => document_response(
            StatusCode::OK,
            (
                quota.max_content_bytes,
                quota.max_files,
                quota.used_content_bytes,
                quota.file_count,
                log_bytes,
            ),
        ),
        Err(error) => fail(error),
    }
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

    #[tokio::test(start_paused = true)]
    async fn ciphertext_body_retains_admission_until_consumed_or_dropped() {
        let permits = Permits::new();
        let _other = permits.download([1; 32]).await.unwrap();
        let response =
            ciphertext_response(vec![3; 100_000], permits.download([1; 32]).await.unwrap());
        tokio::time::advance(Duration::from_secs(181)).await;
        let mut waiting = Box::pin(permits.download([1; 32]));
        assert!(poll_fn(|cx| Poll::Ready(waiting.as_mut().poll(cx)))
            .await
            .is_pending());
        drop(waiting);
        drop(response);
        let permit = permits.download([1; 32]).await.unwrap();
        let response = ciphertext_response(vec![3; 100_000], permit);
        assert_eq!(response.headers()[header::CONTENT_LENGTH], "100000");
        assert_eq!(
            response
                .into_body()
                .collect()
                .await
                .unwrap()
                .to_bytes()
                .len(),
            100_000
        );
        tokio::time::timeout(Duration::from_secs(1), permits.download([1; 32]))
            .await
            .unwrap()
            .unwrap();
    }
}
