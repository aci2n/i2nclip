import { MAX_FILE_BYTES, upload } from './api.js';
import { thumbnail } from './thumbnail.js';

export function fileName(url) {
  try { return decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || 'upload'); }
  catch { return 'upload'; }
}

export function checkFileSize(size) {
  if (size > MAX_FILE_BYTES) throw new Error('File is larger than 32 MB.');
}

// Enforce the limit while reading, even when Content-Length is absent or incorrect.
export async function readMedia(response, signal) {
  if (!response.ok) throw new Error(`Could not fetch the file (${response.status}).`);
  const declared = Number(response.headers.get('content-length'));
  if (declared > MAX_FILE_BYTES) {
    await response.body?.cancel();
    checkFileSize(declared);
  }
  if (!response.body) return new Blob([], { type: response.headers.get('content-type') || '' });
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  const abort = () => reader.cancel();
  signal?.addEventListener('abort', abort, { once: true });
  try {
    signal?.throwIfAborted();
    while (true) {
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      size += value.length;
      checkFileSize(size);
      chunks.push(value);
    }
    return new Blob(chunks, { type: response.headers.get('content-type') || '' });
  } finally {
    signal?.removeEventListener('abort', abort);
    await reader.cancel();
    reader.releaseLock();
  }
}

export async function prepareMedia(source, platform, signal) {
  let blob = source.blob;
  if (!blob && source.bytes) {
    checkFileSize(source.bytes.byteLength);
    blob = new Blob([source.bytes], { type: source.contentType || '' });
  }
  blob ??= await readMedia(await platform.fetchMedia(source, signal), signal);
  checkFileSize(blob.size);
  signal?.throwIfAborted();
  return { ...source, blob, name: source.name || fileName(source.srcUrl) };
}

export async function sendUpload(source, credentials, platform, tags = '', onProgress, signal) {
  const prepared = await prepareMedia(source, platform, signal);
  const bytes = new Uint8Array(await prepared.blob.arrayBuffer());
  const preview = await thumbnail(prepared.blob);
  signal?.throwIfAborted();
  return upload({
    ...credentials, bytes, name: prepared.name,
    contentType: prepared.contentType || prepared.blob.type || 'application/octet-stream',
    tags, image: preview?.image, thumb: preview?.thumb, onProgress, signal,
  });
}
