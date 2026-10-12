<script>
let { app } = $props();
let libraryId = $state("");
let busy = $state(false);
let error = $state("");
const destination = $derived(libraryId || $app.catalog[0]?.id || "");
async function submit(event) {
	event.preventDefault();
	if (busy) return;
	busy = true;
	error = "";
	try {
		await app.acceptContextUpload(destination);
	} catch (failure) {
		error = failure.message;
	} finally {
		busy = false;
	}
}
</script>
<section class="panel stack">
	<h1>Upload to a library</h1>
	{#if !$app.catalog.length}
		<p>
			Create or restore a library in Settings first, then return to this upload.
		</p>
	{:else}
		<form class="stack" onsubmit={submit}>
			<div class="field">
				<label for="upload-destination">Library</label
				><select id="upload-destination" bind:value={libraryId} disabled={busy}>
					{#each $app.catalog as row}
						<option value={row.id}>{row.name}</option>
					{/each}
				</select>
			</div>
			<button type="submit" disabled={busy}>Continue upload</button>
			{#if error}
				<p role="alert">{error}</p>
			{/if}
		</form>
	{/if}
</section>
