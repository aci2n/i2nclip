<script>
let { session, pending, auto = false, settingsHref } = $props();
const tags = $derived(pending.tags);
</script>

<section class="panel stack">
	<h2>{auto ? "Save to your library" : "Upload with tags"}</h2>
	{#if $session.unlocked}
		<p id="name" class="name">{$pending.name}</p>
	{/if}
	{#if $session.unlocked && $pending.preview}
		<img
			id="preview"
			class="upload-preview"
			src={$pending.preview}
			alt={$pending.name}
		>
	{/if}
	{#if !$session.configured}
		<p>
			<a href={settingsHref}>Create or restore your library</a>
			before uploading.
		</p>
	{:else if !$session.unlocked}
		<p role="status">Library operation in progress…</p>
	{:else}
		<form
			class="stack"
			id="send"
			onsubmit={(event) => {
				event.preventDefault();
				pending.send($tags);
			}}
		>
			{#if !auto}
				<div class="field">
					<label for="tags">Tags, separated by commas</label>
					<input id="tags" bind:value={$tags} disabled={$pending.busy}>
				</div>
			{/if}
			<button type="submit" disabled={!$pending.available || $pending.busy}>
				{$pending.busy ? "Uploading…" : "Upload"}
			</button>
		</form>
	{/if}
	<p id="status" role="status">{$session.unlocked ? $pending.status : ""}</p>
</section>

<style>
.name {
	overflow-wrap: anywhere;
}
.upload-preview {
	display: block;
	max-width: 100%;
	max-height: 12rem;
	object-fit: contain;
	margin: 0 auto;
}
</style>
