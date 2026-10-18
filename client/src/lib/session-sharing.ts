import { createLog, failureFields } from "./log.ts";
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
	const log = createLog("session-sharing");
	let operation = 0;
	let channel: SessionChannel | null = null;
	let pending: {
		id: string;
		record: string;
		controller: AbortController;
	} | null = null;
	let timer: ReturnType<typeof setTimeout> | undefined;
	function cancel() {
		if (pending) {
			log.debug("cancelled", { operation });
		}
		pending?.controller.abort();
		pending = null;
		clearTimeout(timer);
		checking(false);
	}
	function send(message: unknown) {
		try {
			channel?.postMessage(message);
		} catch (error) {
			log.warn("send-failed", failureFields(error));
			dispose();
		}
	}
	function request(record: string | null) {
		cancel();
		if (!channel || record === null) {
			return;
		}
		operation = log.operation();
		log.debug("requested", { operation });
		pending = {
			id: crypto.randomUUID(),
			record,
			controller: new AbortController(),
		};
		checking(true);
		timer = setTimeout(() => {
			log.debug("discovery-wait-elapsed", { operation });
			checking(false);
		}, 500);
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
			log.debug("available-received");
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
				log.debug("grant-sent");
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
				log.warn("grant-rejected", { operation, reason: "key-policy" });
				return;
			}
			const received = operation;
			const signal = pending.controller.signal;
			log.debug("grant-received", { operation: received });
			void accept(
				{ record: data.record, key },
				pending.controller.signal,
			).catch((error) => {
				if (signal.aborted) {
					log.debug("accept-cancelled", { operation: received });
				} else {
					log.warn("accept-failed", {
						operation: received,
						...failureFields(error),
					});
				}
			});
		}
	}
	function dispose() {
		log.debug("disposed");
		cancel();
		channel?.removeEventListener("message", receive);
		channel?.removeEventListener("messageerror", dispose);
		channel?.close();
		channel = null;
	}
	try {
		channel = factory();
		log.debug("channel-ready", { available: Boolean(channel) });
		channel?.addEventListener("message", receive);
		channel?.addEventListener("messageerror", dispose);
	} catch (error) {
		log.warn("channel-failed", failureFields(error));
		dispose();
	}
	return {
		request,
		cancel,
		dispose,
		announce(record: string) {
			log.debug("announced");
			send({ type: "available", record });
		},
	};
}
