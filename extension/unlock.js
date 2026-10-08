import { bindUnlock } from "./secrets.js";
import { sendUpload } from "./send-upload.js";

const status = document.querySelector("#status");
const params = new URLSearchParams(location.search);

bindUnlock(document.querySelector("#form"), status, async (privateKey) => {
  if (params.get("resume") === "upload") {
    const stored = await browser.storage.session.get("pendingUpload");
    await browser.storage.session.remove("pendingUpload");
    if (stored.pendingUpload) {
      await sendUpload(stored.pendingUpload, privateKey, "");
      browser.notifications.create({
        type: "basic",
        iconUrl: browser.runtime.getURL("extension/icon.svg"),
        title: "i2nclip",
        message: "Uploaded.",
      });
    }
  }
  status.textContent = "Unlocked.";
  setTimeout(() => window.close(), 400);
});
