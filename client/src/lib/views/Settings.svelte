<script>
import PairingSend from "../components/PairingSend.svelte";
import PasswordSettings from "../components/PasswordSettings.svelte";
import RecoveryExport from "../components/RecoveryExport.svelte";
import Setup from "./Setup.svelte";

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
		<Setup {session} {pairing} />
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
}
.address {
	overflow-wrap: anywhere;
}
form,
.content {
	margin-top: 1rem;
}
</style>
