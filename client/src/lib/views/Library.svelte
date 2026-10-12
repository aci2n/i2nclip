<script>
import ImageDialog from "../components/ImageDialog.svelte";
import MediaCard from "../components/MediaCard.svelte";
import Unlock from "../components/Unlock.svelte";
import Uploads from "../components/Uploads.svelte";
import { pickFiles, selectFiles } from "../stores/dom.js";

let { session, library, settingsHref, onsettings } = $props();
let filesInput = $state();
</script>

{#if !$session.configured}
	<section id="setup" class="panel empty stack">
		<h2>Your library starts here</h2>
		<p>
			<a href={settingsHref} onclick={onsettings}
				>Create or restore your library</a
			>
			to start saving encrypted media.
		</p>
	</section>
{:else if !$session.unlocked}
	<Unlock {session} />
{:else}
	<form
		id="find"
		class="bar toolbar"
		onsubmit={(event) => {
			event.preventDefault();
			library.search($library.searchDraft);
		}}
	>
		<input
			id="tags"
			type="search"
			placeholder="Search tags"
			aria-label="Tags, separated by commas"
			bind:value={() => $library.searchDraft, library.editDraft}
		>
		<button type="submit">Search</button>
		<label class="file"
			>Upload<input
				bind:this={filesInput}
				id="files"
				type="file"
				multiple
				onchange={(event) => selectFiles(event, library.upload)}
			></label
		>
	</form>
{/if}
<p id="status" role="status">
	{[
		$library.status,
		!$session.configured || $session.unlocked ? $session.error : "",
	]
		.filter(Boolean)
		.join(" | ")}
</p>
{#if $session.unlocked}
	<Uploads {library} />
{/if}
{#if $session.unlocked && $library.empty}
	<section id="empty-library" class="panel empty stack">
		{#if $library.empty === "library"}
			<h2>Your library is empty</h2>
			<p>Upload a photo, video, or audio file to get started.</p>
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
<div id="results">
	{#each $library.cards as { item, media } (media)}
		<MediaCard {item} {media} {library} />
	{/each}
</div>
{#if $library.next}
	<button
		id="more"
		type="button"
		disabled={$library.loading}
		onclick={library.more}
	>
		More
	</button>
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
#results {
	display: grid;
	grid-template-columns: repeat(auto-fill, minmax(min(17rem, 100%), 1fr));
	gap: 1rem;
}
#status {
	min-height: 1.5rem;
	margin: 0 0 0.5rem;
}
#more {
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
