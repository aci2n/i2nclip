export function notify(message) {
  return browser.notifications.create({
    type: "basic",
    iconUrl: browser.runtime.getURL("extension/icon.svg"),
    title: "i2nclip",
    message,
  });
}
