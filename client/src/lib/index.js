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
} from "./crypto.js";
export { encodeMeta, encodePost } from "./frame.js";
export { generatePrivateKey, parsePrivateKey } from "./identity.js";
export { sniffContentType } from "./metadata.js";
