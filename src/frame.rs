//! Named MessagePack upload and metadata documents, signed as exact bytes.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};

use crate::{
    codec, crypto, Error, MAX_DESCRIPTOR, MAX_META, MAX_TAGS, MAX_TAG_DATA, MAX_TAG_LABEL,
};

/// Random 32-byte file identifier, encoded as lowercase hexadecimal.
pub(crate) fn parse_id(id: &str) -> Result<String, Error> {
    if id.len() != 64 || !id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
        return Err(Error::BadRequest(
            "id must be 64 lowercase hexadecimal digits".into(),
        ));
    }
    Ok(id.to_string())
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct WireTag<'a> {
    #[serde(with = "serde_bytes", borrow)]
    token: &'a [u8],
    #[serde(with = "serde_bytes", borrow)]
    label: &'a [u8],
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct UploadDocument<'a> {
    id: String,
    plaintext_bytes: i64,
    #[serde(with = "serde_bytes", borrow)]
    meta: &'a [u8],
    #[serde(with = "serde_bytes", borrow)]
    descriptor: &'a [u8],
    #[serde(borrow)]
    tags: Vec<WireTag<'a>>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MetaDocument<'a> {
    #[serde(with = "serde_bytes", borrow)]
    prev_meta_hash: &'a [u8],
    #[serde(with = "serde_bytes", borrow)]
    meta: &'a [u8],
    #[serde(borrow)]
    tags: Vec<WireTag<'a>>,
}

pub(crate) struct UploadParts<'a> {
    pub id: String,
    pub plaintext_bytes: i64,
    pub meta: &'a [u8],
    pub descriptor: &'a [u8],
    pub tags: Vec<Tag>,
}
pub(crate) struct MetaParts<'a> {
    pub prev_meta_hash: [u8; 32],
    pub meta: &'a [u8],
    pub tags: Vec<Tag>,
}

pub(crate) fn decode_upload(bytes: &[u8]) -> Result<UploadParts<'_>, Error> {
    let doc: UploadDocument<'_> = codec::decode(bytes)?;
    if doc.meta.len() > MAX_META || doc.descriptor.len() > MAX_DESCRIPTOR {
        return Err(Error::BadRequest("field too large".into()));
    }
    Ok(UploadParts {
        meta: doc.meta,
        id: parse_id(&doc.id)?,
        plaintext_bytes: doc.plaintext_bytes,
        descriptor: doc.descriptor,
        tags: parse_tags(doc.tags)?,
    })
}
pub(crate) fn decode_meta(bytes: &[u8]) -> Result<MetaParts<'_>, Error> {
    let doc: MetaDocument<'_> = codec::decode(bytes)?;
    if doc.meta.len() > MAX_META {
        return Err(Error::BadRequest("field too large".into()));
    }
    let prev_meta_hash = doc
        .prev_meta_hash
        .try_into()
        .map_err(|_| Error::BadRequest("previous metadata hash must be 32 bytes".into()))?;
    Ok(MetaParts {
        prev_meta_hash,
        meta: doc.meta,
        tags: parse_tags(doc.tags)?,
    })
}

/// Canonical database token and sealed label; only the client authenticates them.
pub(crate) struct Tag {
    pub token: String,
    pub label: Vec<u8>,
}
fn parse_tags(entries: Vec<WireTag<'_>>) -> Result<Vec<Tag>, Error> {
    if entries.len() > MAX_TAGS
        || (!entries.is_empty() && codec::encode(&entries)?.len() > MAX_TAG_DATA)
    {
        return Err(Error::BadRequest(
            "too many tags or tag data too large".into(),
        ));
    }
    let mut tags: Vec<Tag> = Vec::new();
    for tag in entries {
        if tag.token.len() != 32 {
            return Err(Error::BadRequest("bad tag token".into()));
        }
        let sealed = crypto::check_blob(tag.label, MAX_TAG_LABEL)?;
        if sealed.ct.len() == 16 {
            return Err(Error::BadRequest("empty tag label".into()));
        }
        let token = URL_SAFE_NO_PAD.encode(tag.token);
        if !tags.iter().any(|existing| existing.token == token) {
            tags.push(Tag {
                token,
                label: tag.label.to_vec(),
            });
        }
    }
    Ok(tags)
}

