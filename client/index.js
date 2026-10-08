// Public API for the extension and for any other JavaScript host.
// Pass the text of an OpenSSH private key (`ssh-keygen -t ed25519 -N ''`).
// This module does not touch browser.storage.

export { authorizedLine, generatePrivateKey, parsePrivateKey } from "./openssh.js";
export {
  authorizationHeader,
  bodyHash,
  requestMessage,
  contentAad,
  decrypt,
  encrypt,
  freshNonce,
  loadKey,
  metaAad,
  normalizeTag,
  parseTagList,
  tagToken,
  tagTokens,
} from "./crypto.js";
export { encodeMeta, encodePost } from "./frame.js";
export {
  getContent,
  list,
  MAX_FILE_BYTES,
  registerKey,
  remove,
  updateMetadata,
  upload,
} from "./api.js";
export { sniffContentType } from "./metadata.js";
