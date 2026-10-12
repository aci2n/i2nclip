<script>
import { onDestroy, untrack } from "svelte";
import { createRecoveryImport } from "../stores/recovery-import.js";

let { vault, onComplete = () => {} } = $props();
const form = untrack(() => createRecoveryImport(vault, onComplete));
onDestroy(form.dispose);
</script>
<form
	class="stack"
	id="restore-settings"
	onsubmit={(event) => {
		event.preventDefault();
		form.review();
	}}
>
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
			bind:files={() => $form.files, (value) => form.edit("files", value)}
			disabled={$form.busy}
		>
	</div>
	<div class="field">
		<label for="restore-pass">Recovery password</label>
		<input
			id="restore-pass"
			type="password"
			required
			autocomplete="current-password"
			bind:value={() => $form.password, (value) => form.edit("password", value)}
			disabled={$form.busy}
		>
	</div>
	<button id="preview-recovery" type="submit" disabled={$form.busy}>
		{$form.busy ? "Working…" : "Review recovery file"}
	</button>
</form>
{#if $form.preview.length}
	<div class="stack">
		<ul>
			{#each $form.preview as row}
				<li>{row.name} — {row.serverUrl}</li>
			{/each}
		</ul>
		<p>
			Existing libraries are kept. Duplicate identities are skipped and
			conflicting names receive a suffix.
		</p>
		<button
			id="restore"
			type="button"
			disabled={$form.busy}
			onclick={form.restore}
		>
			Restore libraries
		</button>
		<button
			class="secondary"
			type="button"
			disabled={$form.busy}
			onclick={form.cancel}
		>
			Cancel
		</button>
	</div>
{/if}
{#if $form.message}
	<p role={$form.error ? "alert" : "status"} class:error={$form.error}>
		{$form.message}
	</p>
{/if}
