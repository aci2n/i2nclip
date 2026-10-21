//! Public-key verification, request hashing, and exact request hashing.
//!
//! The server receives public keys and ciphertext, never an identity seed.
//! Reference chunk encryption and request
//! signing live in the test-only `reference_crypto` module. Shared vectors
//! check those reference operations against the JavaScript client.
//!
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use ed25519_dalek::{Signature, VerifyingKey};
use sha2::{Digest, Sha256};

use crate::Error;

/// Lowercase hex SHA-256 of `body`. The empty body has a hash too, so GET and
/// DELETE still commit to "no bytes".
pub fn body_hash(body: &[u8]) -> String {
    hex(&Sha256::digest(body))
}

/// The one signed message.
///
/// ```text
/// i2nclip-auth-v1\n
/// <origin, scheme and host, no path>\n
/// <unix seconds>\n
/// <nonce, already base64url>\n
/// <METHOD>\n
/// <path and query, exactly as sent>\n
/// <lowercase hex SHA-256 of the body>\n
/// ```
///
/// The body hash is sent in the header, so the server can check this signature
/// before it reads a body. After the body is in, the server hashes those bytes
/// and compares them to the hash inside this message. A different body does
/// not match, and a signature for GET cannot be reused as DELETE. The origin
/// is the configured public address, not the Host header. The trailing newline
/// is part of the message.
pub fn request_message(
    origin: &str,
    ts: u64,
    nonce: &str,
    method: &str,
    path_and_query: &str,
    body_hash: &str,
) -> String {
    format!("i2nclip-auth-v1\n{origin}\n{ts}\n{nonce}\n{method}\n{path_and_query}\n{body_hash}\n")
}

/// Strictly check an Ed25519 signature, including rejecting weak keys and
/// low-order signature points. Any failure is [`Error::Unauthorized`], so the
/// HTTP layer does not reveal whether the key was unknown or the signature was
/// merely wrong. Callers still check the allow-list themselves before this,
/// and map a missing key to the same error.
pub fn verify(public: &[u8; 32], message: &[u8], signature: &[u8]) -> Result<(), Error> {
    let key = VerifyingKey::from_bytes(public).map_err(|_| Error::Unauthorized)?;
    let signature = Signature::from_slice(signature).map_err(|_| Error::Unauthorized)?;
    key.verify_strict(message, &signature)
        .map_err(|_| Error::Unauthorized)
}

pub fn now_secs() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

pub fn b64url_decode(text: &str) -> Result<Vec<u8>, base64::DecodeError> {
    URL_SAFE_NO_PAD.decode(text)
}

fn hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

/// Hash without monopolizing an async worker on maximum-size transfers.
pub(crate) async fn body_hash_async(body: &[u8]) -> String {
    let mut hash = Sha256::new();
    for chunk in body.chunks(64 * 1024) {
        hash.update(chunk);
        tokio::task::yield_now().await;
    }
    hex(&hash.finalize())
}
pub(crate) fn body_hash_bytes(body: &[u8]) -> [u8; 32] {
    Sha256::digest(body).into()
}

#[cfg(test)]
mod tests {
    use serde::Serialize;

    use super::*;
    use crate::{codec, reference_crypto::*};

    #[test]
    fn signature_verification_rejects_weak_key_forgery() {
        let mut public = [0u8; 32];
        public[0] = 1; // Edwards identity point.
        let mut signature = [0u8; 64];
        signature[0] = 1; // R = identity, S = zero.
        let message = b"arbitrary request";
        // Ordinary verification accepts this without a signing secret.
        assert!(ed25519_dalek::Verifier::verify(
            &VerifyingKey::from_bytes(&public).unwrap(),
            message,
            &Signature::from_bytes(&signature),
        )
        .is_ok());
        assert!(matches!(
            verify(&public, message, &signature),
            Err(Error::Unauthorized)
        ));

        let id = from_seed([4u8; 32]);
        let mut valid = sign(&id.seed, message);
        assert!(verify(&id.public, message, &valid).is_ok());
        assert!(verify(&id.public, b"changed request", &valid).is_err());
        valid[0] ^= 1;
        assert!(verify(&id.public, message, &valid).is_err());
        assert!(verify(&id.public, message, &signature).is_err());
    }

