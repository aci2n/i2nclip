//! Public chain encoding and signature verification. No encryption secrets live here.

use std::fmt;

use serde::{
    de::{self, SeqAccess, Visitor},
    ser::SerializeTuple,
    Deserialize, Deserializer, Serialize, Serializer,
};
use serde_bytes::ByteBuf;
use sha2::{Digest, Sha256};

use crate::{auth::validate_public_key, codec, crypto, Error, MAX_SAFE_INTEGER};

pub type Hash = [u8; 32];
pub const MAX_BLOCK_BYTES: usize = 64 * 1024;
pub const MAX_BLOB_BYTES: usize = 4 * 1024 * 1024 + 64;
pub const MAX_PAGE_BYTES: usize = 1024 * 1024;
pub const MAX_PAGE_BLOCKS: usize = 128;
pub const SIGN_DOMAIN: &[u8] = b"i2nclip/chain/sign/1\n";
const BLOCK_DOMAIN: &[u8] = b"i2nclip/chain/block/1\n";
const GENESIS_DOMAIN: &[u8] = b"i2nclip/chain/genesis/1\n";

fn invalid() -> Error {
    Error::BadRequest("invalid chain record".into())
}

pub fn digest(bytes: &[u8]) -> Hash {
    Sha256::digest(bytes).into()
}

pub fn parse_hash(text: &str) -> Result<Hash, Error> {
    if text.len() != 64
        || !text
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(Error::BadRequest(
            "hash must be 64 lowercase hexadecimal digits".into(),
        ));
    }
    let mut result = [0; 32];
    for (index, pair) in text.as_bytes().as_chunks::<2>().0.iter().enumerate() {
        result[index] = u8::from_str_radix(std::str::from_utf8(pair).map_err(|_| invalid())?, 16)
            .map_err(|_| invalid())?;
    }
    Ok(result)
}

/// Canonical genesis pins the single immutable library signing authority.
pub fn genesis(public: &Hash) -> Result<Hash, Error> {
    Ok(digest(&[GENESIS_DOMAIN, &genesis_bytes(public)?].concat()))
}
pub fn genesis_bytes(public: &Hash) -> Result<Vec<u8>, Error> {
    validate_public_key(public)?;
    rmp_serde::to_vec(&(1u8, serde_bytes::Bytes::new(public))).map_err(|_| invalid())
}
pub fn parse_genesis(bytes: &[u8]) -> Result<Hash, Error> {
    if bytes.len() > 128 {
        return Err(invalid());
    }
    let (version, public): (u8, ByteBuf) = codec::decode(bytes)?;
    let public: Hash = public.as_ref().try_into().map_err(|_| invalid())?;
    if version != 1 || genesis_bytes(&public)? != bytes {
        return Err(invalid());
    }
    Ok(public)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum StorageEffect {
    Publish { file: Hash, inventory: Hash },
    Commit { file: Hash, hashes: Vec<Hash> },
    Purge { file: Hash },
}

impl Serialize for StorageEffect {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut tuple = serializer.serialize_tuple(if matches!(self, Self::Purge { .. }) {
            2
        } else {
            3
        })?;
        match self {
            Self::Publish { file, inventory } => {
                tuple.serialize_element("publish")?;
                tuple.serialize_element(serde_bytes::Bytes::new(file))?;
                tuple.serialize_element(serde_bytes::Bytes::new(inventory))?;
            }
            Self::Commit { file, hashes } => {
                tuple.serialize_element("commit")?;
                tuple.serialize_element(serde_bytes::Bytes::new(file))?;
                tuple.serialize_element(
                    &hashes
                        .iter()
                        .map(|h| serde_bytes::Bytes::new(h))
                        .collect::<Vec<_>>(),
                )?;
            }
            Self::Purge { file } => {
                tuple.serialize_element("purge")?;
                tuple.serialize_element(serde_bytes::Bytes::new(file))?;
            }
        }
        tuple.end()
    }
}

impl<'de> Deserialize<'de> for StorageEffect {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct EffectVisitor;
        impl<'de> Visitor<'de> for EffectVisitor {
            type Value = StorageEffect;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("a storage effect array")
            }
            fn visit_seq<A: SeqAccess<'de>>(
                self,
                mut sequence: A,
            ) -> Result<Self::Value, A::Error> {
                let tag: String = sequence
                    .next_element()?
                    .ok_or_else(|| de::Error::custom("missing effect"))?;
                let effect = match tag.as_str() {
                    "publish" => StorageEffect::Publish {
                        file: next_hash(&mut sequence)?,
                        inventory: next_hash(&mut sequence)?,
                    },
                    "commit" => StorageEffect::Commit {
                        file: next_hash(&mut sequence)?,
                        hashes: next_hashes(&mut sequence, 2)?,
                    },
                    "purge" => StorageEffect::Purge {
                        file: next_hash(&mut sequence)?,
                    },
                    _ => return Err(de::Error::custom("unknown storage effect")),
                };
                if sequence.next_element::<de::IgnoredAny>()?.is_some() {
                    return Err(de::Error::custom("extra effect field"));
                }
                Ok(effect)
            }
        }
        deserializer.deserialize_seq(EffectVisitor)
    }
}

