export const STREAM_PREFIX = "/__content/";
export const STREAM_READ_BYTES = 4 * 1024 * 1024;
export const BRIDGE_TIMEOUT_MS = 30_000;
export const HEARTBEAT_MS = 10_000;

export interface StreamDescription {
	size: number;
	type: string;
	name: string;
}

export type WorkerMessage =
	| { kind: "open"; token: string; download?: boolean }
	| { kind: "read"; start: number; end: number }
	| { kind: "complete" }
	| { kind: "cancel" }
	| { kind: "pong" };

export type PageMessage =
	| { kind: "description"; value: StreamDescription }
	| { kind: "bytes"; value: ArrayBuffer }
	| { kind: "error"; message: string }
	| { kind: "ping" };
