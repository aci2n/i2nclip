// A small WebP for the library card. Raw bytes sit after the JSON in the
// encrypted metadata envelope, so the list can paint a card without
// downloading the original. Audio uses embedded cover art when the file has
// some. A failure here just means the card has no preview.

import { audioArt } from "../client/audio-art.js";

const EDGE = 320;

export async function thumbnail(blob) {
  const type = blob.type || "";
  try {
    if (type.startsWith("audio/")) {
      const art = audioArt(await blob.bytes());
      if (!art) return null;
      return await fromBitmap(new Blob([art]));
    }
    if (type.startsWith("video/")) return await fromVideo(blob);
    return await fromBitmap(blob);
  } catch {
    return null;
  }
}

async function fromBitmap(blob) {
  const bitmap = await createImageBitmap(blob);
  try {
    const thumb = await webp(bitmap);
    if (!thumb) return null;
    return { thumb, image: { width: bitmap.width, height: bitmap.height } };
  } finally {
    bitmap.close();
  }
}

async function webp(source) {
  const width = source.videoWidth || source.width;
  const height = source.videoHeight || source.height;
  if (!width || !height) return null;
  const scale = Math.min(1, EDGE / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  canvas.getContext("2d").drawImage(source, 0, 0, canvas.width, canvas.height);
  const file = await new Promise((resolve) => canvas.toBlob(resolve, "image/webp", 0.75));
  return file ? file.bytes() : null;
}

function fromVideo(blob) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      URL.revokeObjectURL(url);
      video.removeAttribute("src");
      video.load();
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), 8000);
    video.addEventListener("error", () => finish(null));
    video.addEventListener("loadeddata", async () => {
      try {
        const thumb = await webp(video);
        finish(thumb ? { thumb, image: { width: video.videoWidth, height: video.videoHeight } } : null);
      } catch { finish(null); }
    });
    video.src = url;
  });
}
