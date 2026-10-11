import * as opaque from "@serenity-kit/opaque";
import { openPairing, pairingKeys, sealPairing } from "../protocol/pairing.js";

// Each worker owns exactly one PAKE attempt. OPAQUE's server is the sending
// device; its setup and password file never leave that device.
export function createPairingCrypto() {
	let phase = "initial";
	let context, setup, record, loginState, secret, keys;
	const identifiers = () => ({
		client: `${context} receiver`,
		server: `${context} sender`,
	});
	function expect(expected) {
		if (phase !== expected) throw new Error("Invalid pairing step.");
	}
	return async function execute(action, args) {
		await opaque.ready;
		switch (action) {
			case "senderSetup": {
				expect("initial");
				phase = "setting-up";
				context = args.context;
				setup = opaque.server.createSetup();
				const registration = opaque.client.startRegistration({
					password: args.secret,
				});
				const response = opaque.server.createRegistrationResponse({
					serverSetup: setup,
					userIdentifier: context,
					registrationRequest: registration.registrationRequest,
				});
				record = opaque.client.finishRegistration({
					clientRegistrationState: registration.clientRegistrationState,
					registrationResponse: response.registrationResponse,
					password: args.secret,
					identifiers: identifiers(),
				}).registrationRecord;
				phase = "sender-wait";
				return null;
			}
			case "receiverStart": {
				expect("initial");
				secret = args.secret;
				const result = opaque.client.startLogin({ password: secret });
				loginState = result.clientLoginState;
				phase = "receiver-wait";
				return result.startLoginRequest;
			}
			case "senderResponse": {
				expect("sender-wait");
				phase = "sender-finish";
				const result = opaque.server.startLogin({
					serverSetup: setup,
					userIdentifier: context,
					registrationRecord: record,
					startLoginRequest: args.message,
					identifiers: identifiers(),
				});
				loginState = result.serverLoginState;
				setup = record = undefined;
				return result.loginResponse;
			}
			case "receiverFinish": {
				expect("receiver-wait");
				phase = "failed";
				context = args.context;
				const result = opaque.client.finishLogin({
					clientLoginState: loginState,
					loginResponse: args.message,
					password: secret,
					identifiers: identifiers(),
				});
				loginState = secret = undefined;
				if (!result) throw new Error("Pairing authentication failed.");
				keys = await pairingKeys(result.sessionKey, context);
				phase = "receiver-authenticated";
				return result.finishLoginRequest;
			}
			case "senderFinish": {
				expect("sender-finish");
				phase = "failed";
				const result = opaque.server.finishLogin({
					serverLoginState: loginState,
					finishLoginRequest: args.message,
				});
				loginState = undefined;
				keys = await pairingKeys(result.sessionKey, context);
				phase = "sender-authenticated";
				return null;
			}
			case "transfer": {
				expect("sender-authenticated");
				phase = "sender-acknowledgment";
				return sealPairing(keys, context, "transfer", args.value);
			}
			case "receive": {
				expect("receiver-authenticated");
				phase = "receiver-save";
				return openPairing(keys, context, "transfer", args.message);
			}
			case "acknowledge": {
				expect("receiver-save");
				phase = "complete";
				return sealPairing(keys, context, "acknowledgment", {
					v: 1,
					saved: true,
				});
			}
			case "verifyAcknowledgment": {
				expect("sender-acknowledgment");
				phase = "complete";
				const value = await openPairing(
					keys,
					context,
					"acknowledgment",
					args.message,
				);
				if (value.v !== 1 || value.saved !== true)
					throw new Error("Invalid pairing acknowledgment.");
				return null;
			}
			default:
				throw new Error("Invalid pairing action.");
		}
	};
}