fn next_hash<'de, A: SeqAccess<'de>>(sequence: &mut A) -> Result<Hash, A::Error> {
    let value: ByteBuf = sequence
        .next_element()?
        .ok_or_else(|| de::Error::custom("missing hash"))?;
    value
        .as_ref()
        .try_into()
        .map_err(|_| de::Error::custom("invalid hash length"))
}
fn next_hashes<'de, A: SeqAccess<'de>>(
    sequence: &mut A,
    maximum: usize,
) -> Result<Vec<Hash>, A::Error> {
    let values: Vec<ByteBuf> = sequence
        .next_element()?
        .ok_or_else(|| de::Error::custom("missing hashes"))?;
    let hashes = values
        .iter()
        .map(|v| {
            v.as_ref()
                .try_into()
                .map_err(|_| de::Error::custom("invalid hash length"))
        })
        .collect::<Result<Vec<Hash>, A::Error>>()?;
    if hashes.is_empty() || hashes.len() > maximum || hashes.windows(2).any(|w| w[0] >= w[1]) {
        return Err(de::Error::custom(
            "hash list must be bounded, sorted, and unique",
        ));
    }
    Ok(hashes)
}

/// Fixed positional MessagePack body; every block is encrypted under one authority.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Body {
    pub version: u8,
    #[serde(with = "serde_bytes")]
    pub library: Hash,
    pub sequence: u64,
    #[serde(with = "serde_bytes")]
    pub previous: Hash,
    pub effects: Vec<StorageEffect>,
    pub salt: ByteBuf,
    pub nonce: ByteBuf,
    pub encrypted: ByteBuf,
}
impl Body {
    pub fn encode(&self) -> Result<Vec<u8>, Error> {
        rmp_serde::to_vec(self).map_err(|_| invalid())
    }
    pub fn header(&self) -> Result<Vec<u8>, Error> {
        rmp_serde::to_vec(&(
            self.version,
            serde_bytes::Bytes::new(&self.library),
            self.sequence,
            serde_bytes::Bytes::new(&self.previous),
            &self.effects,
            &self.salt,
            &self.nonce,
        ))
        .map_err(|_| invalid())
    }
    fn validate(&self) -> Result<(), Error> {
        if self.version != 1
            || self.sequence == 0
            || self.sequence > MAX_SAFE_INTEGER as u64
            || self.effects.len() > 1
            || self.salt.len() != 32
            || self.nonce.len() != 12
            || self.encrypted.len() < 16
        {
            return Err(invalid());
        }
        Ok(())
    }
}

pub struct Record {
    pub bytes: Vec<u8>,
    pub hash: Hash,
    pub body: Body,
    pub signed_body: Vec<u8>,
    pub signature: Vec<u8>,
}

/// Canonical framing, public shape and strict Ed25519 validation against the library key.
pub fn verify_record(bytes: &[u8], public: &Hash) -> Result<Record, Error> {
    if bytes.len() > MAX_BLOCK_BYTES {
        return Err(invalid());
    }
    let (signed, signature): (ByteBuf, ByteBuf) = codec::decode(bytes)?;
    if signature.len() != 64 {
        return Err(invalid());
    }
    let body: Body = codec::decode(&signed)?;
    body.validate()?;
    if body.encode()? != signed.as_ref()
        || rmp_serde::to_vec(&(&signed, &signature)).map_err(|_| invalid())? != bytes
    {
        return Err(invalid());
    }
    crypto::verify(public, &[SIGN_DOMAIN, &signed].concat(), &signature)?;
    Ok(Record {
        bytes: bytes.to_vec(),
        hash: digest(&[BLOCK_DOMAIN, bytes].concat()),
        body,
        signed_body: signed.into_vec(),
        signature: signature.into_vec(),
    })
}

