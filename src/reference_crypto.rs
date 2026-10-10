//! Reference-client cryptography for Rust tests and shared JavaScript vectors.
//! This module is not compiled into the production library or server.

use aes_gcm::aead::{Aead, Payload};
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use ed25519_dalek::{Signer, SigningKey};
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use sha2::Sha256;
use unicode_normalization::UnicodeNormalization;

use crate::crypto::{body_hash, looks_sealed, request_message};
use crate::Error;

const VERSION: u8 = 1;
const NONCE_LEN: usize = 12;
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

/// Content AAD is fixed: its ciphertext hash is computed after encryption.
pub fn content_aad() -> Vec<u8> {
    b"i2nclip/v1 content".to_vec()
}

/// Bind metadata to the complete sealed-content hash, with domain separation.
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
/// JavaScript client can be checked against exact bytes. Randomized test uploads
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

/// Fingerprint of a tag. The server stores this string, never the word.
///
/// `HMAC-SHA256(tag_key, "tag\n" + normalized)`. The output is 32 bytes,
/// encoded as base64url with no `=` padding, which is always 43 characters.
/// The same key and the same word always produce the same token, so SQL can
/// compare them. A different owner key produces a different token, so one
/// person's search does not hit another person's rows.
///
/// Normalization is `trim`, then Unicode NFC, then lowercase. `Vacation` and
/// `vacation` match. The rules are the same in `client/src/lib/protocol/crypto.js`.
pub fn tag_token(seed: &[u8; 32], tag: &str) -> Result<String, Error> {
    let normalized = normalize_tag(tag)?;
    let key = derive_key(seed, b"tag");
    let mut mac = <HmacSha256 as Mac>::new_from_slice(&key).expect("HMAC key");
    mac.update(b"tag\n");
    mac.update(normalized.as_bytes());
    Ok(URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes()))
}

/// Trim, NFC, lowercase. Rejects empty tags and anything with a comma or a
/// newline, because the upload form treats those as separators.
pub fn normalize_tag(tag: &str) -> Result<String, Error> {
    let text: String = tag.trim().nfc().collect();
    let text = text.to_lowercase();
    if text.is_empty() || text.chars().count() > 64 || text.contains(['\n', '\r', ',']) {
        return Err(Error::BadRequest("bad tag".into()));
    }
    Ok(text)
}

/// Derive independent 32-byte keys with salt `i2nclip` and info `enc` or `tag`.
fn derive_key(seed: &[u8; 32], info: &[u8]) -> [u8; 32] {
    let hk = Hkdf::<Sha256>::new(Some(HKDF_SALT), seed);
    let mut out = [0u8; 32];
    hk.expand(info, &mut out)
        .expect("32-byte HKDF output is within the limit");
    out
}

/// Ed25519 signature over `message`. Deterministic: the same seed and the
/// same message always produce the same 64-byte signature.
pub fn sign(seed: &[u8; 32], message: &[u8]) -> [u8; 64] {
    let signing = SigningKey::from_bytes(seed);
    signing.sign(message).to_bytes()
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
#[allow(dead_code)]
pub fn fresh_nonce() -> String {
    let mut raw = [0u8; 16];
    getrandom::getrandom(&mut raw).expect("operating system random source");
    URL_SAFE_NO_PAD.encode(raw)
}