/// 32 bytes of base64url with no padding is always 43 characters from this alphabet.
pub(crate) fn is_token(value: &str) -> bool {
    value.len() == 43
        && value
            .bytes()
            .all(|b| matches!(b, b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_'))
}

/// `?tag=` values, already split by the HTTP handler. Each value is trimmed,
/// then checked for the token alphabet and the distinct-token limit.
pub(crate) fn parse_query_tokens(values: Vec<String>) -> Result<Vec<String>, Error> {
    collect_tokens(values.iter().map(|value| value.trim()))
}

fn collect_tokens<'a>(values: impl IntoIterator<Item = &'a str>) -> Result<Vec<String>, Error> {
    let mut tokens = Vec::new();
    for token in values {
        if token.is_empty() {
            continue;
        }
        if !is_token(token) {
            return Err(Error::BadRequest("bad tag token".into()));
        }
        if !tokens.iter().any(|existing| existing == token) {
            tokens.push(token.to_string());
        }
    }
    if tokens.len() > MAX_TAGS {
        return Err(Error::BadRequest("too many tags".into()));
    }
    Ok(tokens)
}

/// All wire sizes fit JavaScript's exact integer range, including GCM overhead.
pub(crate) fn content_shape(size: i64) -> Result<(i64, i64), Error> {
    if !(0..=crate::MAX_SAFE_INTEGER).contains(&size) {
        return Err(Error::BadRequest("invalid plaintext size".into()));
    }
    let chunks = ((size + crate::CHUNK_PLAINTEXT_BYTES - 1) / crate::CHUNK_PLAINTEXT_BYTES).max(1);
    let bytes = size
        .checked_add(chunks * 16)
        .filter(|bytes| *bytes <= crate::MAX_SAFE_INTEGER)
        .ok_or_else(|| {
            Error::BadRequest("content size exceeds the protocol integer range".into())
        })?;
    Ok((chunks, bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn content_dimensions_include_empty_files_and_reject_overflow() {
        assert_eq!(content_shape(0).unwrap(), (1, 16));
        assert_eq!(content_shape(4194304).unwrap(), (1, 4194320));
        assert_eq!(content_shape(4194305).unwrap(), (2, 4194337));
        assert_eq!(content_shape(1 << 40).unwrap().0, 262144);
        assert!(content_shape(-1).is_err());
        assert!(content_shape(crate::MAX_SAFE_INTEGER).is_err());
    }
}

#[cfg(test)]
mod document_tests {
    use super::*;
    use crate::reference_crypto::{encode_create, encode_meta, fixture_tag_labels, sealed_fixture};
    #[test]
    fn frames_borrow_payloads_and_validate_tag_entries_before_deduplication() {
        let id = "a".repeat(64);
        let sealed = sealed_fixture(1, 43);
        let token = URL_SAFE_NO_PAD.encode([1; 32]);
        let body = encode_create(&id, 0, &sealed, &sealed, &fixture_tag_labels(&token));
        let parts = decode_upload(&body).unwrap();
        assert_eq!(parts.id, id);
        assert_eq!(parts.tags.len(), 1);
        assert_eq!(parts.descriptor, sealed);
        let pointer = parts.descriptor.as_ptr() as usize;
        assert!((body.as_ptr() as usize..body.as_ptr() as usize + body.len()).contains(&pointer));
        for length in 0..body.len() {
            assert!(decode_upload(&body[..length]).is_err());
        }
        let mut trailing = body;
        trailing.push(0xc0);
        assert!(decode_upload(&trailing).is_err());
        let meta = encode_meta(&[7; 32], &sealed, b"\x90");
        assert_eq!(decode_meta(&meta).unwrap().prev_meta_hash, [7; 32]);
        let mut entries = Vec::new();
        let empty = sealed_fixture(1, 42);
        entries.push(WireTag {
            token: &[1; 32],
            label: &sealed,
        });
        entries.push(WireTag {
            token: &[1; 32],
            label: &empty,
        });
        assert!(parse_tags(entries).is_err());
        let tokens: Vec<_> = (0..64).map(|value| [value; 32]).collect();
        let entries: Vec<_> = tokens
            .iter()
            .map(|token| WireTag {
                token,
                label: &sealed,
            })
            .collect();
        assert_eq!(parse_tags(entries).unwrap().len(), 64);
        assert!(decode_upload(&encode_create(&id, 0, &vec![0; 1025], &sealed, b"\x90")).is_err());
    }
}
