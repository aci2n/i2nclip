//! Cryptographic protocol shared with the JavaScript client.
//!
//! A library identity contains a random 32-byte Ed25519 seed and its public
//! key. The seed signs requests and derives separate encryption and tag keys
//! through HKDF-SHA256. The server receives only the public key and ciphertext.
//! `client/test-vectors.json` checks that both implementations agree.
//!
//! # Blob layout
//!
//! ```text
//! byte 0        version, always 1
//! bytes 1..13   12-byte nonce (random per encryption)
//! bytes 13..end AES-GCM ciphertext, with the 16-byte tag appended
//! ```
//!
//! AES-GCM is an authenticating cipher: decrypt fails if a single bit flips,
//! if the nonce is wrong, or if the "associated data" does not match. The
//! associated data is not encrypted and is not stored in the blob. We set it
//! to `i2nclip/v1 content <id>` or `i2nclip/v1 meta <id>`. Swapping two files
//! on disk, or storing a metadata blob where the content should be, makes
//! decrypt fail instead of returning someone else's picture under this name.
//!
//! The version byte is how the server rejects a raw JPEG (`FF D8 ...`) without
//! being able to decrypt. It is a tripwire for accidental plaintext, not a
//! proof that the rest of the blob is a valid ciphertext.

use aes_gcm::aead::Aead;
use aes_gcm::aead::Payload;
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use ed25519_dalek::Signature;
use ed25519_dalek::Signer;
use ed25519_dalek::SigningKey;
use ed25519_dalek::Verifier;
use ed25519_dalek::VerifyingKey;
use hkdf::Hkdf;
use hmac::Hmac;
use hmac::Mac;
use sha2::Digest;
use sha2::Sha256;
use unicode_normalization::UnicodeNormalization;

use crate::Error;

const VERSION: u8 = 1;
const NONCE_LEN: usize = 12;
const TAG_LEN: usize = 16;
/// Salt for HKDF. Both the Rust and JS clients must use these exact bytes.
const HKDF_SALT: &[u8] = b"i2nclip";

type HmacSha256 = Hmac<Sha256>;

/// A key pair derived from one 32-byte seed.
///
/// `seed` is the 32-byte secret in a library identity.
/// `public` is what the database stores. Debug is implemented by hand
/// so a log line cannot print the seed.
pub struct Identity {
    pub seed: [u8; 32],
    pub public: [u8; 32],
}

impl std::fmt::Debug for Identity {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // `write!` is like sprintf into the formatter. The public key is not
        // secret, but logging it in full is noisy, so Debug stays opaque.
        f.write_str("Identity")
    }
}

impl Identity {
    pub fn registration_key(&self) -> String {
        URL_SAFE_NO_PAD.encode(self.public)
    }
}

/// Construct a library identity from its secret seed.
pub fn from_seed(seed: [u8; 32]) -> Identity {
    let signing = SigningKey::from_bytes(&seed);
    let public = signing.verifying_key().to_bytes();
    Identity { seed, public }
}

/// Associated data for file bytes. `id` must be the exact lowercase UUID
/// string the client sends, because it is mixed into the auth tag.
pub fn content_aad(id: &str) -> Vec<u8> {
    format!("i2nclip/v1 content {id}").into_bytes()
}

/// Associated data for the encrypted metadata blob. Different text from
/// [`content_aad`] so the two ciphertexts are not interchangeable.
pub fn meta_aad(id: &str) -> Vec<u8> {
    format!("i2nclip/v1 meta {id}").into_bytes()
}

/// Encrypt `plaintext`. A fresh random nonce is chosen inside.
pub fn encrypt(seed: &[u8; 32], aad: &[u8], plaintext: &[u8]) -> Result<Vec<u8>, Error> {
    let mut nonce = [0u8; NONCE_LEN];
    getrandom::getrandom(&mut nonce).expect("operating system random source");
    encrypt_with_nonce(seed, aad, plaintext, &nonce)
}

