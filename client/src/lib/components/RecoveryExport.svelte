<script>
let { vault, libraryId } = $props();
let password = $state("");
let confirmation = $state("");
let busy = $state(false);
let message = $state("");
let error = $state(false);
const prefix = $derived(libraryId ? "library-recovery" : "vault-recovery");
async function submit(event) {
	event.preventDefault();
	if (busy) return;
	message = "";
	error = false;
	if (password !== confirmation) {
		message = "Passwords do not match.";
		error = true;
		return;
	}
	const secret = password;
	password = "";
	confirmation = "";
	busy = true;
	try {
		await vault.exportRecovery(secret, libraryId);
		message =
			"Recovery download started. Keep the file and its recovery password somewhere safe.";
	} catch (failure) {
		message = failure.message;
		error = true;
	} finally {
		busy = false;
	}
}
</script>
<form class="stack" onsubmit={submit}>
	<p>
		{libraryId ? "Export this library" : "Back up all libraries"}
		with a separate recovery password. The file contains library keys, names and
		servers, and excludes pending uploads.
	</p>
	<div class="field">
		<label for={`${prefix}-password`}>Recovery password</label>
		<input
			id={`${prefix}-password`}
			type="password"
			required
			minlength="8"
			autocomplete="new-password"
			bind:value={password}
			disabled={busy}
		>
	</div>
	<div class="field">
		<label for={`${prefix}-confirm`}>Confirm recovery password</label>
		<input
			id={`${prefix}-confirm`}
			type="password"
			required
			minlength="8"
			autocomplete="new-password"
			bind:value={confirmation}
			disabled={busy}
		>
	</div>
	<button
		id={libraryId ? "backup" : "backup-vault"}
		type="submit"
		disabled={busy}
	>
		{busy
			? "Exporting…"
			: libraryId
				? "Export recovery file"
				: "Back up all libraries"}
	</button>
	{#if message}
		<p role={error ? "alert" : "status"} class:error>{message}</p>
	{/if}
</form>
