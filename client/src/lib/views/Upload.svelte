<script>
import Unlock from "../components/Unlock.svelte";

let { session, pending, auto = false, settingsHref } = $props();
const tags = $derived(pending.tags);
</script>

<section class="panel">
	<h2>{auto ? "Save to your library" : "Upload with tags"}</h2>
	<p id="name">{$pending.name}</p>
	{#if $pending.preview}
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
		<Unlock {session} id={auto ? "form" : "unlock"} />
	{:else}
		<form
			id="send"
			onsubmit={(event) => {
				event.preventDefault();
				pending.send($tags);
			}}
		>
			{#if !auto}
				<label for="tags">Tags, separated by commas</label>
				<input id="tags" bind:value={$tags} disabled={$pending.busy}>
			{/if}
			<button type="submit" disabled={!$pending.available || $pending.busy}>
				{$pending.busy ? "Uploading…" : "Upload"}
			</button>
		</form>
	{/if}
	<p id="status" role="status">{$pending.status}</p>
</section>

<style>
.upload-preview {
	display: block;
	max-width: 100%;
	max-height: 12rem;
	margin: 1rem auto;
}
</style>
