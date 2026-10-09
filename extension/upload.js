import { fetchMedia } from "./fetch-media.js";
import { bindUnlock, sessionPrivateKey } from "./secrets.js";
import { fileName, sendUpload } from "./send-upload.js";

await setupUpload();

async function setupUpload() {
  const id = new URLSearchParams(location.search).get("id");
  const stored = await browser.storage.session.get(`upload:${id}`);
  const source = stored[`upload:${id}`];
  const status = document.querySelector("#status");

  if (!source?.srcUrl) {
    status.textContent = "Nothing to upload.";
    return;
  }
  const send = document.querySelector("#send");
  try {
    const response = await fetchMedia(source);
    const blob = await response.blob();
    const bytes = await blob.bytes();
    const name = fileName(source.srcUrl);
    document.querySelector("#name").textContent = name;
    if (blob.type.startsWith("image/")) {
      const preview = document.querySelector("#preview");
      const url = URL.createObjectURL(blob);
      preview.hidden = false;
      preview.src = url;
      window.addEventListener("pagehide", () => URL.revokeObjectURL(url), { once: true });
    }
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
  } catch (err) {
    status.textContent = err.message || "Could not load the file.";
    send.querySelector("button[type=submit]").disabled = true;
  }
}
