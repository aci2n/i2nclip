//! Request authentication.
//!
//! The client never sends the library identity. It sends:
//!
//! ```text
//! Authorization: Bearer <b64url(public key)>.<unix seconds>.<b64url(nonce)>.<hex body hash>.<b64url(signature)>
//! ```
//!
//! The signature covers the origin, time, nonce, method, path, and that body
//! hash. [`verify_request`] checks the clock and signature, plus library
//! registration for ordinary requests, then remembers the nonce. Only
//! registration defers admission until invitation validation; ordinary
//! requests require a registered library signing key. No body byte is read until that
//! succeeds, so knowing a public key is not enough to make the server read a
//! payload. [`verify_body`] then hashes the bytes and compares them to the
//! hash from the header.
//!
//! A missing key, malformed signer key, and a bad signature become 401.

use std::time::Duration;

use axum::{
    body::Body,
    extract::{FromRequest, Request},
    http::{header, request::Parts, HeaderMap, Method, Uri},
    response::Response,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use ed25519_dalek::VerifyingKey;
use tokio::sync::OwnedSemaphorePermit;

use crate::{
    crypto,
    routes::{fail, read_body_with_deadline, too_large, SHORT_BODY_DEADLINE},
    AppState, Error, SKEW_SECS,
};

/// Header-authenticated request. Direct extraction also requires a registered key.
/// RegistrationRequest wraps this value without the library lookup, retaining a
/// separate registration admission guard. Endpoint handlers own body/query
/// policy; the body hash is checked on reading.
pub(crate) struct SignedRequest {
    verified: VerifiedRequest,
    parts: Parts,
    body: Body,
}

impl FromRequest<AppState> for SignedRequest {
    type Rejection = Response;

    async fn from_request(req: Request, state: &AppState) -> Result<Self, Self::Rejection> {
        authenticate_request(req, state, KeyPolicy::Registered)
            .await
            .map_err(fail)
    }
}

/// A verified key holder whose invitation and genesis are checked after reading the body.
pub(crate) struct RegistrationRequest(pub(crate) SignedRequest, pub(crate) OwnedSemaphorePermit);

impl FromRequest<AppState> for RegistrationRequest {
    type Rejection = Response;

    async fn from_request(req: Request, state: &AppState) -> Result<Self, Self::Rejection> {
        let permit = state.permits.try_registration().map_err(fail)?;
        let request = authenticate_request(req, state, KeyPolicy::Registration)
            .await
            .map_err(fail)?;
        Ok(Self(request, permit))
    }
}

async fn authenticate_request(
    req: Request,
    state: &AppState,
    policy: KeyPolicy,
) -> Result<SignedRequest, Error> {
    let (parts, body) = req.into_parts();
    let verified = verify_request(state, &parts.method, &parts.uri, &parts.headers, policy).await?;
    Ok(SignedRequest {
        verified,
        parts,
        body,
    })
}

impl SignedRequest {
    pub(crate) fn registration_proof(&self) -> (String, u64) {
        (self.verified.nonce.clone(), self.verified.ts)
    }
    pub(crate) fn owner(&self) -> [u8; 32] {
        self.verified.owner()
    }
    pub(crate) fn query(&self) -> Option<&str> {
        self.parts.uri.query()
    }

    pub(crate) fn check_size(&self, max: usize) -> Result<(), Box<Response>> {
        if self
            .parts
            .headers
            .get(header::CONTENT_LENGTH)
            .and_then(|value| value.to_str().ok())
            .and_then(|text| text.parse::<usize>().ok())
            .is_some_and(|len| len > max)
        {
            return Err(Box::new(too_large()));
        }
        Ok(())
    }

    pub(crate) async fn read(
        self,
        max: usize,
        deadline: Duration,
    ) -> Result<([u8; 32], Vec<u8>), Box<Response>> {
        let bytes = read_body_with_deadline(self.body, max, deadline).await?;
        let owner = match verify_body(&self.verified, &bytes).await {
            Ok(owner) => owner,
            Err(error @ Error::Unauthorized) => {
                tracing::debug!(
                    method = %self.parts.method,
                    path = %self.parts.uri.path(),
                    reason = "body_hash_mismatch",
                    "request rejected as unauthorized"
                );
                return Err(Box::new(fail(error)));
            }
            Err(error) => return Err(Box::new(fail(error))),
        };
        Ok((owner, bytes))
    }

    pub(crate) async fn empty(self) -> Result<[u8; 32], Box<Response>> {
        self.check_size(0)?;
        let (owner, _) = self.read(0, SHORT_BODY_DEADLINE).await?;
        Ok(owner)
    }
}

/// Registration requires a canonical base64url key encoding and a valid,
/// non-weak Ed25519 point. Reject it before consuming the invitation.
pub(crate) fn parse_public_key(text: &str) -> Result<[u8; 32], Error> {
    let bytes =
        crypto::b64url_decode(text).map_err(|_| Error::BadRequest("invalid public_key".into()))?;
    let public: [u8; 32] = bytes
        .try_into()
        .map_err(|_| Error::BadRequest("public_key must contain 32 bytes".into()))?;
    if URL_SAFE_NO_PAD.encode(public) != text {
        return Err(Error::BadRequest("invalid public_key".into()));
    }
    validate_public_key(&public)
}

pub(crate) fn validate_public_key(bytes: &[u8]) -> Result<[u8; 32], Error> {
    let public: [u8; 32] = bytes
        .try_into()
        .map_err(|_| Error::BadRequest("public_key must contain 32 bytes".into()))?;
    let key = VerifyingKey::from_bytes(&public)
        .map_err(|_| Error::BadRequest("invalid public_key".into()))?;
    if key.is_weak() {
        return Err(Error::BadRequest("invalid public_key".into()));
    }
    Ok(public)
}

/// A request whose signature has already been checked. `body_hash` is the
/// hex digest the client put in the header and inside the signed message.
/// The body itself has not been read yet.
pub(crate) struct VerifiedRequest {
    nonce: String,
    ts: u64,
    public: [u8; 32],
    body_hash: String,
}

impl VerifiedRequest {
    /// Header-authenticated owner, available before reading the signed body.
    pub(crate) fn owner(&self) -> [u8; 32] {
        self.public
    }
}

struct Bearer {
    public: [u8; 32],
    ts: u64,
    nonce: String,
    body_hash: String,
    signature: [u8; 64],
}

/// Validate against one clock sample, also used for nonce expiration cleanup.
pub(crate) fn check_timestamp(ts: u64, now: u64) -> Result<(), Error> {
    if ts.abs_diff(now) > SKEW_SECS {
        return Err(Error::Unauthorized);
    }
    Ok(())
}

/// Registration defers the library lookup and nonce until its body is validated.
enum KeyPolicy {
    Registered,
    Registration,
}

/// Check the key, the clock, and the signature. Remember the nonce.
/// Callers must not read the body until this returns `Ok`.
async fn verify_request(
    state: &AppState,
    method: &Method,
    uri: &Uri,
    headers: &HeaderMap,
    policy: KeyPolicy,
) -> Result<VerifiedRequest, Error> {
    // Early data can be replayed, but authentication consumes a single-use
    // nonce even for GET. Reject before reserving it so the client can retry
    // after the handshake with the same signed request (RFC 8470).
    if headers.contains_key("early-data") {
        tracing::debug!(
            method = %method,
            path = %uri.path(),
            reason = "early_data",
            "request rejected as too early"
        );
        return Err(Error::TooEarly);
    }
    let Some(bearer) = parse_bearer(headers) else {
        tracing::debug!(
            method = %method,
            path = %uri.path(),
            reason = "malformed_authorization",
            "request rejected as unauthorized"
        );
        return Err(Error::Unauthorized);
    };
    let now = crypto::now_secs();
    if check_timestamp(bearer.ts, now).is_err() {
        tracing::debug!(
            method = %method,
            path = %uri.path(),
            reason = "timestamp_out_of_window",
            client_ts = bearer.ts,
            server_ts = now,
            skew_secs = bearer.ts.abs_diff(now),
            allowed_skew_secs = SKEW_SECS,
            "request rejected as unauthorized"
        );
        return Err(Error::Unauthorized);
    }
    if matches!(policy, KeyPolicy::Registered) && !state.db.allowed(&bearer.public).await? {
        tracing::debug!(
            method = %method,
            path = %uri.path(),
            reason = "public_key_not_registered",
            "request rejected as unauthorized"
        );
        return Err(Error::Unauthorized);
    }
    let request_message = crypto::request_message(
        state.origin(),
        bearer.ts,
        &bearer.nonce,
        method.as_str(),
        &path_and_query(uri),
        &bearer.body_hash,
    );
    if crypto::verify(
        &bearer.public,
        request_message.as_bytes(),
        &bearer.signature,
    )
    .is_err()
    {
        tracing::debug!(
            method = %method,
            path = %uri.path(),
            reason = "signature_verification_failed",
            "request rejected as unauthorized"
        );
        return Err(Error::Unauthorized);
    }
    // Spent here, before the body, so a captured header cannot be aimed at a
    // new payload. A body that does not match the signed hash still uses up
    // the nonce.
    if matches!(policy, KeyPolicy::Registered) {
        match state.db.remember_nonce(&bearer.nonce, bearer.ts).await {
            Ok(()) => {}
            Err(Error::Unauthorized) => {
                tracing::debug!(
                    method = %method,
                    path = %uri.path(),
                    reason = "nonce_replay",
                    "request rejected as unauthorized"
                );
                return Err(Error::Unauthorized);
            }
            Err(error) => return Err(error),
        }
    }
    // A request can pass the first check, stall before reserving its nonce,
    // then resume after a legitimate copy's nonce has expired and maintenance
    // has deleted it. Recheck after insertion so that delayed replay cannot
    // proceed just because the old nonce row was cleaned up.
    let now = crypto::now_secs();
    if check_timestamp(bearer.ts, now).is_err() {
        tracing::debug!(
            method = %method,
            path = %uri.path(),
            reason = "timestamp_expired_while_waiting",
            client_ts = bearer.ts,
            server_ts = now,
            skew_secs = bearer.ts.abs_diff(now),
            allowed_skew_secs = SKEW_SECS,
            "request rejected as unauthorized"
        );
        return Err(Error::Unauthorized);
    }
    Ok(VerifiedRequest {
        nonce: bearer.nonce,
        ts: bearer.ts,
        public: bearer.public,
        body_hash: bearer.body_hash,
    })
}

/// Hash `body` and compare it to the digest the signature already committed to.
pub(crate) async fn verify_body(
    verified: &VerifiedRequest,
    body: &[u8],
) -> Result<[u8; 32], Error> {
    if crypto::body_hash_async(body).await != verified.body_hash {
        return Err(Error::Unauthorized);
    }
    Ok(verified.public)
}

fn path_and_query(uri: &Uri) -> String {
    // `path_and_query` keeps the request target exactly as it arrived,
    // including `?tag=...` in the order the client signed.
    match uri.path_and_query() {
        Some(value) => value.as_str().to_string(),
        None => uri.path().to_string(),
    }
}

/// Split the bearer token. `None` means the header is missing or malformed,
/// which the caller turns into 401.
fn parse_bearer(headers: &HeaderMap) -> Option<Bearer> {
    let value = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let mut parts = value.trim().splitn(2, char::is_whitespace);
    let scheme = parts.next().unwrap_or("");
    let token = parts.next().unwrap_or("").trim();
    if !scheme.eq_ignore_ascii_case("bearer") || token.is_empty() {
        return None;
    }
    let mut bits = token.split('.');
    let public_b64 = bits.next()?;
    let ts_text = bits.next()?;
    let nonce = bits.next()?;
    let body_hash = bits.next()?;
    let sig_b64 = bits.next()?;
    if bits.next().is_some() {
        return None;
    }
    if body_hash.len() != 64
        || !body_hash
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        return None;
    }
    let public = crypto::b64url_decode(public_b64).ok()?;
    if public.len() != 32 {
        return None;
    }
    let mut public_key = [0u8; 32];
    public_key.copy_from_slice(&public);
    let ts: u64 = ts_text.parse().ok()?;
    let nonce_raw = crypto::b64url_decode(nonce).ok()?;
    if nonce_raw.len() != 16 {
        return None;
    }
    let signature = decode_sig(sig_b64)?;
    // Keep the nonce and the hash exactly as signed, not a re-encoding.
    Some(Bearer {
        public: public_key,
        ts,
        nonce: nonce.to_string(),
        body_hash: body_hash.to_string(),
        signature,
    })
}

