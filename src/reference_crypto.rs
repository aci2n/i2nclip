//! Reference-client cryptography for Rust tests and shared JavaScript vectors.
//! This module is not compiled into the production library or server.

use aes_gcm::{
    aead::{Aead, Payload},
    Aes256Gcm, KeyInit, Nonce,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use ed25519_dalek::{Signer, SigningKey};

use crate::{
    codec,
    crypto::{body_hash, request_message},
};

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
    let key = [0x44; 32];
    let id = "33".repeat(32);
    let empty_id = "66".repeat(32);
    serde_json::json!({
        "id": id,
        "key_hex": "44".repeat(32),
        "size": 4194307,
        "final_hex": hex_bytes(&encrypt_chunk(&key, &id, 4194307, 1, b"abc")),
        "full_hash": body_hash(&encrypt_chunk(&key, &id, 4194307, 0, &vec![0x5a; 4194304])),
        "empty_id": empty_id,
        "empty_key_hex": "77".repeat(32),
        "empty_hex": hex_bytes(&encrypt_chunk(&[0x77; 32], &empty_id, 0, 0, b"")),
    })
}

fn hex_bytes(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
