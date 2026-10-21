import * as opaque from "@serenity-kit/opaque";
import {
	type Bytes,
	fixedBytes,
	sameBytes,
} from "../protocol/library-chain.ts";
import { decode, encode } from "../protocol/msgpack.ts";
import {
	openPairing,
	type PairingKeys,
	pairingKeys,
	sealPairing,
} from "../protocol/pairing.ts";
import { string } from "../protocol/value.ts";
import {
	type LibraryIdentity,
	openPairingIdentity,
	sealPairingIdentity,
	type TrustedCheckpoint,
} from "./library-identity.ts";

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
			proof?: Bytes;
	  };
function identifiers(context: string) {
	return {
		client: `${context} receiver verification-code`,
		server: `${context} sender verification-code`,
	};
}
const invalidStep = () => new Error("Invalid pairing step.");
export type PairingCrypto = ReturnType<typeof createPairingCrypto>;
export function createPairingCrypto(): Pick<
	PairingCryptoImpl,
	keyof PairingCryptoImpl
> {
	return new PairingCryptoImpl();
}
class PairingCryptoImpl {
	private state: CryptoState = { phase: "initial" };
	private running = false;
	private readonly controller = new AbortController();
	readonly senderSetup = this.senderSetupCommand.bind(this);
	readonly receiverStart = this.receiverStartCommand.bind(this);
	readonly senderResponse = this.senderResponseCommand.bind(this);
	readonly receiverFinish = this.receiverFinishCommand.bind(this);
	readonly senderFinish = this.senderFinishCommand.bind(this);
	readonly transfer = this.transferCommand.bind(this);
	readonly receive = this.receiveCommand.bind(this);
	readonly verifyAcknowledgment = this.verifyAcknowledgmentCommand.bind(this);
	readonly verificationCode = this.verificationCommand.bind(this);
	readonly acknowledge = this.acknowledgeCommand.bind(this);
	readonly dispose = this.disposeCrypto.bind(this);
	private active() {
		this.controller.signal.throwIfAborted();
	}
	private async command<T>(operation: () => Promise<T>): Promise<T> {
		this.active();
		if (this.running) {
			throw new Error("Pairing is busy.");
		}
		this.running = true;
		let abort: () => void = () => {};
		const stopped = new Promise<never>((_, reject) => {
			abort = () => reject(this.controller.signal.reason);
			this.controller.signal.addEventListener("abort", abort, { once: true });
		});
		try {
			const result = await Promise.race([operation(), stopped]);
			this.active();
			return result;
		} catch (error) {
			this.active();
			if ("proof" in this.state) {
				this.state.proof?.fill(0);
			}
			this.state = { phase: "failed" };
			throw error;
		} finally {
			this.controller.signal.removeEventListener("abort", abort);
			this.running = false;
		}
	}
	private senderSetupCommand(args: { context: string; secret: string }) {
		return this.command(() => this.performSenderSetup(args));
	}
	private receiverStartCommand(args: { secret: string }) {
		return this.command(() => this.performReceiverStart(args));
	}
	private senderResponseCommand(args: { message: Bytes }) {
		return this.command(() => this.performSenderResponse(args));
	}
	private receiverFinishCommand(args: { context: string; message: Bytes }) {
		return this.command(() => this.performReceiverFinish(args));
	}
	private senderFinishCommand(args: { message: Bytes }) {
		return this.command(() => this.performSenderFinish(args));
	}
	private transferCommand(args: {
		identity: LibraryIdentity;
		checkpoint: TrustedCheckpoint;
	}) {
		return this.command(() => this.performTransfer(args));
	}
	private receiveCommand(args: { message: Bytes }) {
		return this.command(() => this.performReceive(args));
	}
	private verifyAcknowledgmentCommand(args: { message: Bytes }) {
		return this.command(() => this.performVerifyAcknowledgment(args));
	}
	private verificationCommand() {
		return this.command(async () => {
			this.active();
			const current = this.state;
			if (
				current.phase !== "sender-authenticated" &&
				current.phase !== "receiver-authenticated"
			) {
				throw invalidStep();
			}
			return current.keys.verificationCode;
		});
	}
	private acknowledgeCommand() {
		return this.command(() => this.performAcknowledge());
	}
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

	private async performTransfer(args: {
		identity: LibraryIdentity;
		checkpoint: TrustedCheckpoint;
	}) {
		this.active();
		const current = this.state;
		if (current.phase !== "sender-authenticated") {
			throw invalidStep();
		}
		this.state = { phase: "failed" };
		const proof = crypto.getRandomValues(new Uint8Array(32));
		try {
			const packet = await sealPairingIdentity(
				args.identity,
				args.checkpoint,
				proof,
				current.keys.transfer,
				current.context,
				this.controller.signal,
			);
			this.active();
			this.state = { ...current, phase: "sender-acknowledgment", proof };
			return packet;
		} catch (error) {
			proof.fill(0);
			throw error;
		}
	}
	private async performReceive(args: { message: Bytes }) {
		this.active();
		const current = this.state;
		if (current.phase !== "receiver-authenticated") {
			throw invalidStep();
		}
		this.state = { phase: "failed" };
		const opened = await openPairingIdentity(
			args.message,
			current.keys.transfer,
			current.context,
			this.controller.signal,
		);
		try {
			this.active();
			this.state = {
				...current,
				phase: "receiver-save",
				proof: opened.challenge,
			};
			return { identity: opened.identity, checkpoint: opened.checkpoint };
		} catch (error) {
			opened.identity.dispose();
			opened.challenge.fill(0);
			throw error;
		}
	}
	private async performAcknowledge() {
		this.active();
		const current = this.state;
		if (current.phase !== "receiver-save" || !current.proof) {
			throw invalidStep();
		}
		this.state = { phase: "failed" };
		try {
			const packet = await sealPairing(
				current.keys,
				current.context,
				"acknowledgment",
				[1, current.proof],
			);
			this.active();
			this.state = { phase: "complete" };
			return packet;
		} finally {
			current.proof.fill(0);
		}
	}
	private async performVerifyAcknowledgment(args: { message: Bytes }) {
		this.active();
		const current = this.state;
		if (current.phase !== "sender-acknowledgment" || !current.proof) {
			throw invalidStep();
		}
		this.state = { phase: "failed" };
		try {
			const value = await openPairing(
				current.keys,
				current.context,
				"acknowledgment",
				args.message,
			);
			this.active();
			if (
				!Array.isArray(value) ||
				value.length !== 2 ||
				value[0] !== 1 ||
				!sameBytes(fixedBytes(value[1]), current.proof)
			) {
				throw new Error("Invalid pairing acknowledgment.");
			}
			this.state = { phase: "complete" };
			return null;
		} finally {
			current.proof.fill(0);
		}
	}
	private disposeCrypto() {
		this.controller.abort(new DOMException("Pairing ended.", "AbortError"));
		if ("proof" in this.state) {
			this.state.proof?.fill(0);
		}
		this.state = { phase: "disposed" };
	}
}