    #[test]
    fn registration_key_roundtrips_and_signature_verifies() {
        let id = from_seed([4u8; 32]);
        let key = id.registration_key();
        let parsed = crate::auth::parse_public_key(&key).unwrap();
        assert_eq!(parsed, id.public);
        let hash = body_hash(b"hello");
        let request = request_message(
            "https://clip.example.com",
            1_700_000_000,
            "nonce",
            "GET",
            "/api/blocks",
            &hash,
        );
        let signature = sign(&id.seed, request.as_bytes());
        assert!(verify(&id.public, request.as_bytes(), &signature).is_ok());
        // A different body hash, or the same hash on a different method, does
        // not verify with this signature.
        let other_body = request_message(
            "https://clip.example.com",
            1_700_000_000,
            "nonce",
            "GET",
            "/api/blocks",
            &body_hash(b"other"),
        );
        assert!(verify(&id.public, other_body.as_bytes(), &signature).is_err());
        let other_method = request_message(
            "https://clip.example.com",
            1_700_000_000,
            "nonce",
            "DELETE",
            "/api/blocks",
            &hash,
        );
        assert!(verify(&id.public, other_method.as_bytes(), &signature).is_err());
    }

    /// Writes `client/tests/test-vectors.json` the first time, then checks it still
    /// matches. The JS tests read that file. Fixed inputs only, no randomness,
    /// so the file is stable.
    #[test]
    fn vectors_file_matches_javascript_client() {
        let seed = [0x11u8; 32];
        let id = from_seed(seed);
        let sign_nonce_raw = [0x22u8; 16];
        let sign_nonce = URL_SAFE_NO_PAD.encode(sign_nonce_raw);
        let sign_body = "hello";
        let sign_origin = "https://clip.example.com";
        let sign_body_hash = body_hash(sign_body.as_bytes());
        let request_text = request_message(
            sign_origin,
            1_700_000_000,
            &sign_nonce,
            "POST",
            "/api/blocks",
            &sign_body_hash,
        );
        let authorization = authorization(
            &id,
            sign_origin,
            1_700_000_000,
            &sign_nonce,
            "POST",
            "/api/blocks",
            sign_body.as_bytes(),
        );
        #[derive(Serialize)]
        struct PrivateKey<'a> {
            v: u8,
            #[serde(with = "serde_bytes")]
            seed: &'a [u8],
            #[serde(with = "serde_bytes")]
            public_key: &'a [u8],
        }
        let private_key_hex = hex(&codec::encode(&PrivateKey {
            v: 1,
            seed: &seed,
            public_key: &id.public,
        })
        .unwrap());
        let vectors = Vectors {
            chunk_v2: chunk_vectors(),
            private_key_hex,
            public_hex: hex(&id.public),
            public_key: id.registration_key(),
            sign_ts: 1_700_000_000,
            sign_nonce,
            sign_origin: sign_origin.to_string(),
            sign_method: "POST".to_string(),
            sign_path: "/api/blocks".to_string(),
            sign_body_utf8: sign_body.to_string(),
            request_text,
            body_hash: sign_body_hash,
            authorization,
        };
        let body = serde_json::to_string_pretty(&vectors).unwrap() + "\n";
        let path =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("client/tests/test-vectors.json");
        if !path.exists() {
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, &body).unwrap();
        }
        let existing = std::fs::read_to_string(&path).unwrap_or_default();
        assert_eq!(
            existing, body,
            "client/tests/test-vectors.json drifted; delete it and rerun this test"
        );
    }

    #[derive(Serialize)]
    struct Vectors {
        chunk_v2: serde_json::Value,
        private_key_hex: String,
        public_hex: String,
        public_key: String,
        sign_ts: u64,
        sign_nonce: String,
        sign_origin: String,
        sign_method: String,
        sign_path: String,
        sign_body_utf8: String,
        request_text: String,
        body_hash: String,
        authorization: String,
    }
}
