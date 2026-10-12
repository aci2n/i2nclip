<script>
import { untrack } from "svelte";
import RecoveryExport from "./RecoveryExport.svelte";

let { app, catalog, libraryId, vault } = $props();
let name = $state("");
let savedName = "";
$effect(() => {
	const latest = catalog.find((row) => row.id === libraryId)?.name || "";
	untrack(() => {
		if (name === savedName) {
			name = latest;
		}
		savedName = latest;
	});
});
let error = $state("");
let busy = $state(false);
async function run(action) {
	if (busy) {
		return;
	}
	busy = true;
	error = "";
	try {
		await action();
	} catch (failure) {
		error = failure.message;
	} finally {
		busy = false;
	}
}
</script>

<details id="rename-library-settings" class="panel">
	<summary>Manage Library</summary>
	<fieldset class="stack" aria-label="Manage Library">
		<legend hidden>Manage Library</legend>
		<form
			class="stack"
			onsubmit={(event) => {
				event.preventDefault();
				run(() => app.renameLibrary(name));
			}}
		>
			<div class="field">
				<label for="rename-library">Library name</label>
				<input
					id="rename-library"
					bind:value={name}
					required
					maxlength="80"
					disabled={busy}
				>
			</div>
			<div class="bar actions">
				<button type="submit" disabled={busy}>Rename</button>
			</div>
		</form>
		{#if error}
			<p role="alert">{error}</p>
		{/if}
		<RecoveryExport {vault} {libraryId} />
	</fieldset>
</details>
<style>
fieldset {
	min-width: 0;
	margin-top: 1rem;
	border: 0;
	padding: 0;
}
legend {
	font-size: 1.125rem;
	font-weight: 600;
	padding: 0 0.5rem;
}
.actions {
	flex-wrap: wrap;
}
</style>
