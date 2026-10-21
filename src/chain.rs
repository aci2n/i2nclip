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
pub const MAX_AUTHORIZED_DEVICES: i64 = 128;
pub const MAX_BLOCK_BYTES: usize = 64 * 1024;
pub const MAX_BLOB_BYTES: usize = 4 * 1024 * 1024 + 64;
pub const MAX_PAGE_BYTES: usize = 1024 * 1024;
pub const MAX_PAGE_BLOCKS: usize = 128;
pub const MAX_PURGE_FILES: usize = 256;
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

/// Genesis pins immutable recovery authority and the initial public epoch salt.
pub fn genesis(recovery: &Hash, epoch_salt: &Hash) -> Result<Hash, Error> {
    let bytes = genesis_bytes(recovery, epoch_salt)?;
    Ok(digest(&[GENESIS_DOMAIN, &bytes].concat()))
}

pub fn genesis_bytes(recovery: &Hash, epoch_salt: &Hash) -> Result<Vec<u8>, Error> {
    validate_public_key(recovery)?;
    rmp_serde::to_vec(&(
        1u8,
        serde_bytes::Bytes::new(recovery),
        serde_bytes::Bytes::new(epoch_salt),
    ))
    .map_err(|_| invalid())
}

/// Canonical public authority and initial epoch salt, independent of SQL projections.
pub fn parse_genesis(bytes: &[u8]) -> Result<(Hash, Hash), Error> {
    if bytes.len() > 128 {
        return Err(invalid());
    }
    let (version, recovery, salt): (u8, ByteBuf, ByteBuf) =
        rmp_serde::from_slice(bytes).map_err(|_| invalid())?;
    let recovery: Hash = recovery.as_ref().try_into().map_err(|_| invalid())?;
    let salt: Hash = salt.as_ref().try_into().map_err(|_| invalid())?;
    if version != 1 || genesis_bytes(&recovery, &salt)? != bytes {
        return Err(invalid());
    }
    Ok((recovery, salt))
}

