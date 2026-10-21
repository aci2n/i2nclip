//! Bounded chain transport. Private file semantics are exclusively client-owned.

use axum::{extract::State, http::StatusCode, response::Response, routing::get, Router};

use crate::{
    auth::ProofRequest,
    chain::{self, Hash},
    routes::{document_response, fail, SHORT_BODY_DEADLINE},
    AppState, Error,
};

pub(crate) fn router() -> Router<AppState> {
    Router::new().route("/api/blocks", get(page).post(append))
}

async fn append(State(state): State<AppState>, ProofRequest(request): ProofRequest) -> Response {
    if let Err(response) = request.check_size(chain::MAX_BLOCK_BYTES) {
        return *response;
    }
    let _permit = match state.permits.upload(request.owner()).await {
        Ok(permit) => permit,
        Err(error) => return fail(error),
    };
    let (signer, bytes) = match request
        .read(chain::MAX_BLOCK_BYTES, SHORT_BODY_DEADLINE)
        .await
    {
        Ok(value) => value,
        Err(response) => return *response,
    };
    match state.db.append_record(signer, &bytes).await {
        Ok(receipt) => document_response(StatusCode::OK, receipt),
        Err(error) => fail(error),
    }
}

fn page_query(query: Option<&str>) -> Result<(Hash, Option<Hash>), Error> {
    let mut after = None;
    let mut until = None;
    for (name, value) in url::form_urlencoded::parse(query.unwrap_or_default().as_bytes()) {
        match name.as_ref() {
            "after" if after.is_none() => after = Some(chain::parse_hash(&value)?),
            "until" if until.is_none() => until = Some(chain::parse_hash(&value)?),
            _ => return Err(Error::BadRequest("invalid block page query".into())),
        }
    }
    Ok((
        after.ok_or_else(|| Error::BadRequest("after is required".into()))?,
        until,
    ))
}

async fn page(State(state): State<AppState>, ProofRequest(request): ProofRequest) -> Response {
    let (after, until) = match page_query(request.query()) {
        Ok(query) => query,
        Err(error) => return fail(error),
    };
    let signer = match request.empty().await {
        Ok(signer) => signer,
        Err(response) => return *response,
    };
    let _permit = match state.permits.download(signer).await {
        Ok(permit) => permit,
        Err(error) => return fail(error),
    };
    match state.db.block_page(signer, after, until).await {
        Ok(page) => document_response(StatusCode::OK, page),
        Err(error) => fail(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn page_queries_require_explicit_unambiguous_anchors() {
        let hash = "01".repeat(32);
        assert!(page_query(Some(&format!("after={hash}"))).is_ok());
        assert!(page_query(Some(&format!("after={hash}&until={hash}"))).is_ok());
        for query in [None, Some("after=bad"), Some("unknown=1")] {
            assert!(page_query(query).is_err());
        }
        assert!(page_query(Some(&format!("after={hash}&after={hash}"))).is_err());
    }
}
