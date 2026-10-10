//! The upload body is a tiny binary frame, not multipart and not JSON.
//!
//! JSON would base64 the file and make it a third larger. Multipart needs a
//! boundary that must not appear inside the ciphertext, and the signature has
//! to cover the exact bytes. A length prefix is the same idea as
//! `DataOutputStream.writeInt` followed by `write(bytes)` in Java:
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

pub(crate) struct PostParts {
    pub meta: Vec<u8>,
    pub content: Vec<u8>,
    pub tokens: Vec<String>,
}

pub(crate) struct MetaParts {
    pub meta: Vec<u8>,
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

pub(crate) fn decode_post(bytes: &[u8]) -> Result<PostParts, Error> {
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
        meta: meta.to_vec(),
        content: content.to_vec(),
        tokens: parse_tokens(tags)?,
    })
}

pub(crate) fn decode_meta(bytes: &[u8]) -> Result<MetaParts, Error> {
    let mut i = 0;
    let meta = read_chunk(bytes, &mut i, MAX_META)?;
    let tags = read_chunk(bytes, &mut i, MAX_TOKEN_TEXT)?;
    if i != bytes.len() {
        return Err(Error::BadRequest("trailing bytes in body".into()));
    }
    let tags =
        std::str::from_utf8(tags).map_err(|_| Error::BadRequest("tags are not utf-8".into()))?;
    Ok(MetaParts {
        meta: meta.to_vec(),
        tokens: parse_tokens(tags)?,
    })
}

/// Read one length-prefixed slice.
///
/// `i` is the current offset and is moved forward. That is the Rust version of
/// passing an `int[]` of one element in Java so a method can update the cursor.
/// Returning a sub-slice (`&[u8]`) borrows from `data` instead of copying.
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