pub fn genesis_recovery(bytes: &[u8]) -> Result<Hash, Error> {
    Ok(parse_genesis(bytes)?.0)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Data,
    Enroll,
    Revoke,
    Rotate,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum StorageEffect {
    Publish { file: Hash, inventory: Hash },
    Commit { file: Hash, hashes: Vec<Hash> },
    Purge { files: Vec<Hash> },
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
            Self::Purge { files } => {
                tuple.serialize_element("purge")?;
                tuple.serialize_element(
                    &files
                        .iter()
                        .map(|h| serde_bytes::Bytes::new(h))
                        .collect::<Vec<_>>(),
                )?;
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
                        files: next_hashes(&mut sequence, MAX_PURGE_FILES)?,
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

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Effects {
    Storage(Vec<StorageEffect>),
    Device((ByteBuf,)),
    Rotation((u64, ByteBuf, ByteBuf)),
}

/// Struct fields serialize to a fixed-position array with `rmp_serde::to_vec`.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Body {
    pub version: u8,
    #[serde(with = "serde_bytes")]
    pub library: Hash,
    pub sequence: u64,
    #[serde(with = "serde_bytes")]
    pub previous: Hash,
    pub epoch: u64,
    #[serde(with = "serde_bytes")]
    pub signer: Hash,
    pub kind: Kind,
    pub effects: Effects,
    pub salt: Option<ByteBuf>,
    pub nonce: Option<ByteBuf>,
    pub encrypted: Option<ByteBuf>,
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
            self.epoch,
            serde_bytes::Bytes::new(&self.signer),
            self.kind,
            &self.effects,
            &self.salt,
            &self.nonce,
        ))
        .map_err(|_| invalid())
    }
    fn validate(&self) -> Result<(), Error> {
        if self.version != 1
            || self.sequence == 0
            || self.epoch == 0
            || self.sequence > MAX_SAFE_INTEGER as u64
            || self.epoch > MAX_SAFE_INTEGER as u64
        {
            return Err(invalid());
        }
        validate_public_key(&self.signer)?;
        match (&self.kind, &self.effects) {
            (Kind::Data, Effects::Storage(effects)) if effects.len() <= 1 => {
                if self.salt.as_ref().map(|value| value.len()) != Some(32)
                    || self.nonce.as_ref().map(|value| value.len()) != Some(12)
                    || self.encrypted.as_ref().is_none_or(|v| v.len() < 16)
                {
                    return Err(invalid());
                }
            }
            (Kind::Enroll | Kind::Revoke, Effects::Device((key,))) => {
                validate_public_key(key)?;
            }
            (Kind::Rotate, Effects::Rotation((epoch, key, salt)))
                if *epoch >= 2 && *epoch <= MAX_SAFE_INTEGER as u64 && salt.len() == 32 =>
            {
                validate_public_key(key)?;
            }
            _ => return Err(invalid()),
        }
        if self.kind != Kind::Data
            && (self.salt.is_some() || self.nonce.is_some() || self.encrypted.is_some())
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

/// Canonical framing, public shape and strict Ed25519 validation; no membership lookup.
pub fn verify_record(bytes: &[u8]) -> Result<Record, Error> {
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
    crypto::verify(&body.signer, &[SIGN_DOMAIN, &signed].concat(), &signature)?;
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
    use ed25519_dalek::{Signer, SigningKey};
    use hkdf::Hkdf;
    use serde_json::Value;

    use super::*;

    #[test]
    fn genesis_authority_requires_canonical_valid_public_payload() {
        let recovery = SigningKey::from_bytes(&[42; 32]).verifying_key().to_bytes();

        let bytes = genesis_bytes(&recovery, &[11; 32]).unwrap();
        assert_eq!(genesis_recovery(&bytes).unwrap(), recovery);
        let mut trailing = bytes.clone();
        trailing.push(0);
        assert!(genesis_recovery(&trailing).is_err());
        assert!(genesis_recovery(&[0; 129]).is_err());
        assert!(genesis_recovery(
            &rmp_serde::to_vec(&(
                1,
                ByteBuf::from(recovery),
                ByteBuf::from(recovery),
                ByteBuf::from([11; 32]),
                1
            ))
            .unwrap()
        )
        .is_err());
    }

    fn vectors() -> Value {
        serde_json::from_str(include_str!("../client/tests/chain-vectors.json")).unwrap()
    }
    fn hex_bytes(hex: &str) -> Vec<u8> {
        hex.as_bytes()
            .as_chunks::<2>()
            .0
            .iter()
            .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
            .collect()
    }
    fn bytes(value: &Value, name: &str) -> Vec<u8> {
        hex_bytes(value[name].as_str().unwrap())
    }
    fn hash(value: &Value, name: &str) -> Hash {
        bytes(value, name).try_into().unwrap()
    }
    fn sign(body: &Body, seed: &Hash) -> Vec<u8> {
        let signed = body.encode().unwrap();
        let signature = SigningKey::from_bytes(seed).sign(&[SIGN_DOMAIN, &signed].concat());
        rmp_serde::to_vec(&(
            ByteBuf::from(signed),
            ByteBuf::from(signature.to_bytes().to_vec()),
        ))
        .unwrap()
    }

    #[test]
    fn canonical_records_and_inventory_match_javascript_vectors() {
        let v = vectors();
        let recovery: Value =
            serde_json::from_str(include_str!("../client/tests/recovery-vectors.json")).unwrap();
        assert_eq!(
            genesis(
                &hash(&recovery, "recovery_public_key"),
                &hash(&recovery, "epoch_1_salt")
            )
            .unwrap(),
            hash(&recovery, "library")
        );
        let record = verify_record(&bytes(&v, "record")).unwrap();
        assert_eq!(record.hash, hash(&v, "block_hash"));
        assert_eq!(record.signed_body, bytes(&v, "signed_body"));
        assert_eq!(record.body.header().unwrap(), bytes(&v, "header"));
        assert_eq!(sign(&record.body, &hash(&v, "seed")), record.bytes);
        {
            let record = verify_record(&bytes(&v, "enrollment")).unwrap();
            assert!(record.body.encrypted.is_none());
            assert_eq!(sign(&record.body, &hash(&v, "seed")), record.bytes);
        }
        let reset = verify_record(&bytes(&recovery, "reset")).unwrap();
        assert_eq!(reset.body.signer, hash(&recovery, "recovery_public_key"));
        assert_eq!(
            sign(&reset.body, &hash(&recovery, "signing_seed")),
            reset.bytes
        );
        assert!(verify_record(&bytes(&v, "rotation")).is_err());
        let mut entries = v["inventory_entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| {
                (
                    hex_bytes(e[0].as_str().unwrap()).try_into().unwrap(),
                    e[1].as_u64().unwrap(),
                )
            })
            .collect::<Vec<_>>();
        entries.reverse();
        assert_eq!(
            inventory_digest(&hash(&v, "library"), &hash(&v, "file"), &entries).unwrap(),
            hash(&v, "inventory")
        );
        assert!(inventory_digest(
            &hash(&v, "library"),
            &hash(&v, "file"),
            &[entries[0], entries[0]]
        )
        .is_err());
    }

    #[test]
    fn recovery_epoch_derivation_matches_independent_native_vectors() {
        let v: Value =
            serde_json::from_str(include_str!("../client/tests/recovery-vectors.json")).unwrap();
        let signing = SigningKey::from_bytes(&hash(&v, "signing_seed"));
        assert_eq!(
            signing.verifying_key().to_bytes(),
            hash(&v, "recovery_public_key")
        );
        assert_eq!(
            signing.sign(&bytes(&v, "probe")).to_bytes().as_slice(),
            bytes(&v, "signature")
        );
        for epoch in [1u64, 2] {
            let info = rmp_serde::to_vec(&(
                "i2nclip/epoch-key/1",
                serde_bytes::Bytes::new(&hash(&v, "library")),
                epoch,
            ))
            .unwrap();
            let mut key = [0; 32];
            Hkdf::<Sha256>::new(
                Some(&bytes(&v, &format!("epoch_{epoch}_salt"))),
                &bytes(&v, "epoch_derivation_secret"),
            )
            .expand(&info, &mut key)
            .unwrap();
            assert_eq!(key, hash(&v, &format!("epoch_{epoch}_key")));
        }
    }

    #[test]
    fn independent_reference_hkdf_and_aead_open_client_ciphertexts() {
        let v = vectors();
        let record = verify_record(&bytes(&v, "record")).unwrap();
        let body = record.body;
        let info = rmp_serde::to_vec(&(
            "i2nclip/chain/key/1",
            serde_bytes::Bytes::new(&body.library),
            body.epoch,
        ))
        .unwrap();
        let mut key = [0; 32];
        Hkdf::<Sha256>::new(
            Some(body.salt.as_ref().unwrap()),
            &bytes(&v, "epoch_secret"),
        )
        .expand(&info, &mut key)
        .unwrap();
        let cipher = Aes256Gcm::new_from_slice(&key).unwrap();
        let aad = [b"i2nclip/chain/aad/1\n".as_slice(), &body.header().unwrap()].concat();
        let plain = cipher
            .decrypt(
                Nonce::from_slice(body.nonce.as_ref().unwrap()),
                Payload {
                    msg: body.encrypted.as_ref().unwrap(),
                    aad: &aad,
                },
            )
            .unwrap();
        assert_eq!(plain, bytes(&v, "plaintext"));
        let object = bytes(&v, "object");
        assert_eq!(digest(&object), hash(&v, "object_hash"));
        let (version, nonce, ct): (u8, ByteBuf, ByteBuf) = codec::decode(&object).unwrap();
        assert_eq!(version, 1);
        let aad = rmp_serde::to_vec(&(
            "i2nclip/object/1",
            serde_bytes::Bytes::new(&hash(&v, "library")),
            serde_bytes::Bytes::new(&hash(&v, "file")),
            "metadata",
        ))
        .unwrap();
        let cipher = Aes256Gcm::new_from_slice(&bytes(&v, "object_key")).unwrap();
        assert_eq!(
            cipher
                .decrypt(
                    Nonce::from_slice(&nonce),
                    Payload {
                        msg: &ct,
                        aad: &aad
                    }
                )
                .unwrap(),
            bytes(&v, "object_plaintext")
        );
    }

    #[test]
    fn reject_tampering_noncanonical_encoding_and_signed_invalid_headers() {
        let v = vectors();
        let encoded = bytes(&v, "record");
        for index in [0, encoded.len() / 2, encoded.len() - 1] {
            let mut changed = encoded.clone();
            changed[index] ^= 1;
            assert!(verify_record(&changed).is_err());
        }
        let mut extra = encoded.clone();
        extra.push(0);
        assert!(verify_record(&extra).is_err());
        assert!(verify_record(&vec![0; MAX_BLOCK_BYTES + 1]).is_err());
        let record = verify_record(&encoded).unwrap();
        for change in 0..6 {
            let mut body = record.body.clone();
            match change {
                0 => body.version = 2,
                1 => body.sequence = 0,
                2 => body.epoch = 0,
                3 => body.salt = None,
                4 => body.kind = Kind::Rotate,
                _ => body.sequence = MAX_SAFE_INTEGER as u64 + 1,
            }
            assert!(verify_record(&sign(&body, &hash(&v, "seed"))).is_err());
        }
        let mut noncanonical = record.signed_body.clone();
        noncanonical.splice(1..2, [0xcc, 1]);
        let signature =
            SigningKey::from_bytes(&hash(&v, "seed")).sign(&[SIGN_DOMAIN, &noncanonical].concat());
        let encoded = rmp_serde::to_vec(&(
            ByteBuf::from(noncanonical),
            ByteBuf::from(signature.to_bytes().to_vec()),
        ))
        .unwrap();
        assert!(verify_record(&encoded).is_err());
    }
}
