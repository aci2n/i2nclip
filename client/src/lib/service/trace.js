// Browser owners trace in every build. Keep CLI stdout available for its results.
export const serviceTracing = typeof self !== "undefined";

const secrets =
	/^(password|currentPassword|masterPassword|recoveryPassword|vaultKey|encrypted|libraries|passphrase|privateKey|wrappedKey|publicKey|public_key|code|verificationCode|otc|invitation|secret|capability|authorization|ciphertext|record|loginState|metadata|tags|tokens|query|searchDraft|srcUrl|originalUrl|serverUrl|server|name|error|status|message|content)$/i;
const traceFields = new Set([
	"type",
	"requestId",
	"instanceId",
	"clientId",
	"id",
	"batchId",
	"jobId",
	"libraryId",
	"runtimeId",
	"command",
	"topic",
	"method",
	"route",
	"failure",
	"binary",
	"phase",
	"role",
]);

export function summarizeMessage(value, depth = 0) {
	if (value instanceof Blob)
		return { binary: "Blob", size: value.size, type: value.type };
	if (value instanceof ArrayBuffer || ArrayBuffer.isView(value))
		return { binary: value.constructor.name, byteLength: value.byteLength };
	if (typeof value === "string") return value.slice(0, 160);
	if (!value || typeof value !== "object") return value;
	if (depth >= 6) return "[nested object]";
	if (Array.isArray(value)) {
		const items = value
			.slice(0, 20)
			.map((item) => summarizeMessage(item, depth + 1));
		if (value.length > 20) items.push(`[${value.length - 20} more items]`);
		return items;
	}
	return Object.fromEntries(
		Object.entries(value)
			.slice(0, 40)
			.map(([key, item]) => [
				key,
				(secrets.test(key) && typeof item !== "boolean") ||
				(typeof item === "string" && !traceFields.has(key))
					? "[redacted]"
					: summarizeMessage(item, depth + 1),
			]),
	);
}

export function traceMessage(direction, clientId, message) {
	const command =
		typeof message.name === "string" &&
		/^(identity|view|media|uploads|pending|pairing|libraries|vault)\.[a-zA-Z]+$/.test(
			message.name,
		)
			? message.name
			: undefined;
	traceEvent(direction, {
		clientId,
		type: message.type,
		command,
		topic: message.topic,
		snapshot: summarizeMessage(message),
	});
}

export function errorDetails(error) {
	return {
		failure: [
			"AbortError",
			"TimeoutError",
			"TypeError",
			"QuotaExceededError",
			"ConstraintError",
		].includes(error?.name)
			? error.name
			: "Error",
		httpStatus: Number.isInteger(error?.status) ? error.status : undefined,
	};
}

export function traceEvent(event, details = {}) {
	if (!serviceTracing) return;
	// Logging must never prevent delivery or turn successful work into a failure.
	try {
		console.debug(`[i2nclip service] ${event}`, summarizeMessage(details));
	} catch {}
}

let requestSerial = 0;
export async function traceRequest(method, path, request) {
	const raw = path.split("?")[0];
	const route = raw.startsWith("/api/media")
		? raw.replace(/\/media\/[^/]+/, "/media/:id")
		: raw.startsWith("/api/pairings")
			? raw.replace(/\/pairings\/[^/]+/, "/pairings/:id")
			: [
						"/api/ping",
						"/api/register-key",
						"/api/register-key/authenticated",
					].includes(raw)
				? raw
				: "[remote source]";
	const requestId = `http-${++requestSerial}`;
	const started = performance.now();
	traceEvent("request.start", { requestId, method, route });
	try {
		const response = await request();
		traceEvent("request.response", {
			requestId,
			method,
			route,
			httpStatus: response.status,
			durationMs: Math.round(performance.now() - started),
		});
		return response;
	} catch (error) {
		traceEvent("request.failed", {
			requestId,
			method,
			route,
			...errorDetails(error),
			durationMs: Math.round(performance.now() - started),
		});
		throw error;
	}
}
