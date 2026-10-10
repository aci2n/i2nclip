<script>
import { untrack } from "svelte";
import ImageDialog from "../components/ImageDialog.svelte";
import MediaCard from "../components/MediaCard.svelte";
import Unlock from "../components/Unlock.svelte";
import { pickFiles, selectFiles } from "../stores/dom.js";

let { session, library, settingsHref, onsettings } = $props();
let tags = $state(untrack(() => library.query()));
let filesInput = $state();
</script>

{#if !$session.wrappedKey}
	<section id="setup" class="panel empty">
		<h2>Your library starts here</h2>
		<p>
			<a href={settingsHref} onclick={onsettings}
				>Create or restore your library</a
			>
			to start saving encrypted media.
		</p>
	</section>
{:else if !$session.privateKey}
	<Unlock {session} />
{:else}
	<form
		id="find"
		class="bar toolbar"
		onsubmit={(event) => {
			event.preventDefault();
			library.search(tags);
		}}
	>
		<input
			id="tags"
			type="search"
			placeholder="Search tags"
			aria-label="Tags, separated by commas"
			bind:value={tags}
		>
		<button type="submit">Search</button>
		<label class="file" class:disabled={$library.uploading}
			>Upload<input
				bind:this={filesInput}
				id="files"
				type="file"
				multiple
				disabled={$library.uploading}
				onchange={(event) => selectFiles(event, library.upload)}
			></label
		>
	</form>
{/if}
<p id="status" role="status">
	{[
		$library.status,
		$library.uploadStatus,
		!$session.wrappedKey || $session.privateKey ? $session.error : "",
	]
		.filter(Boolean)
		.join(" | ")}
</p>
{#if $library.uploadProgress}
	<section class="upload-progress" aria-label="Upload progress">
		<p role="status">
			Uploading {$library.uploadProgress.index} of
			{$library.uploadProgress.total}: {$library.uploadProgress.name}
		</p>
		<progress
			max="100"
			value={$library.uploadProgress.percent}
			aria-label="Current file upload"
		></progress>
		<span>{$library.uploadProgress.percent}%</span>
	</section>
{/if}
{#if $library.uploadFailures.length}
	<section class="upload-failures" aria-label="Failed uploads">
		<h2>Failed uploads</h2>
		<ul>
			{#each $library.uploadFailures as failure}
				<li><strong>{failure.file.name}</strong>: {failure.error}</li>
			{/each}
		</ul>
		<button
			type="button"
			class="secondary"
			disabled={$library.uploading}
			onclick={library.retryUploads}
		>
			Retry failed files
		</button>
	</section>
{/if}
{#if $session.privateKey && $library.empty}
	<section id="empty-library" class="panel empty">
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
			<h2>No matching clips</h2>
			<p>Try different tags or clear your search to see all clips.</p>
			<button
				type="button"
				class="secondary"
				onclick={() => {
					tags = "";
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
	margin: 0;
}
.file.disabled {
	opacity: 0.5;
	cursor: default;
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
.upload-progress,
.upload-failures {
	margin: 1rem 0;
	overflow-wrap: anywhere;
}
.upload-progress progress {
	width: min(24rem, 80%);
	accent-color: var(--accent);
	margin-right: 0.5rem;
}
.upload-failures ul {
	padding-left: 1.5rem;
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
