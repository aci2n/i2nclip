import { notify } from "./notify.js";
import { bindUnlock } from "./secrets.js";
import { sendUpload } from "./send-upload.js";

const status = document.querySelector("#status");
bindUnlock(document.querySelector("#form"), status, async (privateKey) => {
  if (new URLSearchParams(location.search).get("resume") === "upload") {
    const stored = await browser.storage.session.get("pendingUpload");
    await browser.storage.session.remove("pendingUpload");
    if (stored.pendingUpload) {
      await sendUpload(stored.pendingUpload, privateKey, "");
      notify("Uploaded.");
    }
  }
  status.textContent = "Unlocked.";
  setTimeout(() => window.close(), 400);
});
