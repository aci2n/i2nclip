export function fileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function uploadedAt(seconds) {
  return seconds ? new Date(seconds * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';
}

export function downloadName(name, type) {
  const base = String(name || 'download').split(/[/\\]/).pop() || 'download';
  const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'video/mp4': 'mp4', 'video/webm': 'webm', 'audio/mpeg': 'mp3', 'audio/ogg': 'ogg', 'audio/wav': 'wav' }[type];
  return base.includes('.') || !ext ? base : `${base}.${ext}`;
}

export function fileType(type) {
  return ({ 'image/jpeg': 'JPEG', 'audio/mpeg': 'MP3', 'application/octet-stream': 'FILE' })[type]
    || (type.split('/')[1]?.split(/[;+]/)[0] || 'FILE').toUpperCase();
}
