//! Reference-client cryptography for Rust tests and shared JavaScript vectors.
//! This module is not compiled into the production library or server.

use aes_gcm::{
    aead::{Aead, Payload},
    Aes256Gcm, KeyInit, Nonce,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use ed25519_dalek::{Signer, SigningKey};
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use sha2::Sha256;
use unicode_normalization::UnicodeNormalization;

use crate::{
    codec,
    crypto::{body_hash, looks_sealed, request_message, Sealed},
    Error,
};

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

fn file_key(seed: &[u8; 32], purpose: &str, id: &str) -> Result<[u8; 32], Error> {
    if id.len() != 64
        || !id
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    {
        return Err(Error::Crypto);
    }
    Ok(derive_key(
        seed,
        format!("i2nclip/keys/v1/{purpose}/{id}").as_bytes(),
    ))
}

pub fn seal_metadata(seed: &[u8; 32], id: &str, plain: &[u8]) -> Result<Vec<u8>, Error> {
    let mut nonce = [0; NONCE_LEN];
    getrandom::getrandom(&mut nonce).expect("operating system random source");
    metadata_with_nonce(seed, id, plain, &nonce)
}

pub fn metadata_with_nonce(
    seed: &[u8; 32],
    id: &str,
    plain: &[u8],
    nonce: &[u8; NONCE_LEN],
) -> Result<Vec<u8>, Error> {
    encrypt_with_nonce(
        &file_key(seed, "metadata", id)?,
        format!("i2nclip/v1 meta {id}").as_bytes(),
        plain,
        nonce,
    )
}

pub fn open_metadata(seed: &[u8; 32], id: &str, blob: &[u8]) -> Result<Vec<u8>, Error> {
    decrypt(
        &file_key(seed, "metadata", id)?,
        format!("i2nclip/v1 meta {id}").as_bytes(),
        blob,
    )
}

pub fn tag_label_with_nonce(
    seed: &[u8; 32],
    token: &str,
    plain: &[u8],
    nonce: &[u8; NONCE_LEN],
) -> Result<Vec<u8>, Error> {
    encrypt_with_nonce(
        &derive_key(seed, b"i2nclip/keys/v1/tag-label"),
        format!("i2nclip/v1 tag {token}").as_bytes(),
        plain,
        nonce,
    )
}

fn encrypt_with_nonce(
    key: &[u8; 32],
    aad: &[u8],
    plaintext: &[u8],
    nonce: &[u8; NONCE_LEN],
) -> Result<Vec<u8>, Error> {
    let cipher = Aes256Gcm::new_from_slice(key).expect("AES-256 key is 32 bytes");
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(nonce),
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .map_err(|_| Error::Crypto)?;
    codec::encode(&Sealed {
        v: VERSION,
        iv: nonce,
        ct: &ciphertext,
    })
}

fn decrypt(key: &[u8; 32], aad: &[u8], blob: &[u8]) -> Result<Vec<u8>, Error> {
    if !looks_sealed(blob, usize::MAX) {
        return Err(Error::Crypto);
    }
    let sealed: Sealed<'_> = codec::decode(blob)?;
    Aes256Gcm::new_from_slice(key)
        .expect("AES-256 key is 32 bytes")
        .decrypt(
            Nonce::from_slice(sealed.iv),
            Payload {
                msg: sealed.ct,
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
/// `vacation` match. The rules are the same in `client/src/lib/protocol/crypto.ts`.
pub fn tag_token(seed: &[u8; 32], tag: &str) -> Result<String, Error> {
    let normalized = normalize_tag(tag)?;
    let key = derive_key(seed, b"i2nclip/keys/v1/tag-token");
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

/// Derive independent 32-byte keys using the specified purpose/file context.
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
#[cfg(feature = "postgres-tests")]
pub fn fresh_nonce() -> String {
    let mut raw = [0u8; 16];
    getrandom::getrandom(&mut raw).expect("operating system random source");
    URL_SAFE_NO_PAD.encode(raw)
}

#[derive(serde::Serialize, serde::Deserialize)]
struct TagDocument {
    #[serde(with = "serde_bytes")]
    token: Vec<u8>,
    #[serde(with = "serde_bytes")]
    label: Vec<u8>,
}

/// Inspect test responses as JSON values, representing binary fields as byte arrays.
pub fn document_json(bytes: &[u8]) -> serde_json::Value {
    struct Value(serde_json::Value);
    impl<'de> serde::Deserialize<'de> for Value {
        fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
            struct Visitor;
            impl<'de> serde::de::Visitor<'de> for Visitor {
                type Value = Value;
                fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                    f.write_str("a document value")
                }
                fn visit_unit<E: serde::de::Error>(self) -> Result<Value, E> {
                    Ok(Value(serde_json::Value::Null))
                }
                fn visit_bool<E: serde::de::Error>(self, v: bool) -> Result<Value, E> {
                    Ok(Value(v.into()))
                }
                fn visit_i64<E: serde::de::Error>(self, v: i64) -> Result<Value, E> {
                    Ok(Value(v.into()))
                }
                fn visit_u64<E: serde::de::Error>(self, v: u64) -> Result<Value, E> {
                    Ok(Value(v.into()))
                }
                fn visit_f64<E: serde::de::Error>(self, v: f64) -> Result<Value, E> {
                    Ok(Value(serde_json::json!(v)))
                }
                fn visit_str<E: serde::de::Error>(self, v: &str) -> Result<Value, E> {
                    Ok(Value(v.into()))
                }
                fn visit_bytes<E: serde::de::Error>(self, v: &[u8]) -> Result<Value, E> {
                    Ok(Value(serde_json::json!(v)))
                }
                fn visit_seq<A: serde::de::SeqAccess<'de>>(
                    self,
                    mut seq: A,
                ) -> Result<Value, A::Error> {
                    let mut values = Vec::new();
                    while let Some(Value(value)) = seq.next_element()? {
                        values.push(value);
                    }
                    Ok(Value(values.into()))
                }
                fn visit_map<A: serde::de::MapAccess<'de>>(
                    self,
                    mut map: A,
                ) -> Result<Value, A::Error> {
                    let mut values = serde_json::Map::new();
                    while let Some((key, Value(value))) = map.next_entry()? {
                        values.insert(key, value);
                    }
                    Ok(Value(values.into()))
                }
            }
            deserializer.deserialize_any(Visitor)
        }
    }
    codec::decode::<Value>(bytes).unwrap().0
}

pub fn registration_body(otc: &str) -> Vec<u8> {
    #[derive(serde::Serialize)]
    struct Registration<'a> {
        otc: &'a str,
    }
    codec::encode(&Registration { otc }).unwrap()
}

