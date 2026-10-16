//! Named MessagePack upload and metadata documents, signed as exact bytes.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};

use crate::{codec, crypto, Error, MAX_CONTENT, MAX_META, MAX_TAGS, MAX_TAG_DATA, MAX_TAG_LABEL};

/// Canonical SHA-256 of the complete sealed content.
pub(crate) fn parse_id(id: &str) -> Result<String, Error> {
    if id.len() != 64 || !id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
        return Err(Error::BadRequest(
            "id must be a lowercase SHA-256 hash".into(),
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
struct PostDocument<'a> {
    #[serde(with = "serde_bytes", borrow)]
    meta: &'a [u8],
    #[serde(with = "serde_bytes", borrow)]
    content: &'a [u8],
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

pub(crate) struct PostParts<'a> {
    pub meta: &'a [u8],
    pub content: &'a [u8],
    pub tags: Vec<Tag>,
}
pub(crate) struct MetaParts<'a> {
    pub prev_meta_hash: [u8; 32],
    pub meta: &'a [u8],
    pub tags: Vec<Tag>,
}

pub(crate) fn decode_post(bytes: &[u8]) -> Result<PostParts<'_>, Error> {
    let doc: PostDocument<'_> = codec::decode(bytes)?;
    if doc.meta.len() > MAX_META || doc.content.len() > MAX_CONTENT {
        return Err(Error::BadRequest("field too large".into()));
    }
    Ok(PostParts {
        meta: doc.meta,
        content: doc.content,
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
        crypto::check_blob(tag.label, MAX_TAG_LABEL)?;
        let sealed: crypto::Sealed<'_> = codec::decode(tag.label)?;
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::reference_crypto::{encode_meta, encode_post, fixture_tag_labels};
    #[test]
    fn memory_profile_frame_decoding() {
        use std::hint::black_box;

        // Fixture construction is outside measurement: we are measuring the
        // extra heap needed to decode an already buffered request.
        let metadata = vec![1; MAX_META];
        let content = vec![1; MAX_CONTENT];
        let post = encode_post(&metadata, &content, b"\x90");
        let put = encode_meta(&[0; 32], &metadata, b"\x90");
        let post_info = allocation_counter::measure(|| {
            let parts = decode_post(black_box(&post)).unwrap();
            black_box(parts);
        });
        let put_info = allocation_counter::measure(|| {
            let parts = decode_meta(black_box(&put)).unwrap();
            black_box(parts);
        });
        assert_eq!(post_info.count_total, 0, "{post_info:?}");
        assert_eq!(put_info.count_total, 0, "{put_info:?}");

        // Reproduce the old ciphertext copies as a positive control so the
        // measurement also demonstrates the allocation we removed.
        let copied_info = allocation_counter::measure(|| {
            let parts = decode_post(black_box(&post)).unwrap();
            let meta = parts.meta.to_vec();
            let content = parts.content.to_vec();
            black_box((&meta, &content));
        });
        assert_eq!(copied_info.bytes_total, (MAX_META + MAX_CONTENT) as u64);
        assert_eq!(copied_info.bytes_max, (MAX_META + MAX_CONTENT) as u64);
        assert_eq!(copied_info.bytes_current, 0);

        let tags = (0..MAX_TAGS)
            .map(|n| URL_SAFE_NO_PAD.encode([n as u8; 32]))
            .collect::<Vec<_>>()
            .join("\n");
        let small = encode_post(&metadata, &content[..1024], &fixture_tag_labels(&tags));
        let large = encode_post(&metadata, &content, &fixture_tag_labels(&tags));
        let measure = |body: &[u8]| {
            allocation_counter::measure(|| {
                black_box(decode_post(black_box(body)).unwrap());
            })
        };
        let small_info = measure(&small);
        let large_info = measure(&large);
        assert_eq!(small_info.bytes_total, large_info.bytes_total);
        assert_eq!(small_info.bytes_max, large_info.bytes_max);
        assert!(large_info.bytes_total <= 65536, "{large_info:?}");
        assert_eq!(large_info.bytes_current, 0);
        println!("POST without tags: {post_info:?}");
        println!("PUT without tags: {put_info:?}");
        println!("Old copy pattern: {copied_info:?}");
        println!("POST with 64 tags, 1 KiB content: {small_info:?}");
        println!("POST with 64 tags, maximum content: {large_info:?}");
    }

    #[test]
    fn labels_validate_every_entry_before_deduplicating() {
        use crate::reference_crypto::sealed_fixture;
        let label = sealed_fixture(1, 43);
        let duplicate = sealed_fixture(2, MAX_TAG_LABEL);
        let entries = vec![
            WireTag {
                token: &[1; 32],
                label: &label,
            },
            WireTag {
                token: &[1; 32],
                label: &duplicate,
            },
            WireTag {
                token: &[2; 32],
                label: &duplicate,
            },
        ];
        let tags = parse_tags(entries).unwrap();
        assert_eq!(tags.len(), 2);
        assert_eq!(tags[0].label, label);
        assert_eq!(tags[1].label, duplicate);
        for invalid in [
            vec![],
            sealed_fixture(0, 42),
            sealed_fixture(0, MAX_TAG_LABEL + 1),
        ] {
            assert!(parse_tags(vec![
                WireTag {
                    token: &[1; 32],
                    label: &label
                },
                WireTag {
                    token: &[1; 32],
                    label: &invalid
                }
            ])
            .is_err());
        }
        assert!(parse_tags(vec![WireTag {
            token: &[0; 31],
            label: &label
        }])
        .is_err());
    }

    #[test]
    fn full_tag_sets_fit_both_documents_and_limits_reject_excess() {
        let label = crate::reference_crypto::sealed_fixture(1, MAX_TAG_LABEL);
        for count in [MAX_TAGS, MAX_TAGS + 1] {
            let tokens: Vec<_> = (0..count).map(|n| [n as u8; 32]).collect();
            let entries: Vec<_> = tokens
                .iter()
                .map(|token| WireTag {
                    token,
                    label: &label,
                })
                .collect();
            let tags = codec::encode(&entries).unwrap();
            let post = decode_post(&encode_post(b"meta", b"content", &tags)).map(|p| p.tags.len());
            let meta = decode_meta(&encode_meta(&[0; 32], b"meta", &tags)).map(|p| p.tags.len());
            if count == MAX_TAGS {
                assert_eq!(post.unwrap(), count);
                assert_eq!(meta.unwrap(), count);
            } else {
                assert!(post.is_err());
                assert!(meta.is_err());
            }
        }
    }

    #[test]
    fn documents_borrow_binary_fields_and_reject_truncation_and_trailing_data() {
        let token = URL_SAFE_NO_PAD.encode([1; 32]);
        let body = encode_post(b"meta", b"content", &fixture_tag_labels(&token));
        let parts = decode_post(&body).unwrap();
        assert_eq!(parts.meta, b"meta");
        assert_eq!(parts.content, b"content");
        assert_eq!(parts.tags[0].token, token);
        for length in 0..body.len() {
            assert!(decode_post(&body[..length]).is_err());
        }
        let mut extra = body;
        extra.push(0xc0);
        assert!(decode_post(&extra).is_err());
        let body = encode_meta(&[7; 32], b"meta", b"\x90");
        let parts = decode_meta(&body).unwrap();
        assert_eq!(parts.prev_meta_hash, [7; 32]);
        let mut extra = body;
        extra.push(0xc0);
        assert!(decode_meta(&extra).is_err());
        assert!(decode_post(&encode_post(&vec![0; MAX_META + 1], b"", b"\x90")).is_err());
        assert!(decode_post(&encode_post(b"", &vec![0; MAX_CONTENT + 1], b"\x90")).is_err());
    }
}
