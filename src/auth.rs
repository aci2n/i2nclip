//! Request authentication.
//!
//! The client never sends the library identity. It sends:
//!
//! ```text
//! Authorization: Bearer <b64url(public key)>.<unix seconds>.<b64url(nonce)>.<hex body hash>.<b64url(signature)>
//! ```
//!
//! The signature covers the origin, time, nonce, method, path, and that body
//! hash. [`verify_request`] checks the allow-list, the clock, and the
//! signature, then remembers the nonce. No body byte is read until that
//! succeeds, so knowing a public key is not enough to make the server read a
//! payload. [`verify_body`] then hashes the bytes and compares them to the
//! hash from the header.
//!
//! A missing key and a bad signature both become 401. Malformed public keys
//! submitted for registration become 400.

use axum::http::HeaderMap;
use axum::http::Method;
use axum::http::Uri;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use ed25519_dalek::VerifyingKey;

use crate::crypto;
use crate::store::AppState;
use crate::Error;
use crate::SKEW_SECS;

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
    public: [u8; 32],
    body_hash: String,
}

struct Bearer {
    public: [u8; 32],
    ts: u64,
    nonce: String,
    body_hash: String,
    signature: [u8; 64],
}

/// Check the key, the clock, and the signature. Remember the nonce.
/// Callers must not read the body until this returns `Ok`.
pub(crate) fn verify_request(
    state: &AppState,
    method: &Method,
    uri: &Uri,
    headers: &HeaderMap,
) -> Result<VerifiedRequest, Error> {
    let bearer = parse_bearer(headers).ok_or(Error::Unauthorized)?;
    let now = crypto::now_secs();
    if bearer.ts.abs_diff(now) > SKEW_SECS {
        return Err(Error::Unauthorized);
    }
    let conn = state.lock()?;
    // Unknown key and bad signature both become 401, so the status line does not say which.
    if !crate::store::is_allowed_public_key(&conn, &bearer.public)? {
        return Err(Error::Unauthorized);
    }
    drop(conn);
    let request_message = crypto::request_message(
        state.origin(),
        bearer.ts,
        &bearer.nonce,
        method.as_str(),
        &path_and_query(uri),
        &bearer.body_hash,
    );
    crypto::verify(
        &bearer.public,
        request_message.as_bytes(),
        &bearer.signature,
    )?;
    // Spent here, before the body, so a captured header cannot be aimed at a
    // new payload. A body that does not match the signed hash still uses up
    // the nonce.
    let conn = state.lock()?;
    crate::store::remember_nonce(&conn, &bearer.nonce, bearer.ts)?;
    Ok(VerifiedRequest {
        public: bearer.public,
        body_hash: bearer.body_hash,
    })
}

/// Hash `body` and compare it to the digest the signature already committed to.
pub(crate) fn verify_body(verified: &VerifiedRequest, body: &[u8]) -> Result<[u8; 32], Error> {
    if crypto::body_hash(body) != verified.body_hash {
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
    let value = headers
        .get(axum::http::header::AUTHORIZATION)?
        .to_str()
        .ok()?;
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

    #[test]
    fn registration_requires_a_raw_canonical_public_key() {
        let id = crypto::from_seed([1u8; 32]);
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
