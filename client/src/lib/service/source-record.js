import {concat, utf8} from "../protocol/bytes.js";

// Preserve binary uploads without JSON/base64 expansion before vault encryption.
export async function encodeSource(source) {
 const value = {...source, preview: source.preview ? {...source.preview} : source.preview};
 const parts = [];
 const descriptors = [];
 async function take(field, binary, type) {
  if (binary === undefined || binary === null) return;
  const bytes = binary instanceof Blob ? new Uint8Array(await binary.arrayBuffer()) : new Uint8Array(binary.buffer || binary, binary.byteOffset || 0, binary.byteLength);
  parts.push(bytes); descriptors.push({field, length: bytes.length, type});
 }
 await take("blob", source.blob, source.blob?.type);
 await take("bytes", source.bytes);
 await take("thumb", source.preview?.thumb);
 delete value.blob; delete value.bytes;
 if (value.preview) delete value.preview.thumb;
 const header = utf8(JSON.stringify({v: 1, value, descriptors}));
 if (header.length > 65536) throw new Error("Upload source metadata is too large.");
 const size = new Uint8Array(4); new DataView(size.buffer).setUint32(0, header.length);
 return concat([size, header, ...parts]);
}
export function decodeSource(bytes) {
 if (bytes.length < 4) throw new Error("Invalid saved upload source.");
 const length = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0);
 if (length > 65536 || length + 4 > bytes.length) throw new Error("Invalid saved upload source.");
 const {v, value, descriptors} = JSON.parse(new TextDecoder().decode(bytes.subarray(4, length + 4)));
 if (v !== 1 || !value || !Array.isArray(descriptors) || descriptors.length > 3) throw new Error("Invalid saved upload source.");
 let offset = length + 4;
 const seen = new Set();
 for (const {field, length: size, type} of descriptors) {
  if (!["blob", "bytes", "thumb"].includes(field) || seen.has(field) || !Number.isSafeInteger(size) || size < 0 || offset + size > bytes.length) throw new Error("Invalid saved upload source.");
  seen.add(field);
  const part = bytes.slice(offset, offset + size); offset += size;
  if (field === "blob") value.blob = new Blob([part], {type});
  else if (field === "bytes") value.bytes = part;
  else {value.preview ||= {}; value.preview.thumb = part;}
 }
 if (offset !== bytes.length) throw new Error("Invalid saved upload source.");
 return value;
}