/// Same as [`encrypt`], but the nonce is supplied. Tests use this so the
/// JavaScript client can be checked against exact bytes. Production callers
/// use [`encrypt`], because a repeated nonce under the same key breaks GCM.
pub fn encrypt_with_nonce(
    seed: &[u8; 32],
    aad: &[u8],
    plaintext: &[u8],
    nonce: &[u8; NONCE_LEN],
) -> Result<Vec<u8>, Error> {
    let key = derive_key(seed, b"enc");
    let cipher = Aes256Gcm::new_from_slice(&key).expect("AES-256 key is 32 bytes");
    // `Payload` carries the plaintext and the associated data together.
    // Only `msg` is encrypted. `aad` is authenticated and stays outside.
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(nonce),
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .map_err(|_| Error::Crypto)?;
    let mut out = Vec::with_capacity(1 + NONCE_LEN + ciphertext.len());
    out.push(VERSION);
    out.extend_from_slice(nonce);
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

/// Inverse of [`encrypt`]. Fails closed: wrong key, wrong id, or any tampering
/// all return [`Error::Crypto`] with no partial plaintext.
pub fn decrypt(seed: &[u8; 32], aad: &[u8], blob: &[u8]) -> Result<Vec<u8>, Error> {
    if !looks_sealed(blob, usize::MAX) {
        return Err(Error::Crypto);
    }
    let nonce = &blob[1..1 + NONCE_LEN];
    let ciphertext = &blob[1 + NONCE_LEN..];
    let key = derive_key(seed, b"enc");
    let cipher = Aes256Gcm::new_from_slice(&key).expect("AES-256 key is 32 bytes");
    cipher
        .decrypt(
            Nonce::from_slice(nonce),
            Payload {
                msg: ciphertext,
                aad,
            },
        )
        .map_err(|_| Error::Crypto)
}

/// True when `blob` is short enough and starts with version 1.
///
/// The server uses this to refuse an obvious raw file. It does not decrypt,
/// so a random string that happens to start with `0x01` still passes. That is
/// acceptable: an authorized client can already store anything in their own
/// folder of rows. The check exists so a JPEG is not written by mistake.
pub fn looks_sealed(blob: &[u8], max: usize) -> bool {
    blob.len() >= 1 + NONCE_LEN + TAG_LEN && blob.len() <= max && blob[0] == VERSION
}

/// Fingerprint of a tag. The server stores this string, never the word.
///
/// `HMAC-SHA256(tag_key, "tag\n" + normalized)`. The output is 32 bytes,
/// encoded as base64url with no `=` padding, which is always 43 characters.
/// The same key and the same word always produce the same token, so SQL can
/// compare them. A different owner key produces a different token, so one
/// person's search does not hit another person's rows.
///
/// Normalization is `trim`, then Unicode NFC, then lowercase. `Vacation` and
/// `vacation` match. The rules are the same in `client/crypto.js`.
pub fn tag_token(seed: &[u8; 32], tag: &str) -> Result<String, Error> {
    let normalized = normalize_tag(tag)?;
    let key = derive_key(seed, b"tag");
    // `new_from_slice` fails only if the key were empty, which it is not.
    let mut mac = <HmacSha256 as Mac>::new_from_slice(&key).expect("HMAC key");
    mac.update(b"tag\n");
    mac.update(normalized.as_bytes());
    Ok(URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes()))
}

/// Trim, NFC, lowercase. Rejects empty tags and anything with a comma or a
/// newline, because the upload form treats those as separators.
pub fn normalize_tag(tag: &str) -> Result<String, Error> {
    // `.nfc()` is an iterator over Unicode scalar values in composed form.
    // `.collect::<String>()` builds an owned String from that iterator.
    let text: String = tag.trim().nfc().collect();
    let text = text.to_lowercase();
    if text.is_empty() || text.chars().count() > 64 || text.contains(['\n', '\r', ',']) {
        return Err(Error::BadRequest("bad tag".into()));
    }
    Ok(text)
}

