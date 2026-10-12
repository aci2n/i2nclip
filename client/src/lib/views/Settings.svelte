<script>
import PairingSend from "../components/PairingSend.svelte";
import PasswordSettings from "../components/PasswordSettings.svelte";
import RecoveryExport from "../components/RecoveryExport.svelte";
import Setup from "./Setup.svelte";

let { session, pairing } = $props();
let feedback = $state({ scope: "", text: "", error: false });
const busy = $derived($session.busy || $pairing.active);
async function action(scope, work, success) {
	feedback = { scope, text: "", error: false };
	const done = await work();
	feedback = { scope, text: done ? success : $session.error, error: !done };
}
</script>
<div class="settings stack">
	{#if !$session.configured}
		<Setup {session} {pairing} />
	{:else}
		<section class="panel stack">
			<h2>Your library</h2>
			<p class="address">{$session.serverUrl}</p>
			<p>
				Keep your recovery file and its password safe. Your master password
				protects this client.
			</p>
		</section>
		<RecoveryExport
			{busy}
			error={feedback.scope === "recovery" && feedback.error
				? feedback.text
				: ""}
			status={feedback.scope === "recovery" && !feedback.error
				? feedback.text
				: ""}
			onexport={(password) =>
				action(
					"recovery",
					() => session.downloadRecovery(password),
					"Recovery file downloaded.",
				)}
		/>
		<PairingSend
			state={$pairing}
			busy={$session.busy}
			onsend={pairing.send}
			onapprove={pairing.approve}
			onreject={pairing.rejectVerification}
			oncancel={pairing.cancel}
		/>
		<details class="panel">
			<summary>Forget this library</summary>
			<div class="stack content">
				<p>
					This removes the saved library identity from this device. Server files
					remain.
				</p>
				<button
					type="button"
					class="secondary danger"
					disabled={busy}
					onclick={() => {
						if (
							confirm(
								"Forget this library? Keep a recovery file before continuing.",
							)
						) {
							action("forget", session.forget, "Library forgotten.");
						}
					}}
				>
					Forget library
				</button>
				{#if feedback.scope === "forget" && feedback.error}
					<p role="alert" class="error">{feedback.text}</p>
				{/if}
			</div>
		</details>
	{/if}
	<PasswordSettings
		{busy}
		error={feedback.scope === "password" && feedback.error ? feedback.text : ""}
		status={feedback.scope === "password" && !feedback.error
			? feedback.text
			: ""}
		onpassword={(current, password) =>
			action(
				"password",
				() => session.changePassword(current, password),
				"Master password changed.",
			)}
	/>
</div>
<style>
.settings {
	max-width: 42rem;
	margin: auto;
}
.address {
	overflow-wrap: anywhere;
}
.content {
	margin-top: 1rem;
}
</style>