fn decode_sig(text: &str) -> Option<[u8; 64]> {
    let bytes = crypto::b64url_decode(text).ok()?;
    if bytes.len() != 64 {
        return None;
    }
    let mut sig = [0u8; 64];
    sig.copy_from_slice(&bytes);
    Some(sig)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::reference_crypto as client_crypto;

    #[tokio::test]
    async fn early_data_is_rejected_before_authentication_without_database_access() {
        let state = AppState::new(
            crate::db::Database::closed_for_test().await,
            "http://i2nclip.test".into(),
        );
        let method = Method::GET;
        let uri = Uri::from_static("/api/blocks");
        let key = client_crypto::from_seed([1u8; 32]);
        let authorization = client_crypto::authorization(
            &key,
            state.origin(),
            crypto::now_secs(),
            &URL_SAFE_NO_PAD.encode([2u8; 16]),
            method.as_str(),
            uri.path(),
            &[],
        );

        // Presence is sufficient, including malformed and duplicate values.
        for values in [vec!["1"], vec![""], vec!["invalid"], vec!["1", "1"]] {
            for bearer in [None, Some(authorization.as_str())] {
                let mut headers = HeaderMap::new();
                for value in &values {
                    headers.append("early-data", value.parse().unwrap());
                }
                if let Some(bearer) = bearer {
                    headers.insert("authorization", bearer.parse().unwrap());
                }
                let error =
                    match verify_request(&state, &method, &uri, &headers, KeyPolicy::Registered)
                        .await
                    {
                        Err(error) => error,
                        Ok(_) => panic!("early data must be rejected"),
                    };
                assert!(matches!(error, Error::TooEarly));
                let response = fail(error);
                assert_eq!(response.status(), axum::http::StatusCode::TOO_EARLY);
            }
        }

        // Without early data, this valid bearer reaches the closed pool.
        let mut headers = HeaderMap::new();
        headers.insert("authorization", authorization.parse().unwrap());
        assert!(matches!(
            verify_request(&state, &method, &uri, &headers, KeyPolicy::Registered).await,
            Err(Error::Db(sqlx::Error::PoolClosed))
        ));
    }

    #[test]
    fn timestamp_check_rejects_requests_that_expire_while_waiting() {
        let ts = 1_000;
        assert!(check_timestamp(ts, ts + SKEW_SECS).is_ok());
        assert!(matches!(
            check_timestamp(ts, ts + SKEW_SECS + 1),
            Err(Error::Unauthorized)
        ));
        assert!(check_timestamp(ts + SKEW_SECS, ts).is_ok());
        assert!(matches!(
            check_timestamp(ts + SKEW_SECS + 1, ts),
            Err(Error::Unauthorized)
        ));
    }

    #[test]
    fn registration_requires_a_raw_canonical_public_key() {
        let id = client_crypto::from_seed([1u8; 32]);
        assert_eq!(parse_public_key(&id.registration_key()).unwrap(), id.public);
        for text in ["", "AAAA", "not a key"] {
            assert!(parse_public_key(text).is_err());
        }
        assert!(parse_public_key(&(id.registration_key() + "=")).is_err());
    }

    #[test]
    fn registration_rejects_weak_and_invalid_points() {
        let mut identity = [0u8; 32];
        identity[0] = 1;
        // y = 0 is another low-order point.
        for public in [identity, [0u8; 32]] {
            assert!(VerifyingKey::from_bytes(&public).unwrap().is_weak());
            assert!(matches!(
                parse_public_key(&URL_SAFE_NO_PAD.encode(public)),
                Err(Error::BadRequest(message)) if message == "invalid public_key"
            ));
        }
        let invalid = [2u8; 32];
        assert!(VerifyingKey::from_bytes(&invalid).is_err());
        assert!(matches!(
            parse_public_key(&URL_SAFE_NO_PAD.encode(invalid)),
            Err(Error::BadRequest(message)) if message == "invalid public_key"
        ));
    }
}
