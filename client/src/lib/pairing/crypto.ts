import * as opaque from "@serenity-kit/opaque";
import { fixedBytes } from "../protocol/chain.ts";
import { decode, encode } from "../protocol/msgpack.ts";
import type { PairingKeys } from "../protocol/pairing.ts";
import { openPairing, pairingKeys, sealPairing } from "../protocol/pairing.ts";
import { bytes as binary, string } from "../protocol/value.ts";
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
	bindReceiver(args: {
		publicKey: Uint8Array<ArrayBuffer>;
	}): Promise<Uint8Array<ArrayBuffer>>;
	verifyReceiverBinding(args: {
		message: Uint8Array<ArrayBuffer>;
	}): Promise<Uint8Array<ArrayBuffer>>;
	complete(args: { value: unknown }): Promise<Uint8Array<ArrayBuffer>>;
	receiveCompletion(args: {
		message: Uint8Array<ArrayBuffer>;
	}): Promise<unknown>;
	activate(): Promise<Uint8Array<ArrayBuffer>>;
	verifyActivation(args: { message: Uint8Array<ArrayBuffer> }): Promise<null>;
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
				| "receiver-save"
				| "sender-bound"
				| "receiver-bound"
				| "sender-completion"
				| "receiver-completion"
				| "sender-activation"
				| "receiver-activation";
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
	return new PairingCryptoImpl();
}
class PairingCryptoImpl implements PairingCrypto {
	private state: CryptoState = { phase: "initial" };
	private active() {
		if (this.state.phase === "disposed") {
			throw new DOMException("Pairing ended.", "AbortError");
		}
	}
	readonly senderSetup = this.performSenderSetup.bind(this);
	readonly receiverStart = this.performReceiverStart.bind(this);
	readonly senderResponse = this.performSenderResponse.bind(this);
	readonly receiverFinish = this.performReceiverFinish.bind(this);
	readonly senderFinish = this.performSenderFinish.bind(this);
	readonly verificationCode = this.performVerificationCode.bind(this);
	readonly transfer = this.performTransfer.bind(this);
	readonly receive = this.performReceive.bind(this);
	readonly acknowledge = this.performAcknowledge.bind(this);
	readonly verifyAcknowledgment = this.performVerifyAcknowledgment.bind(this);
	readonly bindReceiver = this.bindReceiverKey.bind(this);
	readonly verifyReceiverBinding = this.openReceiverBinding.bind(this);
	readonly complete = this.sendCompletion.bind(this);
	readonly receiveCompletion = this.openCompletion.bind(this);
	readonly activate = this.sendActivation.bind(this);
	readonly verifyActivation = this.openActivation.bind(this);
	readonly dispose = this.performDispose.bind(this);

	private async performSenderSetup(args: { context: string; secret: string }) {
		await opaque.ready;
		this.active();
		const current = this.state;

		if (current.phase !== "initial") {
			throw invalidStep();
		}
		this.state = { phase: "failed" };
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
		this.state = { phase: "sender-wait", context, setup, record };
		return null;
	}
	private async performReceiverStart(args: { secret: string }) {
		await opaque.ready;
		this.active();
		const current = this.state;

		if (current.phase !== "initial") {
			throw invalidStep();
		}
		const result = opaque.client.startLogin({ password: args.secret });
		this.state = {
			phase: "receiver-wait",
			secret: args.secret,
			loginState: result.clientLoginState,
		};
		return encode(result.startLoginRequest);
	}
	private async performSenderResponse(args: {
		message: Uint8Array<ArrayBuffer>;
	}) {
		await opaque.ready;
		this.active();
		const current = this.state;

		if (current.phase !== "sender-wait") {
			throw invalidStep();
		}
		this.state = { phase: "failed" };
		const result = opaque.server.startLogin({
			serverSetup: current.setup,
			userIdentifier: current.context,
			registrationRecord: current.record,
			startLoginRequest: string(decode(args.message)),
			identifiers: identifiers(current.context),
		});
		this.state = {
			phase: "sender-finish",
			context: current.context,
			loginState: result.serverLoginState,
		};
		return encode(result.loginResponse);
	}
	private async performReceiverFinish(args: {
		context: string;
		message: Uint8Array<ArrayBuffer>;
	}) {
		await opaque.ready;
		this.active();
		const current = this.state;

		if (current.phase !== "receiver-wait") {
			throw invalidStep();
		}
		this.state = { phase: "failed" };
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
		this.active();
		this.state = {
			phase: "receiver-authenticated",
			context: args.context,
			keys,
		};
		return encode(result.finishLoginRequest);
	}
	private async performSenderFinish(args: {
		message: Uint8Array<ArrayBuffer>;
	}) {
		await opaque.ready;
		this.active();
		const current = this.state;

		if (current.phase !== "sender-finish") {
			throw invalidStep();
		}
		this.state = { phase: "failed" };
		const result = opaque.server.finishLogin({
			serverLoginState: current.loginState,
			finishLoginRequest: string(decode(args.message)),
		});
		const keys = await pairingKeys(result.sessionKey, current.context);
		this.active();
		this.state = {
			phase: "sender-authenticated",
			context: current.context,
			keys,
		};
		return null;
	}
	private async performVerificationCode() {
		await opaque.ready;
		this.active();
		const current = this.state;

		if (
			current.phase !== "sender-authenticated" &&
			current.phase !== "receiver-authenticated" &&
			current.phase !== "sender-bound" &&
			current.phase !== "receiver-bound"
		) {
			throw invalidStep();
		}
		return current.keys.verificationCode;
	}
	private async performTransfer(args: { value: unknown }) {
		await opaque.ready;
		this.active();
		const current = this.state;

		if (
			current.phase !== "sender-authenticated" &&
			current.phase !== "sender-bound"
		) {
			throw invalidStep();
		}
		this.state = { ...current, phase: "sender-acknowledgment" };
		return sealPairing(current.keys, current.context, "transfer", args.value);
	}
	private async performReceive(args: { message: Uint8Array<ArrayBuffer> }) {
		await opaque.ready;
		this.active();
		const current = this.state;

		if (
			current.phase !== "receiver-authenticated" &&
			current.phase !== "receiver-bound"
		) {
			throw invalidStep();
		}
		this.state = { ...current, phase: "receiver-save" };
		return openPairing(current.keys, current.context, "transfer", args.message);
	}
	private async performAcknowledge() {
		await opaque.ready;
		this.active();
		const current = this.state;

		if (current.phase !== "receiver-save") {
			throw invalidStep();
		}
		this.state = { ...current, phase: "receiver-completion" };
		return sealPairing(current.keys, current.context, "acknowledgment", [
			1,
			true,
		]);
	}

