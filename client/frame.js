// Same length-prefixed body as src/frame.rs. Lengths are big-endian uint32s.

import { concat, utf8 } from "./bytes.js";

export function encodePost({ id, meta, content, tags }) {
  return concat([
    chunk(utf8(id)),
    chunk(meta),
    chunk(content),
    chunk(utf8(tags)),
  ]);
}

export function encodeMeta({ meta, tags }) {
  return concat([chunk(meta), chunk(utf8(tags))]);
}

function chunk(data) {
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, data.length);
  return concat([len, data]);
}