/// HKDF-SHA256. `info` is `b"enc"` or `b"tag"`.
///
/// HKDF is a standard way to turn one secret into several keys. The salt is
/// the ASCII bytes `i2nclip`. The "info" string is what makes the two outputs
/// different. 32 bytes is the AES-256 key size and a natural HMAC key size.
fn derive_key(seed: &[u8; 32], info: &[u8]) -> [u8; 32] {
    let hk = Hkdf::<Sha256>::new(Some(HKDF_SALT), seed);
    let mut out = [0u8; 32];
    // expand() only fails if you ask for more bytes than the hash allows
    // (for SHA-256 that limit is thousands of bytes). 32 cannot fail.
    hk.expand(info, &mut out)
        .expect("32-byte HKDF output is within the limit");
    out
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

/// Ed25519 signature over `message`. Deterministic: the same seed and the
/// same message always produce the same 64-byte signature.
pub fn sign(seed: &[u8; 32], message: &[u8]) -> [u8; 64] {
    let signing = SigningKey::from_bytes(seed);
    // `.sign` comes from the `Signer` trait, which is in scope above.
    // A trait is an interface. The method is only visible if the trait is imported.
    signing.sign(message).to_bytes()
}

/// Check an Ed25519 signature. Any failure is [`Error::Unauthorized`], so the
/// HTTP layer does not reveal whether the key was unknown or the signature was
/// merely wrong. Callers still check the allow-list themselves before this,
/// and map a missing key to the same error.
pub fn verify(public: &[u8; 32], message: &[u8], signature: &[u8]) -> Result<(), Error> {
    let key = VerifyingKey::from_bytes(public).map_err(|_| Error::Unauthorized)?;
    let signature = Signature::from_slice(signature).map_err(|_| Error::Unauthorized)?;
    key.verify(message, &signature)
        .map_err(|_| Error::Unauthorized)
}

/// `Authorization` header value, including the word `Bearer`.
///
/// ```text
/// Bearer <b64url(public key)>.<unix seconds>.<b64url(16-byte nonce)>.<hex body hash>.<b64url(signature)>
/// ```
///
/// base64url uses `-` and `_` instead of `+` and `/`, and we omit `=` padding.
/// The body hash is hex, so it has no `.` either. Splitting the token on dots
/// is safe. The hash is inside the signed message, which lets the server check
/// the signature before reading the body and then confirm the bytes match.
/// The nonce is inside that message, and the server remembers it until the
/// timestamp expires, so a captured header cannot be sent twice.
pub fn authorization(
    id: &Identity,
    origin: &str,
    ts: u64,
    nonce_b64: &str,
    method: &str,
    path_and_query: &str,
    body: &[u8],
) -> String {
    let hash = body_hash(body);
    let request = request_message(origin, ts, nonce_b64, method, path_and_query, &hash);
    let signature = sign(&id.seed, request.as_bytes());
    format!(
        "Bearer {}.{ts}.{nonce_b64}.{hash}.{}",
        URL_SAFE_NO_PAD.encode(id.public),
        URL_SAFE_NO_PAD.encode(signature)
    )
}

/// 16 random bytes, base64url, no padding. This is the nonce string that goes
/// both in the header and inside the signed message.
pub fn fresh_nonce() -> String {
    let mut raw = [0u8; 16];
    getrandom::getrandom(&mut raw).expect("operating system random source");
    URL_SAFE_NO_PAD.encode(raw)
}

pub fn now_secs() -> u64 {
    use std::time::SystemTime;
    use std::time::UNIX_EPOCH;
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

pub fn b64url_decode(text: &str) -> Result<Vec<u8>, ()> {
    URL_SAFE_NO_PAD.decode(text).map_err(|_| ())
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
    use serde::Serialize;

    #[test]
    fn roundtrip_rejects_wrong_key_aad_and_tamper() {
        let id = from_seed([9u8; 32]);
        let plain = b"i2nclip-plaintext-marker-9f3c";
        let aad = content_aad("11111111-1111-4111-8111-111111111111");
        let mut blob = encrypt(&id.seed, &aad, plain).unwrap();
        // The plaintext bytes must not appear as a contiguous slice. This is
        // the property the HTTP tests also check on disk.
        assert!(!blob.windows(plain.len()).any(|window| window == plain));
        assert_eq!(decrypt(&id.seed, &aad, &blob).unwrap(), plain);
        assert!(decrypt(&id.seed, &meta_aad("11111111-1111-4111-8111-111111111111"), &blob).is_err());
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

    /// Writes `client/test-vectors.json` the first time, then checks it still
    /// matches. The JS tests read that file. Fixed inputs only, no randomness,
    /// so the file is stable.
    #[test]
    fn vectors_file_matches_javascript_client() {
        let seed = [0x11u8; 32];
        let id = from_seed(seed);
        let nonce = [0u8, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
        let media_id = "11111111-1111-4111-8111-111111111111";
        let aad = content_aad(media_id);
        let plain = b"PLAINTEXT-MARKER-i2nclip";
        let ciphertext = encrypt_with_nonce(&seed, &aad, plain, &nonce).unwrap();
        let meta_json = r#"{"name":"vacation-photo.jpg","content_type":"image/jpeg","size":12,"tags":["vacation","dog"],"image":{"width":32,"height":16,"taken_at":"2020:01:02 03:04:05","make":"Canon"}}"#;
        let meta_aad = meta_aad(media_id);
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
        let frame = crate::frame::encode_post(media_id, &meta_ct, &ciphertext, &token);
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
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("client/test-vectors.json");
        if !path.exists() {
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, &body).unwrap();
        }
        let existing = std::fs::read_to_string(&path).unwrap_or_default();
        assert_eq!(
            existing, body,
            "client/test-vectors.json drifted; delete it and rerun this test"
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
