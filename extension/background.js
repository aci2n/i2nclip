// Background module so a context-menu click can upload without opening a page.
// The tag entry still opens upload.html, which imports the same client.

import { sendUpload } from "./send-upload.js";
import { sessionPrivateKey } from "./secrets.js";

browser.contextMenus.removeAll().then(() => {
  browser.contextMenus.create({
    id: "i2nclip-upload",
    title: "Upload to i2nclip",
    contexts: ["image", "video", "audio"],
  });
  browser.contextMenus.create({
    id: "i2nclip-upload-tags",
    title: "Upload to i2nclip with tags",
    contexts: ["image", "video", "audio"],
  });
});

browser.contextMenus.onClicked.addListener(async (info, tab) => {
  const source = {
    srcUrl: info.srcUrl || "",
    pageUrl: info.frameUrl || info.pageUrl || "",
    tabId: tab?.id,
  };
  if (info.menuItemId === "i2nclip-upload-tags") {
    await openTagWindow(source);
    return;
  }
  if (info.menuItemId === "i2nclip-upload") {
    await uploadNow(source);
  }
});

browser.action.onClicked.addListener(() => {
  browser.tabs.create({ url: browser.runtime.getURL("extension/library.html") });
});

async function uploadNow(source) {
  if (!source.srcUrl) {
    notify("Nothing to upload.");
    return;
  }
  const privateKey = await sessionPrivateKey();
  if (!privateKey) {
    await browser.storage.session.set({ pendingUpload: source });
    await browser.windows.create({
      url: browser.runtime.getURL("extension/unlock.html?resume=upload"),
      type: "popup",
      width: 420,
      height: 320,
    });
    return;
  }
  try {
    await sendUpload(source, privateKey, "");
    notify("Uploaded.");
  } catch (err) {
    notify(err.message || "Upload failed.");
  }
}

async function openTagWindow(source) {
  const id = crypto.randomUUID();
  await browser.storage.session.set({ [`upload:${id}`]: source });
  await browser.windows.create({
    url: browser.runtime.getURL(`extension/upload.html?id=${id}`),
    type: "popup",
    width: 420,
    height: 640,
  });
}

function notify(message) {
  browser.notifications.create({
    type: "basic",
    iconUrl: browser.runtime.getURL("extension/icon.svg"),
    title: "i2nclip",
    message,
  });
}

