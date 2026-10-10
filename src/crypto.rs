//! Public-key verification, request hashing, and sealed-blob shape checks.
//!
//! The server receives public keys and ciphertext, never an identity seed.
//! Encryption, decryption, key derivation, tag normalization, and request
//! signing live in the test-only `reference_crypto` module. Shared vectors
//! check those reference operations against the JavaScript client.
//!
//! Sealed blobs contain version 1, a 12-byte nonce, and ciphertext with a
//! 16-byte GCM tag. Shape checks reject accidental plaintext; they do not
//! authenticate ciphertext or prove it can be decrypted.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use ed25519_dalek::{Signature, VerifyingKey};
use sha2::{Digest, Sha256};

use crate::Error;

const VERSION: u8 = 1;
const NONCE_LEN: usize = 12;
const TAG_LEN: usize = 16;

/// True when `blob` is short enough and starts with version 1.
///
/// The server uses this to refuse an obvious raw file. It does not decrypt,
/// so a random string that happens to start with `0x01` still passes. That is
/// acceptable: an authorized client can already store anything in their own
/// folder of rows. The check exists so a JPEG is not written by mistake.
pub fn looks_sealed(blob: &[u8], max: usize) -> bool {
    blob.len() >= 1 + NONCE_LEN + TAG_LEN && blob.len() <= max && blob[0] == VERSION
}

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
    use std::time::SystemTime;
    use std::time::UNIX_EPOCH;
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::reference_crypto::*;
    use serde::Serialize;

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
    fn roundtrip_rejects_wrong_key_aad_and_tamper() {
        let id = from_seed([9u8; 32]);
        let plain = b"i2nclip-plaintext-marker-9f3c";
        let aad = content_aad();
        let mut blob = encrypt(&id.seed, &aad, plain).unwrap();
        // The plaintext bytes must not appear as a contiguous slice. This is
        // the property the HTTP tests also check on disk.
        assert!(!blob.windows(plain.len()).any(|window| window == plain));
        assert_eq!(decrypt(&id.seed, &aad, &blob).unwrap(), plain);
        assert!(decrypt(
            &id.seed,
            &meta_aad("11111111-1111-4111-8111-111111111111"),
            &blob
        )
        .is_err());
        assert!(decrypt(&[8u8; 32], &aad, &blob).is_err());
        blob[20] ^= 0x01;
        assert!(decrypt(&id.seed, &aad, &blob).is_err());
        assert!(!looks_sealed(b"\xff\xd8\xff", 100));
        assert!(!looks_sealed(b"short", 100));
    }

    #[test]
    fn tag_tokens_fold_case_and_follow_the_key() {
        let a = from_seed([1u8; 32]);
        let b = from_seed([2u8; 32]);
        let left = tag_token(&a.seed, " Vacation ").unwrap();
        let right = tag_token(&a.seed, "vacation").unwrap();
        assert_eq!(left, right);
        assert_eq!(left.len(), 43);
        assert_ne!(left, tag_token(&b.seed, "vacation").unwrap());
        // NFC: e + combining acute, versus the single code point é.
        let composed = tag_token(&a.seed, "Café").unwrap();
        let decomposed = tag_token(&a.seed, "Cafe\u{0301}").unwrap();
        assert_eq!(composed, decomposed);
        assert!(tag_token(&a.seed, "   ").is_err());
        assert!(tag_token(&a.seed, "a,b").is_err());
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
            "/api/media",
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
            "/api/media",
            &body_hash(b"other"),
        );
        assert!(verify(&id.public, other_body.as_bytes(), &signature).is_err());
        let other_method = request_message(
            "https://clip.example.com",
            1_700_000_000,
            "nonce",
            "DELETE",
            "/api/media",
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
        let nonce = [0u8, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
        let aad = content_aad();
        let plain = b"PLAINTEXT-MARKER-i2nclip";
        let ciphertext = encrypt_with_nonce(&seed, &aad, plain, &nonce).unwrap();
        let media_id = body_hash(&ciphertext);
        let meta_json = r#"{"name":"vacation-photo.jpg","content_type":"image/jpeg","size":12,"tags":["vacation","dog"],"image":{"width":32,"height":16,"taken_at":"2020:01:02 03:04:05","make":"Canon"}}"#;
        let meta_aad = meta_aad(&media_id);
        let meta_ct = encrypt_with_nonce(&seed, &meta_aad, meta_json.as_bytes(), &nonce).unwrap();
        let token = tag_token(&seed, "Vacation").unwrap();
        let cafe = tag_token(&seed, "Café").unwrap();
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
            "/api/media",
            &sign_body_hash,
        );
        let authorization = authorization(
            &id,
            sign_origin,
            1_700_000_000,
            &sign_nonce,
            "POST",
            "/api/media",
            sign_body.as_bytes(),
        );
        let frame = crate::frame::encode_post(&meta_ct, &ciphertext, &token);
        let private_key = serde_json::json!({ "v": 1, "seed": URL_SAFE_NO_PAD.encode(seed), "publicKey": id.registration_key() }).to_string();
        let vectors = Vectors {
            private_key,
            public_hex: hex(&id.public),
            public_key: id.registration_key(),
            tag: "Vacation".to_string(),
            token,
            cafe_tag: "Café".to_string(),
            cafe_token: cafe,
            media_id: media_id.to_string(),
            nonce_hex: hex(&nonce),
            aad: String::from_utf8(aad).unwrap(),
            meta_aad: String::from_utf8(meta_aad).unwrap(),
            plaintext_utf8: String::from_utf8(plain.to_vec()).unwrap(),
            ciphertext_hex: hex(&ciphertext),
            meta_json: meta_json.to_string(),
            meta_ciphertext_hex: hex(&meta_ct),
            frame_hex: hex(&frame),
            sign_ts: 1_700_000_000,
            sign_nonce,
            sign_origin: sign_origin.to_string(),
            sign_method: "POST".to_string(),
            sign_path: "/api/media".to_string(),
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
        private_key: String,
        public_hex: String,
        public_key: String,
        tag: String,
        token: String,
        cafe_tag: String,
        cafe_token: String,
        media_id: String,
        nonce_hex: String,
        aad: String,
        meta_aad: String,
        plaintext_utf8: String,
        ciphertext_hex: String,
        meta_json: String,
        meta_ciphertext_hex: String,
        frame_hex: String,
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
