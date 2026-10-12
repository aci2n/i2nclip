<script>
import RecoveryExport from "./RecoveryExport.svelte";

let { vault } = $props();
let current = $state("");
let password = $state("");
let confirmation = $state("");
let message = $state("");
let error = $state(false);
let busy = $state(false);
async function change(event) {
	event.preventDefault();
	if (busy) {
		return;
	}
	error = false;
	message = "";
	if (password !== confirmation) {
		error = true;
		message = "Passwords do not match.";
		return;
	}
	const old = current;
	const secret = password;
	current = "";
	password = "";
	confirmation = "";
	busy = true;
	try {
		await vault.changePassword(old, secret);
		message =
			"Master password changed. Existing recovery files keep their original recovery passwords.";
	} catch (failure) {
		message = failure.message;
		error = true;
	} finally {
		busy = false;
	}
}
</script>
<details class="panel" id="master-password-settings">
	<summary>Master password</summary>
	<form class="stack body" onsubmit={change}>
		<div class="field">
			<label for="current-master">Current master password</label>
			<input
				id="current-master"
				type="password"
				required
				autocomplete="current-password"
				bind:value={current}
				disabled={busy}
			>
		</div>
		<div class="field">
			<label for="new-master">New master password</label>
			<input
				id="new-master"
				type="password"
				required
				minlength="8"
				autocomplete="new-password"
				bind:value={password}
				disabled={busy}
			>
		</div>
		<div class="field">
			<label for="confirm-new-master">Confirm new master password</label>
			<input
				id="confirm-new-master"
				type="password"
				required
				minlength="8"
				autocomplete="new-password"
				bind:value={confirmation}
				disabled={busy}
			>
		</div>
		<button type="submit" disabled={busy}>Change master password</button>
		{#if message}
			<p role={error ? "alert" : "status"} class:error>{message}</p>
		{/if}
	</form>
</details>
<details class="panel" id="vault-recovery-settings">
	<summary>Back up all libraries</summary>
	<div class="body"><RecoveryExport {vault} /></div>
</details>
<style>
.body {
	margin-top: 1rem;
}
</style>
