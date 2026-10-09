import { validateWrappedKey } from "./vault.js";

export function recoveryFile({ serverUrl, wrappedKey }) {
  const recovery = { format: "i2nclip-recovery", v: 1, serverUrl, wrappedKey };
  parseRecoveryFile(JSON.stringify(recovery));
  return JSON.stringify(recovery, null, 2) + "\n";
}

export function parseRecoveryFile(text) {
  let value;
  try { value = JSON.parse(text); } catch { throw new Error("Invalid recovery file."); }
  if (value?.format !== "i2nclip-recovery" || value.v !== 1 || typeof value.serverUrl !== "string") {
    throw new Error("Invalid recovery file.");
  }
  let url;
  try { url = new URL(value.serverUrl); } catch { throw new Error("Invalid recovery server URL."); }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("Invalid recovery server URL.");
  }
  validateWrappedKey(value.wrappedKey);
  return { serverUrl: value.serverUrl, wrappedKey: value.wrappedKey };
}