pub fn content_descriptor(
    seed: &[u8; 32],
    id: &str,
    size: u64,
    key: &[u8; 32],
    nonce: &[u8; 12],
) -> Vec<u8> {
    #[derive(serde::Serialize)]
    struct Descriptor<'a> {
        v: u8,
        #[serde(with = "serde_bytes")]
        key: &'a [u8],
        plaintext_bytes: u64,
        chunk_bytes: u64,
        chunk_count: u64,
    }
    let plain = codec::encode(&Descriptor {
        v: 2,
        key,
        plaintext_bytes: size,
        chunk_bytes: 4194304,
        chunk_count: size.div_ceil(4194304).max(1),
    })
    .unwrap();
    encrypt_with_nonce(
        &file_key(seed, "descriptor", id).unwrap(),
        format!("i2nclip/v2 descriptor {id}").as_bytes(),
        &plain,
        nonce,
    )
    .unwrap()
}

pub fn encrypt_chunk(key: &[u8; 32], id: &str, size: u64, index: u64, plain: &[u8]) -> Vec<u8> {
    let mut nonce = [0; 12];
    nonce[4..].copy_from_slice(&index.to_be_bytes());
    let aad = format!(
        "i2nclip/v2 chunk\n{id}\n{index}\n{}\n{size}\n",
        size.div_ceil(4194304).max(1)
    );
    Aes256Gcm::new_from_slice(key)
        .unwrap()
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: plain,
                aad: aad.as_bytes(),
            },
        )
        .unwrap()
}

pub fn chunk_vectors() -> serde_json::Value {
    let seed = [0x11; 32];
    let key = [0x44; 32];
    let id = "33".repeat(32);
    let nonce = [0x55; 12];
    let empty_id = "66".repeat(32);
    serde_json::json!({
        "id": id,
        "key_hex": "44".repeat(32),
        "nonce_hex": "55".repeat(12),
        "size": 4194307,
        "descriptor_hex": hex_bytes(&content_descriptor(&seed, &id, 4194307, &key, &nonce)),
        "final_hex": hex_bytes(&encrypt_chunk(&key, &id, 4194307, 1, b"abc")),
        "full_hash": body_hash(&encrypt_chunk(&key, &id, 4194307, 0, &vec![0x5a; 4194304])),
        "empty_id": empty_id,
        "empty_key_hex": "77".repeat(32),
        "empty_descriptor_hex": hex_bytes(&content_descriptor(&seed, &empty_id, 0, &[0x77; 32], &nonce)),
        "empty_hex": hex_bytes(&encrypt_chunk(&[0x77; 32], &empty_id, 0, 0, b"")),
    })
}

fn hex_bytes(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub fn encode_create(
    id: &str,
    plaintext_bytes: i64,
    descriptor: &[u8],
    meta: &[u8],
    tags: &[u8],
) -> Vec<u8> {
    #[derive(serde::Serialize)]
    struct Creation<'a> {
        id: &'a str,
        plaintext_bytes: i64,
        #[serde(with = "serde_bytes")]
        descriptor: &'a [u8],
        #[serde(with = "serde_bytes")]
        meta: &'a [u8],
        tags: Vec<TagDocument>,
    }
    codec::encode(&Creation {
        id,
        plaintext_bytes,
        descriptor,
        meta,
        tags: codec::decode(tags).unwrap(),
    })
    .unwrap()
}
