//! Length-prefixed upload and metadata frames, signed as exact binary bytes.
//!
//! ```text
//! POST /api/media
//!   uint32be  length of encrypted metadata
//!   bytes     metadata blob
//!   uint32be  length of encrypted content
//!   bytes     content blob
//!   uint32be  length of the tag-token text
//!   bytes     UTF-8 tokens separated by '\n'
//!
//! PUT /api/media/{id}
//!   uint32be  length of encrypted metadata
//!   bytes     metadata blob
//!   uint32be  length of the tag-token text
//!   bytes     UTF-8 tokens separated by '\n'
//! ```
//!
//! Lengths are big-endian. The JavaScript client in `client/src/lib/protocol/frame.js` writes
//! the same layout. `client/tests/test-vectors.json` includes one full POST frame.

use crate::Error;
use crate::MAX_CONTENT;
use crate::MAX_META;
use crate::MAX_TAGS;
use crate::MAX_TOKEN_TEXT;

pub(crate) struct PostParts<'body> {
    pub meta: &'body [u8],
    pub content: &'body [u8],
    pub tokens: Vec<String>,
}

pub(crate) struct MetaParts<'body> {
    pub meta: &'body [u8],
    pub tokens: Vec<String>,
}

pub fn encode_post(meta: &[u8], content: &[u8], tags: &str) -> Vec<u8> {
    let mut out = Vec::new();
    push_chunk(&mut out, meta);
    push_chunk(&mut out, content);
    push_chunk(&mut out, tags.as_bytes());
    out
}

pub fn encode_meta(meta: &[u8], tags: &str) -> Vec<u8> {
    let mut out = Vec::new();
    push_chunk(&mut out, meta);
    push_chunk(&mut out, tags.as_bytes());
    out
}

fn push_chunk(out: &mut Vec<u8>, data: &[u8]) {
    let len = u32::try_from(data.len()).expect("chunk fits in a u32");
    out.extend_from_slice(&len.to_be_bytes());
    out.extend_from_slice(data);
}

pub(crate) fn decode_post(bytes: &[u8]) -> Result<PostParts<'_>, Error> {
    let mut i = 0;
    let meta = read_chunk(bytes, &mut i, MAX_META)?;
    let content = read_chunk(bytes, &mut i, MAX_CONTENT)?;
    let tags = read_chunk(bytes, &mut i, MAX_TOKEN_TEXT)?;
    if i != bytes.len() {
        return Err(Error::BadRequest("trailing bytes in body".into()));
    }
    let tags =
        std::str::from_utf8(tags).map_err(|_| Error::BadRequest("tags are not utf-8".into()))?;
    Ok(PostParts {
        meta,
        content,
        tokens: parse_tokens(tags)?,
    })
}

pub(crate) fn decode_meta(bytes: &[u8]) -> Result<MetaParts<'_>, Error> {
    let mut i = 0;
    let meta = read_chunk(bytes, &mut i, MAX_META)?;
    let tags = read_chunk(bytes, &mut i, MAX_TOKEN_TEXT)?;
    if i != bytes.len() {
        return Err(Error::BadRequest("trailing bytes in body".into()));
    }
    let tags =
        std::str::from_utf8(tags).map_err(|_| Error::BadRequest("tags are not utf-8".into()))?;
    Ok(MetaParts {
        meta,
        tokens: parse_tokens(tags)?,
    })
}

/// Read a bounded slice borrowed from `data` and advance the cursor.
fn read_chunk<'a>(data: &'a [u8], i: &mut usize, max: usize) -> Result<&'a [u8], Error> {
    if data.len().saturating_sub(*i) < 4 {
        return Err(Error::BadRequest("truncated body".into()));
    }
    let len_bytes: [u8; 4] = data[*i..*i + 4].try_into().expect("4 bytes");
    let len = u32::from_be_bytes(len_bytes) as usize;
    *i += 4;
    // Check both the declared length and the bytes actually present, so a
    // huge length cannot walk off the end of the buffer.
    if len > max || data.len().saturating_sub(*i) < len {
        return Err(Error::BadRequest("truncated body".into()));
    }
    let chunk = &data[*i..*i + len];
    *i += len;
    Ok(chunk)
}

/// Split newline-separated HMAC tokens. Empty lines are ignored. Duplicates
/// are dropped so a repeated token cannot trip the SQL primary key.
pub(crate) fn parse_tokens(text: &str) -> Result<Vec<String>, Error> {
    collect_tokens(text.split('\n').map(str::trim))
}

/// 32 bytes of base64url with no padding is always 43 characters from this alphabet.
pub(crate) fn is_token(value: &str) -> bool {
    value.len() == 43
        && value
            .bytes()
            .all(|b| matches!(b, b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_'))
}

/// `?tag=` values, already split by the HTTP handler. Each value is trimmed,
/// then checked with the same rules as [`parse_tokens`].
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

    #[test]
    fn memory_profile_frame_decoding() {
        use std::hint::black_box;

        // Fixture construction is outside measurement: we are measuring the
        // extra heap needed to decode an already buffered request.
        let metadata = vec![1; MAX_META];
        let content = vec![1; MAX_CONTENT];
        let post = encode_post(&metadata, &content, "");
        let put = encode_meta(&metadata, "");
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
            .map(|n| format!("{n:043}"))
            .collect::<Vec<_>>()
            .join("\n");
        let small = encode_post(&metadata, &content[..1024], &tags);
        let large = encode_post(&metadata, &content, &tags);
        let measure = |body: &[u8]| {
            allocation_counter::measure(|| {
                black_box(decode_post(black_box(body)).unwrap());
            })
        };
        let small_info = measure(&small);
        let large_info = measure(&large);
        assert_eq!(small_info.bytes_total, large_info.bytes_total);
        assert_eq!(small_info.bytes_max, large_info.bytes_max);
        assert!(large_info.bytes_total <= 8192, "{large_info:?}");
        assert_eq!(large_info.bytes_current, 0);
        println!("POST without tags: {post_info:?}");
        println!("PUT without tags: {put_info:?}");
        println!("Old copy pattern: {copied_info:?}");
        println!("POST with 32 tags, 1 KiB content: {small_info:?}");
        println!("POST with 32 tags, maximum content: {large_info:?}");
    }

    #[test]
    fn post_roundtrip_and_truncation() {
        let body = encode_post(b"meta", b"content", "aaaa");
        // "aaaa" is not a 43-char token, so decode must reject it.
        assert!(decode_post(&body).is_err());
        let token = "A".repeat(43);
        let body = encode_post(b"meta", b"content", &token);
        let parts = decode_post(&body).unwrap();
        assert_eq!(parts.meta, b"meta");
        assert_eq!(parts.content, b"content");
        assert_eq!(parts.tokens, vec![token.clone()]);
        assert!(decode_post(&body[..body.len() - 1]).is_err());
        let mut extra = body.clone();
        extra.push(0);
        assert!(decode_post(&extra).is_err());
        let meta_body = encode_meta(b"meta", &token);
        let meta = decode_meta(&meta_body).unwrap();
        assert_eq!(meta.meta, b"meta");
        assert_eq!(meta.tokens, vec![token.clone()]);
        let other = "B".repeat(43);
        let queried = parse_query_tokens(vec![
            format!(" {token} "),
            String::new(),
            token.clone(),
            other.clone(),
        ])
        .unwrap();
        assert_eq!(queried, vec![token, other]);
        assert!(parse_query_tokens(vec!["nope".into()]).is_err());
        let many: Vec<String> = (0..33).map(|n| format!("{n:043}")).collect();
        assert!(parse_query_tokens(many).is_err());
    }
}
