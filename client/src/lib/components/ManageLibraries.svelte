<script>
import { untrack } from "svelte";
let { app, catalog, libraryId } = $props();
let name = $state("");
let savedName = "";
$effect(() => {
	const latest = catalog.find((row) => row.id === libraryId)?.name || "";
	untrack(() => {
		if (name === savedName) name = latest;
		savedName = latest;
	});
});
let newName = $state("");
let error = $state("");
let errorAt = $state("rename");
let busy = $state(false);
async function run(action, scope = "rename") {
	if (busy) return;
	busy = true;
	error = "";
	errorAt = scope;
	try {
		await action();
		if (scope === "add") newName = "";
	} catch (failure) {
		error = failure.message;
	} finally {
		busy = false;
	}
}
</script>

<details id="rename-library-settings" class="panel">
	<summary>Rename library</summary>
	<fieldset class="stack" aria-label="Rename library">
		<legend hidden>Rename library</legend>
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
				<button
					type="button"
					class="secondary danger"
					disabled={busy}
					onclick={() => run(app.forgetLibrary)}
				>
					Forget this library
				</button>
			</div>
		</form>
		{#if error && errorAt === "rename"}
			<p role="alert">{error}</p>
		{/if}
	</fieldset>
</details>
<details id="add-library-settings" class="panel">
	<summary>Add library</summary>
	<fieldset class="stack" aria-label="Add library">
		<legend hidden>Add library</legend>
		<form
			class="stack"
			onsubmit={(event) => {
				event.preventDefault();
				run(() => app.addLibrary(newName), "add");
			}}
		>
			<div class="field">
				<label for="new-library-name">New library name</label>
				<input
					id="new-library-name"
					bind:value={newName}
					required
					maxlength="80"
					disabled={busy}
				>
			</div>
			<button type="submit" disabled={busy}>Add library</button>
		</form>
		{#if error && errorAt === "add"}
			<p role="alert">{error}</p>
		{/if}
	</fieldset>
</details>

<style>
fieldset {
	min-width: 0;
	margin: 1rem 0 0;
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
