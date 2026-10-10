// Public API for the extension and for any other JavaScript host.
// Pass the internal identity document returned by generatePrivateKey().
// This module has no Firefox or UI dependencies.

export {
	getContent,
	list,
	MAX_FILE_BYTES,
	registerKey,
	remove,
	updateMetadata,
	upload,
} from "./api.js";
export { sniffContentType } from "./media/metadata.js";
export {
	authorizationHeader,
	bodyHash,
	contentAad,
	decrypt,
	encrypt,
	freshNonce,
	loadKey,
	metaAad,
	normalizeTag,
	parseTagList,
	requestMessage,
	splitTags,
	tagToken,
	tagTokens,
} from "./protocol/crypto.js";
export { encodeMeta, encodePost } from "./protocol/frame.js";
export { generatePrivateKey, parsePrivateKey } from "./protocol/identity.js";
