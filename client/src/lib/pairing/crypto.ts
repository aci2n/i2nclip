import * as opaque from "@serenity-kit/opaque";
import { decode, encode } from "../protocol/msgpack.ts";
import type { PairingKeys } from "../protocol/pairing.ts";
import { openPairing, pairingKeys, sealPairing } from "../protocol/pairing.ts";
import { bytes as binary, document, string } from "../protocol/value.ts";
import { requireValue } from "../required.ts";
export interface CryptoArgs {
	context?: string;
	secret?: string;
	message?: unknown;
	value?: unknown;
}
export interface CryptoResults {
	senderSetup: null;
	receiverStart: Uint8Array<ArrayBuffer>;
	senderResponse: Uint8Array<ArrayBuffer>;
	receiverFinish: Uint8Array<ArrayBuffer>;
	senderFinish: null;
	verificationCode: string;
	transfer: Uint8Array<ArrayBuffer>;
	receive: unknown;
	acknowledge: Uint8Array<ArrayBuffer>;
	verifyAcknowledgment: null;
}
export type CryptoAction = keyof CryptoResults;

// Each service executor owns exactly one PAKE attempt. OPAQUE's server is the sending
// device; its setup and password file never leave that device.
export function createPairingCrypto() {
	let phase = "initial";
	let context: string | undefined;
	let setup: string | undefined;
	let record: string | undefined;
	let loginState: string | undefined;
	let secret: string | undefined;
	let keys: PairingKeys | undefined;
	const identifiers = () => ({
		client: `${context} receiver verification-code`,
		server: `${context} sender verification-code`,
	});
	function expect(expected: string) {
		if (phase !== expected) {
			throw new Error("Invalid pairing step.");
		}
	}
	function execute<A extends CryptoAction>(
		action: A,
		args?: CryptoArgs,
	): Promise<CryptoResults[A]>;
	async function execute(
		action: CryptoAction,
		args: CryptoArgs = {},
	): Promise<CryptoResults[CryptoAction]> {
		await opaque.ready;
		if (phase === "disposed") {
			throw new DOMException("Pairing ended.", "AbortError");
		}
		switch (action) {
			case "senderSetup": {
				expect("initial");
				phase = "setting-up";
				context = string(args.context);
				setup = opaque.server.createSetup();
				const registration = opaque.client.startRegistration({
					password: string(args.secret),
				});
				const response = opaque.server.createRegistrationResponse({
					serverSetup: string(setup),
					userIdentifier: string(context),
					registrationRequest: registration.registrationRequest,
				});
				record = opaque.client.finishRegistration({
					clientRegistrationState: registration.clientRegistrationState,
					registrationResponse: response.registrationResponse,
					password: string(args.secret),
					identifiers: identifiers(),
				}).registrationRecord;
				phase = "sender-wait";
				return null;
			}
			case "receiverStart": {
				expect("initial");
				secret = string(args.secret);
				const result = opaque.client.startLogin({ password: string(secret) });
				loginState = result.clientLoginState;
				phase = "receiver-wait";
				return encode(result.startLoginRequest);
			}
			case "senderResponse": {
				expect("sender-wait");
				phase = "sender-finish";
				const result = opaque.server.startLogin({
					serverSetup: string(setup),
					userIdentifier: string(context),
					registrationRecord: string(record),
					startLoginRequest: string(decode(binary(args.message))),
					identifiers: identifiers(),
				});
				loginState = result.serverLoginState;
				setup = record = undefined;
				return encode(result.loginResponse);
			}
			case "receiverFinish": {
				expect("receiver-wait");
				phase = "failed";
				context = string(args.context);
				const result = opaque.client.finishLogin({
					clientLoginState: string(loginState),
					loginResponse: string(decode(binary(args.message))),
					password: string(secret),
					identifiers: identifiers(),
				});
				loginState = secret = undefined;
				if (!result) {
					throw new Error("Pairing authentication failed.");
				}
				keys = await pairingKeys(result.sessionKey, string(context));
				phase = "receiver-authenticated";
				return encode(result.finishLoginRequest);
			}
			case "senderFinish": {
				expect("sender-finish");
				phase = "failed";
				const result = opaque.server.finishLogin({
					serverLoginState: string(loginState),
					finishLoginRequest: string(decode(binary(args.message))),
				});
				loginState = undefined;
				keys = await pairingKeys(result.sessionKey, string(context));
				phase = "sender-authenticated";
				return null;
			}
			case "verificationCode": {
				if (
					!["sender-authenticated", "receiver-authenticated"].includes(phase)
				) {
					throw new Error("Invalid pairing step.");
				}
				return requireValue(keys).verificationCode;
			}
			case "transfer": {
				expect("sender-authenticated");
				phase = "sender-acknowledgment";
				return sealPairing(
					requireValue(keys),
					string(context),
					"transfer",
					args.value,
				);
			}
			case "receive": {
				expect("receiver-authenticated");
				phase = "receiver-save";
				return openPairing(
					requireValue(keys),
					string(context),
					"transfer",
					binary(args.message),
				);
			}
			case "acknowledge": {
				expect("receiver-save");
				phase = "complete";
				return sealPairing(
					requireValue(keys),
					string(context),
					"acknowledgment",
					{
						v: 1,
						saved: true,
					},
				);
			}
			case "verifyAcknowledgment": {
				expect("sender-acknowledgment");
				phase = "complete";
				const value = document(
					await openPairing(
						requireValue(keys),
						string(context),
						"acknowledgment",
						binary(args.message),
					),
				);
				if (value.v !== 1 || value.saved !== true) {
					throw new Error("Invalid pairing acknowledgment.");
				}
				return null;
			}
			default:
				throw new Error("Invalid pairing action.");
		}
	}
	execute.dispose = () => {
		phase = "disposed";
		context = setup = record = loginState = secret = keys = undefined;
	};
	return execute;
}
