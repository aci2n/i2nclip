// Plaintext inside the encrypted metadata blob (before AES-GCM).
//
//   uint32be  json length
//   bytes     UTF-8 JSON (name, tags, content_type, size, image — no thumb)
//   uint32be  thumb length (0 = none)
//   bytes     WebP preview bytes

import { chunk, concat, utf8 } from "./bytes.js";

/** Room left for the 1-byte version, 12-byte nonce, and 16-byte GCM tag. */
export const MAX_META_PLAINTEXT = 64 * 1024 - 29;

export function encodeMetaPlain(metadata, thumb) {
  const clean = { ...metadata };
  delete clean.thumb;
  const json = utf8(JSON.stringify(clean));
  const preview = thumb?.length ? thumb : new Uint8Array();
  return concat([chunk(json), chunk(preview)]);
}

export function decodeMetaPlain(bytes) {
  let o = 0;
  const json = readChunk(bytes, o);
  o += 4 + json.length;
  const thumb = readChunk(bytes, o);
  o += 4 + thumb.length;
  if (o !== bytes.length) {
    throw new Error("trailing metadata");
  }
  const metadata = JSON.parse(new TextDecoder().decode(json));
  delete metadata.thumb;
  return {
    metadata,
    thumb: thumb.length ? thumb : null,
  };
}

function readChunk(bytes, offset) {
  if (bytes.length - offset < 4) throw new Error("truncated metadata");
  const len = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0);
  offset += 4;
  if (bytes.length - offset < len) throw new Error("truncated metadata");
  return bytes.subarray(offset, offset + len);
}