	private async performVerifyAcknowledgment(args: {
		message: Uint8Array<ArrayBuffer>;
	}) {
		this.active();
		const current = this.state;
		if (current.phase !== "sender-acknowledgment") {
			throw invalidStep();
		}
		this.state = { phase: "failed" };
		const value = await openPairing(
			current.keys,
			current.context,
			"acknowledgment",
			binary(args.message),
		);
		this.active();
		if (
			!Array.isArray(value) ||
			value.length !== 2 ||
			value[0] !== 1 ||
			value[1] !== true
		) {
			throw new Error("Invalid pairing acknowledgment.");
		}
		this.state = { ...current, phase: "sender-completion" };
		return null;
	}
	private async bindReceiverKey(args: { publicKey: Uint8Array<ArrayBuffer> }) {
		this.active();
		const current = this.state;
		if (current.phase !== "receiver-authenticated") {
			throw invalidStep();
		}
		this.state = { phase: "failed" };
		const packet = await sealPairing(
			current.keys,
			current.context,
			"receiverBinding",
			[1, fixedBytes(args.publicKey)],
		);
		this.active();
		this.state = { ...current, phase: "receiver-bound" };
		return packet;
	}
	private async openReceiverBinding(args: {
		message: Uint8Array<ArrayBuffer>;
	}) {
		this.active();
		const current = this.state;
		if (current.phase !== "sender-authenticated") {
			throw invalidStep();
		}
		this.state = { phase: "failed" };
		const value = await openPairing(
			current.keys,
			current.context,
			"receiverBinding",
			args.message,
		);
		this.active();
		if (!Array.isArray(value) || value.length !== 2 || value[0] !== 1) {
			throw new Error("Invalid receiver binding.");
		}
		const publicKey = fixedBytes(value[1]);
		this.state = { ...current, phase: "sender-bound" };
		return publicKey;
	}
	private async sendCompletion(args: { value: unknown }) {
		this.active();
		const current = this.state;
		if (current.phase !== "sender-completion") {
			throw invalidStep();
		}
		this.state = { phase: "failed" };
		const packet = await sealPairing(
			current.keys,
			current.context,
			"completion",
			args.value,
		);
		this.active();
		this.state = { ...current, phase: "sender-activation" };
		return packet;
	}
	private async openCompletion(args: { message: Uint8Array<ArrayBuffer> }) {
		this.active();
		const current = this.state;
		if (current.phase !== "receiver-completion") {
			throw invalidStep();
		}
		this.state = { phase: "failed" };
		const value = await openPairing(
			current.keys,
			current.context,
			"completion",
			args.message,
		);
		this.active();
		this.state = { ...current, phase: "receiver-activation" };
		return value;
	}
	private async sendActivation() {
		this.active();
		const current = this.state;
		if (current.phase !== "receiver-activation") {
			throw invalidStep();
		}
		this.state = { phase: "failed" };
		const packet = await sealPairing(
			current.keys,
			current.context,
			"activation",
			[1, true],
		);
		this.active();
		this.state = { phase: "complete" };
		return packet;
	}
	private async openActivation(args: { message: Uint8Array<ArrayBuffer> }) {
		this.active();
		const current = this.state;
		if (current.phase !== "sender-activation") {
			throw invalidStep();
		}
		this.state = { phase: "failed" };
		const value = await openPairing(
			current.keys,
			current.context,
			"activation",
			args.message,
		);
		this.active();
		if (
			!Array.isArray(value) ||
			value.length !== 2 ||
			value[0] !== 1 ||
			value[1] !== true
		) {
			throw new Error("Invalid pairing activation acknowledgment.");
		}
		this.state = { phase: "complete" };
		return null;
	}
	private performDispose() {
		this.state = { phase: "disposed" };
	}
}
