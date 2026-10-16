//! One MessagePack document, using named maps and binary byte fields.

use std::io::ErrorKind;

use serde::{Deserialize, Serialize};

use crate::Error;

pub const CONTENT_TYPE: &str = "application/msgpack";

pub fn encode(value: &impl Serialize) -> Result<Vec<u8>, Error> {
    rmp_serde::to_vec_named(value)
        .map_err(|_| Error::BadRequest("invalid MessagePack document".into()))
}

pub fn decode<'a, T: Deserialize<'a>>(bytes: &'a [u8]) -> Result<T, Error> {
    let mut decoder = rmp_serde::Deserializer::from_read_ref(bytes);
    decoder.set_max_depth(32);
    let value = T::deserialize(&mut decoder)
        .map_err(|_| Error::BadRequest("invalid MessagePack document".into()))?;
    // A scalar probe reads exactly one marker. A recursive probe could mistake
    // an incomplete trailing array/map for the end of the original document.
    match u8::deserialize(&mut decoder) {
        Err(rmp_serde::decode::Error::InvalidMarkerRead(error))
            if error.kind() == ErrorKind::UnexpectedEof =>
        {
            Ok(value)
        }
        _ => Err(Error::BadRequest("trailing MessagePack data".into())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug, PartialEq, Serialize, Deserialize)]
    struct Document<'a> {
        v: u8,
        #[serde(with = "serde_bytes", borrow)]
        data: &'a [u8],
    }

    #[test]
    fn named_maps_and_binary_fields_match_javascript() {
        let document = Document {
            v: 1,
            data: &[0, 255],
        };
        let bytes = encode(&document).unwrap();
        assert_eq!(bytes, b"\x82\xa1v\x01\xa4data\xc4\x02\x00\xff");
        assert_eq!(decode::<Document<'_>>(&bytes).unwrap(), document);
        assert_eq!(CONTENT_TYPE, "application/msgpack");
        for invalid in [&bytes[..bytes.len() - 1], &[][..], b"\xc1"] {
            assert!(decode::<Document<'_>>(invalid).is_err());
        }
        for marker in 0..=u8::MAX {
            let mut extra = bytes.clone();
            extra.push(marker);
            assert!(
                decode::<Document<'_>>(&extra).is_err(),
                "trailing {marker:02x}"
            );
        }
    }

    #[test]
    fn binary_decoding_borrows_the_buffer_without_content_sized_allocations() {
        let content = vec![7; 32 * 1024 * 1024];
        let bytes = encode(&Document {
            v: 1,
            data: &content,
        })
        .unwrap();
        let allocations = allocation_counter::measure(|| {
            let document: Document<'_> = decode(&bytes).unwrap();
            assert_eq!(document.data.len(), content.len());
            assert!(document.data.as_ptr() >= bytes.as_ptr());
            assert!(document.data.as_ptr_range().end <= bytes.as_ptr_range().end);
        });
        assert_eq!(allocations.bytes_total, 0, "{allocations:?}");
    }
}
