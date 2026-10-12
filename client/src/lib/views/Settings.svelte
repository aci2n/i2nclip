<script>
import Pairing from "../components/Pairing.svelte";
import RecoveryExport from "../components/RecoveryExport.svelte";
import Setup from "../components/Setup.svelte";
import VaultSettings from "../components/VaultSettings.svelte";

let { session, pairing } = $props();
let feedback = $state({ scope: "", text: "", error: false });
let name = $state($session.name);
const busy = $derived($session.busy || $pairing.active);
async function action(scope, work, success) {
	feedback = { scope, text: "", error: false };
	const done = await work();
	feedback = { scope, text: done ? success : $session.error, error: !done };
}
</script>
<div class="settings stack">
	{#if !$session.configured}
		<Setup
			{busy}
			defaultServer={$session.serverUrl}
			error={$session.error}
			pairingState={$pairing}
			oncreate={session.create}
			onrestore={session.restore}
			onreceive={pairing.receive}
			onapprove={pairing.approve}
			onreject={pairing.rejectVerification}
			oncancel={pairing.cancel}
		/>
	{:else}
		<section class="panel stack">
			<h2>Your library</h2>
			<p class="address">{$session.name} · {$session.serverUrl}</p>
			<p>
				Keep your recovery file and its password safe. Your master password
				protects this client.
			</p>
		</section>
		<details class="panel">
			<summary>Rename library</summary>
			<form
				class="stack"
				onsubmit={(event) => {
					event.preventDefault();
					action("rename", () => session.rename(name), "Library renamed.");
				}}
			>
				<label class="field"
					>Library name<input
						required
						maxlength="80"
						bind:value={name}
						disabled={busy}
					></label
				><button type="submit" disabled={busy}>Save name</button>
				{#if feedback.scope === "rename" && feedback.text}
					<p
						class:error={feedback.error}
						role={feedback.error ? "alert" : "status"}
					>
						{feedback.text}
					</p>
				{/if}
			</form>
		</details>
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
		<Pairing
			state={$pairing}
			server={$session.serverUrl}
			configured
			busy={$session.busy}
			onSend={pairing.send}
			onReceive={pairing.receive}
			onApprove={pairing.approve}
			onRejectVerification={pairing.rejectVerification}
			onCancel={pairing.cancel}
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
							session.forget();
						}
					}}
				>
					Forget library
				</button>
				{#if $session.error}
					<p role="alert" class="error">{$session.error}</p>
				{/if}
			</div>
		</details>
	{/if}
	<VaultSettings
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
}
.address {
	overflow-wrap: anywhere;
}
form,
.content {
	margin-top: 1rem;
}
</style>
