export type SessionChannel = Pick<
	BroadcastChannel,
	"postMessage" | "close" | "addEventListener" | "removeEventListener"
>;
interface Grant {
	record: string;
	key: CryptoKey;
}

// This transport owns discovery only. The session validates and installs access.
export function createSessionSharing({
	channel: factory = () =>
		typeof window === "undefined"
			? null
			: new BroadcastChannel("i2nclip-session-v1"),
	current,
	lockedRecord,
	accept,
	checking,
}: {
	channel?: () => SessionChannel | null;
	current: () => Grant | null;
	lockedRecord: () => string | null;
	accept: (grant: Grant, signal: AbortSignal) => Promise<void>;
	checking: (value: boolean) => void;
}) {
	let channel: SessionChannel | null = null;
	let pending: {
		id: string;
		record: string;
		controller: AbortController;
	} | null = null;
	let timer: ReturnType<typeof setTimeout> | undefined;
	function cancel() {
		pending?.controller.abort();
		pending = null;
		clearTimeout(timer);
		checking(false);
	}
	function send(message: unknown) {
		try {
			channel?.postMessage(message);
		} catch {
			dispose();
		}
	}
	function request(record: string | null) {
		cancel();
		if (!channel || record === null) {
			return;
		}
		pending = {
			id: crypto.randomUUID(),
			record,
			controller: new AbortController(),
		};
		checking(true);
		timer = setTimeout(() => checking(false), 500);
		send({ type: "request", id: pending.id, record });
	}
	function receive(event: MessageEvent<unknown>) {
		const data = event.data;
		if (
			!data ||
			typeof data !== "object" ||
			!("record" in data) ||
			typeof data.record !== "string" ||
			!("type" in data)
		) {
			return;
		}
		if (data.type === "available") {
			if (lockedRecord() === data.record) {
				request(data.record);
			}
		} else if (
			data.type === "request" &&
			"id" in data &&
			typeof data.id === "string"
		) {
			const grant = current();
			if (grant?.record === data.record) {
				send({ type: "grant", id: data.id, ...grant });
			}
		} else if (
			data.type === "grant" &&
			pending !== null &&
			"id" in data &&
			data.id === pending.id &&
			data.record === pending.record &&
			"key" in data &&
			data.key instanceof CryptoKey
		) {
			const key = data.key;
			if (
				key.extractable ||
				key.algorithm.name !== "AES-GCM" ||
				!key.usages.includes("encrypt") ||
				!key.usages.includes("decrypt")
			) {
				return;
			}
			void accept(
				{ record: data.record, key },
				pending.controller.signal,
			).catch(() => {});
		}
	}
	function dispose() {
		cancel();
		channel?.removeEventListener("message", receive);
		channel?.removeEventListener("messageerror", dispose);
		channel?.close();
		channel = null;
	}
	try {
		channel = factory();
		channel?.addEventListener("message", receive);
		channel?.addEventListener("messageerror", dispose);
	} catch {
		dispose();
	}
	return {
		request,
		cancel,
		dispose,
		announce: (record: string) => send({ type: "available", record }),
	};
}
