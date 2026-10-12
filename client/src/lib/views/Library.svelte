<script>
import ImageDialog from "../components/ImageDialog.svelte";
import MediaCard from "../components/MediaCard.svelte";
import Uploads from "../components/Uploads.svelte";
import { pickFiles, selectFiles } from "../ui/dom.js";

let { session, library, onsettings } = $props();
let filesInput = $state();
</script>
{#if !$session.configured}
	<section class="panel empty stack">
		<h2>Your library starts here</h2>
		<p>
			<a href="?page=settings" onclick={onsettings}
				>Create or restore your library</a
			>
			to start saving encrypted media.
		</p>
	</section>
{:else}
	<form
		class="bar toolbar"
		onsubmit={(event) => {
			event.preventDefault();
			library.search($library.searchDraft);
		}}
	>
		<input
			type="search"
			placeholder="Search tags"
			aria-label="Tags, separated by commas"
			bind:value={() => $library.searchDraft, library.editDraft}
		>
		<button type="submit">Search</button>
		<label class="file"
			>Upload<input
				bind:this={filesInput}
				type="file"
				multiple
				disabled={$library.uploading || $session.busy}
				onchange={(event) => selectFiles(event, library.upload)}
			></label
		>
	</form>
	{#if $library.status}
		<p class="feedback error" role="alert">{$library.status}</p>
	{/if}
	{#if $library.loading}
		<p role="status">Loading…</p>
	{/if}
	<Uploads
		uploading={$library.uploading}
		progress={$library.uploadProgress}
		failures={$library.uploadFailures}
		completed={$library.uploadCompleted}
		status={$library.uploadStatus}
		ondismiss={library.dismissCompleted}
	/>
	{#if $library.empty}
		<section class="panel empty stack">
			{#if $library.empty === "library"}
				<h2>Your library is empty</h2>
				<p>Upload a photo, video, audio file, or document to get started.</p>
				<button
					type="button"
					disabled={$library.uploading}
					onclick={() => pickFiles(filesInput)}
				>
					Upload files
				</button>
			{:else}
				<h2>No files match your search</h2>
				<p>Try different tags or clear your search to see all files.</p>
				<button
					type="button"
					class="secondary"
					onclick={() => {
						library.editDraft("");
						library.search("");
					}}
				>
					Clear search
				</button>
			{/if}
		</section>
	{/if}
	<div class="results">
		{#each $library.cards as media (media.id)}
			<MediaCard
				{media}
				onreveal={(opener) => library.reveal(media.id, opener)}
				ondownload={() => library.download(media.id)}
				onremove={() => library.remove(media.id)}
				onretag={(tags) => library.retag(media.id, tags)}
			/>
		{/each}
	</div>
	{#if $library.next}
		<button
			class="more"
			type="button"
			disabled={$library.loading}
			onclick={library.more}
		>
			More
		</button>
	{/if}
{/if}
<ImageDialog selected={$library.selected} onclose={library.closePreview} />
<style>
.file {
	font: inherit;
	border: 1px solid transparent;
	border-radius: 0.4rem;
	padding: 0.5rem 0.75rem;
	background: var(--accent);
	color: var(--paper);
	cursor: pointer;
	display: inline-block;
	flex: none;
}
.file input {
	position: absolute;
	width: 1px;
	height: 1px;
	opacity: 0;
	padding: 0;
}
.file:focus-within {
	outline: 2px solid var(--accent);
	outline-offset: 3px;
}
.toolbar {
	margin-bottom: 1rem;
}
.empty > button {
	align-self: center;
}
.empty {
	max-width: 42rem;
	margin: 3rem auto;
	text-align: center;
	padding: 3rem 1rem;
}
.results {
	display: grid;
	grid-template-columns: repeat(auto-fill, minmax(min(17rem, 100%), 1fr));
	gap: 1rem;
}
.more {
	display: block;
	margin: 1.5rem auto;
}
@media (max-width: 32rem) {
	.toolbar {
		flex-wrap: wrap;
	}
	.toolbar input {
		flex-basis: 100%;
	}
}
</style>
