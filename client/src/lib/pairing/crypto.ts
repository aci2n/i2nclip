import * as opaque from "@serenity-kit/opaque";
import { decode, encode } from "../protocol/msgpack.ts";
import type { PairingKeys } from "../protocol/pairing.ts";
import { openPairing, pairingKeys, sealPairing } from "../protocol/pairing.ts";
import { bytes as binary, document, string } from "../protocol/value.ts";
export interface PairingCrypto {
	senderSetup(args: { context: string; secret: string }): Promise<null>;
	receiverStart(args: { secret: string }): Promise<Uint8Array<ArrayBuffer>>;
	senderResponse(args: {
		message: Uint8Array<ArrayBuffer>;
	}): Promise<Uint8Array<ArrayBuffer>>;
	receiverFinish(args: {
		context: string;
		message: Uint8Array<ArrayBuffer>;
	}): Promise<Uint8Array<ArrayBuffer>>;
	senderFinish(args: { message: Uint8Array<ArrayBuffer> }): Promise<null>;
	verificationCode(): Promise<string>;
	transfer(args: { value: unknown }): Promise<Uint8Array<ArrayBuffer>>;
	receive(args: { message: Uint8Array<ArrayBuffer> }): Promise<unknown>;
	acknowledge(): Promise<Uint8Array<ArrayBuffer>>;
	verifyAcknowledgment(args: {
		message: Uint8Array<ArrayBuffer>;
	}): Promise<null>;
	dispose(): void;
}
type CryptoState =
	| { phase: "initial" | "failed" | "complete" | "disposed" }
	| { phase: "sender-wait"; context: string; setup: string; record: string }
	| { phase: "sender-finish"; context: string; loginState: string }
	| { phase: "receiver-wait"; secret: string; loginState: string }
	| {
			phase:
				| "sender-authenticated"
				| "receiver-authenticated"
				| "sender-acknowledgment"
				| "receiver-save";
			context: string;
			keys: PairingKeys;
	  };

function identifiers(context: string) {
	return {
		client: `${context} receiver verification-code`,
		server: `${context} sender verification-code`,
	};
}
const invalidStep = () => new Error("Invalid pairing step.");

export function createPairingCrypto(): PairingCrypto {
	let state: CryptoState = { phase: "initial" };
	function active() {
		if (state.phase === "disposed") {
			throw new DOMException("Pairing ended.", "AbortError");
		}
	}
	return {
		async senderSetup(args: { context: string; secret: string }) {
			await opaque.ready;
			active();
			const current = state;

			if (current.phase !== "initial") {
				throw invalidStep();
			}
			state = { phase: "failed" };
			const { context, secret } = args;
			const setup = opaque.server.createSetup();
			const registration = opaque.client.startRegistration({
				password: secret,
			});
			const response = opaque.server.createRegistrationResponse({
				serverSetup: setup,
				userIdentifier: context,
				registrationRequest: registration.registrationRequest,
			});
			const { registrationRecord: record } = opaque.client.finishRegistration({
				clientRegistrationState: registration.clientRegistrationState,
				registrationResponse: response.registrationResponse,
				password: secret,
				identifiers: identifiers(context),
			});
			state = { phase: "sender-wait", context, setup, record };
			return null;
		},
		async receiverStart(args: { secret: string }) {
			await opaque.ready;
			active();
			const current = state;

			if (current.phase !== "initial") {
				throw invalidStep();
			}
			const result = opaque.client.startLogin({ password: args.secret });
			state = {
				phase: "receiver-wait",
				secret: args.secret,
				loginState: result.clientLoginState,
			};
			return encode(result.startLoginRequest);
		},
		async senderResponse(args: { message: Uint8Array<ArrayBuffer> }) {
			await opaque.ready;
			active();
			const current = state;

			if (current.phase !== "sender-wait") {
				throw invalidStep();
			}
			state = { phase: "failed" };
			const result = opaque.server.startLogin({
				serverSetup: current.setup,
				userIdentifier: current.context,
				registrationRecord: current.record,
				startLoginRequest: string(decode(args.message)),
				identifiers: identifiers(current.context),
			});
			state = {
				phase: "sender-finish",
				context: current.context,
				loginState: result.serverLoginState,
			};
			return encode(result.loginResponse);
		},
		async receiverFinish(args: {
			context: string;
			message: Uint8Array<ArrayBuffer>;
		}) {
			await opaque.ready;
			active();
			const current = state;

			if (current.phase !== "receiver-wait") {
				throw invalidStep();
			}
			state = { phase: "failed" };
			const result = opaque.client.finishLogin({
				clientLoginState: current.loginState,
				loginResponse: string(decode(args.message)),
				password: current.secret,
				identifiers: identifiers(args.context),
			});
			if (!result) {
				throw new Error("Pairing authentication failed.");
			}
			const keys = await pairingKeys(result.sessionKey, args.context);
			active();
			state = {
				phase: "receiver-authenticated",
				context: args.context,
				keys,
			};
			return encode(result.finishLoginRequest);
		},
		async senderFinish(args: { message: Uint8Array<ArrayBuffer> }) {
			await opaque.ready;
			active();
			const current = state;

			if (current.phase !== "sender-finish") {
				throw invalidStep();
			}
			state = { phase: "failed" };
			const result = opaque.server.finishLogin({
				serverLoginState: current.loginState,
				finishLoginRequest: string(decode(args.message)),
			});
			const keys = await pairingKeys(result.sessionKey, current.context);
			active();
			state = {
				phase: "sender-authenticated",
				context: current.context,
				keys,
			};
			return null;
		},
		async verificationCode() {
			await opaque.ready;
			active();
			const current = state;

			if (
				current.phase !== "sender-authenticated" &&
				current.phase !== "receiver-authenticated"
			) {
				throw invalidStep();
			}
			return current.keys.verificationCode;
		},
		async transfer(args: { value: unknown }) {
			await opaque.ready;
			active();
			const current = state;

			if (current.phase !== "sender-authenticated") {
				throw invalidStep();
			}
			state = { ...current, phase: "sender-acknowledgment" };
			return sealPairing(current.keys, current.context, "transfer", args.value);
		},
		async receive(args: { message: Uint8Array<ArrayBuffer> }) {
			await opaque.ready;
			active();
			const current = state;

			if (current.phase !== "receiver-authenticated") {
				throw invalidStep();
			}
			state = { ...current, phase: "receiver-save" };
			return openPairing(
				current.keys,
				current.context,
				"transfer",
				args.message,
			);
		},
		async acknowledge() {
			await opaque.ready;
			active();
			const current = state;

			if (current.phase !== "receiver-save") {
				throw invalidStep();
			}
			state = { phase: "complete" };
			return sealPairing(current.keys, current.context, "acknowledgment", {
				v: 1,
				saved: true,
			});
		},
		async verifyAcknowledgment(args: { message: Uint8Array<ArrayBuffer> }) {
			await opaque.ready;
			active();
			const current = state;

			if (current.phase !== "sender-acknowledgment") {
				throw invalidStep();
			}
			state = { phase: "complete" };
			const value = document(
				await openPairing(
					current.keys,
					current.context,
					"acknowledgment",
					binary(args.message),
				),
			);
			if (value.v !== 1 || value.saved !== true) {
				throw new Error("Invalid pairing acknowledgment.");
			}
			return null;
		},
		dispose() {
			state = { phase: "disposed" };
		},
	};
}
