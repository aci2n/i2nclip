import { MAX_FILE_BYTES, upload } from "../client/index.js";
import { fetchMedia } from "./fetch-media.js";
import { readLocal } from "./secrets.js";
import { thumbnail } from "./thumb.js";

export async function sendUpload(source, privateKey, tags, onProgress) {
  const { serverUrl } = await readLocal();
  if (!serverUrl || !privateKey) {
    throw new Error("Set the server and private key in the extension options.");
  }
  let blob = source.blob ?? null;
  let bytes = source.bytes ?? null;
  if (!bytes) {
    const response = await fetchMedia(source);
    blob = await response.blob();
    bytes = await blob.bytes();
  }
  if (bytes.length > MAX_FILE_BYTES) {
    throw new Error("File is larger than 32 MB.");
  }
  blob ??= new Blob([bytes], { type: source.contentType || "" });
  const contentType = source.contentType || blob.type || "application/octet-stream";
  const preview = await thumbnail(blob);
  await upload({
    serverUrl,
    privateKey,
    bytes,
    name: source.name || fileName(source.srcUrl),
    contentType,
    tags,
    image: preview?.image ?? null,
    thumb: preview?.thumb ?? null,
    onProgress,
  });
}

export function fileName(url) {
  try {
    const last = new URL(url).pathname.split("/").filter(Boolean).pop() || "upload";
    return decodeURIComponent(last);
  } catch {
    return "upload";
  }
}
