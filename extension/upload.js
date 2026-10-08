import { fetchMedia } from "./fetch-media.js";
import { bindUnlock, sessionPrivateKey } from "./secrets.js";
import { fileName, sendUpload } from "./send-upload.js";

const params = new URLSearchParams(location.search);
const stored = await browser.storage.session.get(`upload:${params.get("id")}`);
const source = stored[`upload:${params.get("id")}`];
const srcUrl = source?.srcUrl;
const status = document.querySelector("#status");
const nameEl = document.querySelector("#name");

if (!srcUrl) {
  status.textContent = "Nothing to upload.";
} else {
  const response = await fetchMedia(source);
  const blob = await response.blob();
  const bytes = await blob.bytes();
  const name = fileName(srcUrl);
  nameEl.textContent = name;
  if (blob.type.startsWith("image/")) {
    const preview = document.querySelector("#preview");
    preview.hidden = false;
    preview.src = URL.createObjectURL(blob);
  }
  const send = document.querySelector("#send");
  send.addEventListener("submit", async (event) => {
    event.preventDefault();
    const privateKey = await sessionPrivateKey();
    if (!privateKey) {
      document.querySelector("#unlock").hidden = false;
      status.textContent = "Unlock to upload.";
      return;
    }
    status.textContent = "Uploading…";
    try {
      await sendUpload(
        { ...source, bytes, blob, name, contentType: blob.type || "application/octet-stream" },
        privateKey,
        document.querySelector("#tags").value,
      );
      window.close();
    } catch (err) {
      status.textContent = err.message;
    }
  });
  bindUnlock(document.querySelector("#unlock"), status, async () => {
    document.querySelector("#unlock").hidden = true;
    status.textContent = "Unlocked.";
    send.requestSubmit();
  });
}