/// The publisher and server hash the same unordered inventory of staged ciphertext.
pub fn inventory_digest(
    library: &Hash,
    file: &Hash,
    entries: &[(Hash, u64)],
) -> Result<Hash, Error> {
    let mut entries = entries.to_vec();
    entries.sort_unstable_by_key(|e| e.0);
    if entries.windows(2).any(|w| w[0].0 == w[1].0)
        || entries
            .iter()
            .any(|e| e.1 == 0 || e.1 > MAX_SAFE_INTEGER as u64)
    {
        return Err(invalid());
    }
    let entries = entries
        .iter()
        .map(|(hash, size)| (serde_bytes::Bytes::new(hash), size))
        .collect::<Vec<_>>();
    let bytes = rmp_serde::to_vec(&(
        "i2nclip/inventory/1",
        serde_bytes::Bytes::new(library),
        serde_bytes::Bytes::new(file),
        entries,
    ))
    .map_err(|_| invalid())?;
    Ok(digest(&bytes))
}

#[cfg(test)]
mod tests {
    use aes_gcm::{
        aead::{Aead, Payload},
        Aes256Gcm, KeyInit, Nonce,
    };
    use hkdf::Hkdf;
    use serde_json::Value;

    use super::*;
    fn binary(value: &Value, name: &str) -> Vec<u8> {
        value[name]
            .as_str()
            .unwrap()
            .as_bytes()
            .as_chunks::<2>()
            .0
            .iter()
            .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
            .collect()
    }
    #[test]
    fn shared_seed_vectors_verify_native_signatures_and_independent_hkdf_aead() {
        let vector: Value =
            serde_json::from_str(include_str!("../client/tests/shared-seed-vectors.json")).unwrap();
        let public: Hash = binary(&vector, "publicKey").try_into().unwrap();
        let genesis = binary(&vector, "genesis");
        let library = genesis_hash_for_test(&genesis);
        assert_eq!(parse_genesis(&genesis).unwrap(), public);
        assert_eq!(genesis_bytes(&public).unwrap(), genesis);
        assert_eq!(library.as_slice(), binary(&vector, "library"));
        let info = codec::encode(&(
            "i2nclip/library-encryption/1",
            serde_bytes::Bytes::new(&library),
        ))
        .unwrap();
        let mut root = [0u8; 32];
        Hkdf::<Sha256>::new(Some(b"i2nclip"), &binary(&vector, "seed"))
            .expand(&info, &mut root)
            .unwrap();
        assert_eq!(root.as_slice(), binary(&vector, "encryptionRoot"));
        let bytes = binary(&vector, "record");
        let record = verify_record(&bytes, &public).unwrap();
        assert_eq!(record.hash.as_slice(), binary(&vector, "hash"));
        let info =
            codec::encode(&("i2nclip/chain/key/1", serde_bytes::Bytes::new(&library))).unwrap();
        let mut key = [0u8; 32];
        Hkdf::<Sha256>::new(Some(&record.body.salt), &root)
            .expand(&info, &mut key)
            .unwrap();
        assert_eq!(key.as_slice(), binary(&vector, "blockKey"));
        let aad = [
            b"i2nclip/chain/aad/1\n".as_slice(),
            &record.body.header().unwrap(),
        ]
        .concat();
        let opened = Aes256Gcm::new_from_slice(&key)
            .unwrap()
            .decrypt(
                Nonce::from_slice(&record.body.nonce),
                Payload {
                    msg: &record.body.encrypted,
                    aad: &aad,
                },
            )
            .unwrap();
        assert_eq!(opened, binary(&vector, "plaintext"));
        let other = crate::reference_crypto::from_seed([8; 32]);
        assert!(verify_record(&bytes, &other.public).is_err());
        let mut bad = bytes.clone();
        let last = bad.len() - 1;
        bad[last] ^= 1;
        assert!(verify_record(&bad, &public).is_err());
        let mut extra = bytes;
        extra.push(0);
        assert!(verify_record(&extra, &public).is_err());
        let mut extra = genesis;
        extra.push(0);
        assert!(parse_genesis(&extra).is_err());
    }
    #[test]
    fn purge_effect_names_exactly_one_file() {
        let file = [7; 32];
        let bytes = codec::encode(&StorageEffect::Purge { file }).unwrap();
        let expected = codec::encode(&("purge", serde_bytes::Bytes::new(&file))).unwrap();
        assert_eq!(bytes, expected);
        assert_eq!(
            codec::decode::<StorageEffect>(&bytes).unwrap(),
            StorageEffect::Purge { file }
        );
        let list = codec::encode(&("purge", vec![serde_bytes::Bytes::new(&file)])).unwrap();
        assert!(codec::decode::<StorageEffect>(&list).is_err());
    }
    fn genesis_hash_for_test(bytes: &[u8]) -> Hash {
        digest(&[GENESIS_DOMAIN, bytes].concat())
    }
}
