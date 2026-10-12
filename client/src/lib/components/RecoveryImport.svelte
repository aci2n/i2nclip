<script>
import { onDestroy } from "svelte";
let { vault, onComplete = () => {} } = $props();
let files = $state();
let password = $state("");
let preview = $state([]);
let busy = $state(false);
let message = $state("");
let error = $state(false);
let secret = "";
let selectedFile;
let disposed = false;
onDestroy(() => {
	disposed = true;
	secret = "";
	selectedFile = undefined;
});
function invalidate() {
	preview = [];
	secret = "";
	selectedFile = undefined;
	message = "";
}
async function inspect(event) {
	event.preventDefault();
	if (busy) return;
	busy = true;
	error = false;
	message = "";
	secret = password;
	password = "";
	selectedFile = files?.[0];
	try {
		const result = await vault.previewRecovery(selectedFile, secret);
		if (!disposed) preview = result;
	} catch (failure) {
		invalidate();
		message = failure.message;
		error = true;
	} finally {
		busy = false;
	}
}
async function restore() {
	if (busy) return;
	busy = true;
	error = false;
	try {
		const result = await vault.importRecovery(selectedFile, secret);
		if (disposed) return;
		invalidate();
		files = undefined;
		message = `Restored ${result.imported.length} libraries. ${result.skipped} already saved.`;
		if (result.imported[0]) onComplete(result.imported[0], result);
	} catch (failure) {
		message = failure.message;
		error = true;
	} finally {
		secret = "";
		preview = [];
		selectedFile = undefined;
		busy = false;
	}
}
</script>
<form class="stack" id="restore-settings" onsubmit={inspect}>
	<p>
		Restore one library or a whole-vault recovery file. Each library keeps its
		saved server and uses this client’s master password.
	</p>
	<div class="field">
		<label for="file">Recovery file</label>
		<input
			id="file"
			type="file"
			required
			accept=".json,application/json"
			bind:files
			onchange={invalidate}
			disabled={busy}
		>
	</div>
	<div class="field">
		<label for="restore-pass">Recovery password</label>
		<input
			id="restore-pass"
			type="password"
			required
			autocomplete="current-password"
			bind:value={password}
			disabled={busy}
		>
	</div>
	<button id="preview-recovery" type="submit" disabled={busy}>
		{busy ? "Working…" : "Review recovery file"}
	</button>
</form>
{#if preview.length}
	<div class="stack">
		<ul>
			{#each preview as row}
				<li>{row.name} — {row.serverUrl}</li>
			{/each}
		</ul>
		<p>
			Existing libraries are kept. Duplicate identities are skipped and
			conflicting names receive a suffix.
		</p>
		<button id="restore" type="button" disabled={busy} onclick={restore}>
			Restore libraries
		</button>
		<button
			class="secondary"
			type="button"
			disabled={busy}
			onclick={invalidate}
		>
			Cancel
		</button>
	</div>
{/if}
{#if message}
	<p role={error ? "alert" : "status"} class:error>{message}</p>
{/if}
