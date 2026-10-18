<script lang="ts">
import { onDestroy } from "svelte";
import MediaCard from "../components/MediaCard.svelte";
import MediaDialog from "../components/MediaDialog.svelte";
import SearchForm from "../components/SearchForm.svelte";
import Uploads from "../components/Uploads.svelte";
import { canPreview } from "../media/format.ts";
import { routeHref } from "../routes.ts";
import type { Library as LibraryStore } from "../stores/library.ts";
import type { Session } from "../stores/session.ts";
import type { Tags } from "../stores/tags.ts";
import type { Uploads as UploadsStore } from "../stores/uploads.ts";
import { pickFiles, selectFiles } from "../ui/dom.ts";

interface Props {
	session: Session;
	library: LibraryStore;
	tags: Tags;
	uploads: UploadsStore;
}

let { session, library, tags, uploads }: Props = $props();
let filesInput = $state<HTMLInputElement>();
onDestroy(() => library.closePreview());
const previewable = $derived(
	$library.cards.filter(
		(media) =>
			!media.deleted &&
			canPreview(
				media.metadata?.content_type || "",
				media.metadata?.name || "",
			),
	),
);
const previewIndex = $derived(
	previewable.findIndex((media) => media.id === $library.selected?.id),
);
const previewMedia = $derived(previewable[previewIndex]);
function movePreview(step: number) {
	const media = previewable[previewIndex + step];
	if (media) {
		library.reveal(media.id);
	}
}
</script>
{#if !$session.configured}
	<section class="panel empty stack">
		<h2>Your library starts here</h2>
		<p>
			<a href={routeHref({ page: "settings" })}
				>Create or restore your library</a
			>
			to start saving encrypted media.
		</p>
	</section>
{:else}
	<div class="toolbar">
		<div class="search-container">
			<SearchForm
				draft={$library.searchDraft}
				query={$library.query}
				onchange={library.editDraft}
				suggestions={$tags.tags}
				onadd={library.addTag}
				onremove={library.removeTag}
				onclear={library.clearSearch}
			/>
		</div>
		<button
			type="button"
			class="secondary refresh"
			disabled={$library.loading || $session.busy}
			onclick={library.refresh}
		>
			Refresh
		</button>
		<button
			type="button"
			class="upload"
			disabled={$uploads.uploading || $session.busy}
			onclick={() => pickFiles(filesInput)}
		>
			Upload
		</button>
		<input
			bind:this={filesInput}
			type="file"
			aria-label="Upload"
			multiple
			hidden
			disabled={$uploads.uploading || $session.busy}
			onchange={(event) => selectFiles(event, uploads.upload)}
		>
	</div>
	{#if $tags.error || $tags.warning}
		<div class="feedback" role={$tags.error ? "alert" : "status"}>
			<p class:error={Boolean($tags.error)}>
				{$tags.error ? `Tag suggestions: ${$tags.error}` : $tags.warning}
			</p>
			<button
				type="button"
				class="secondary"
				disabled={$tags.loading}
				onclick={tags.refresh}
			>
				Retry tag suggestions
			</button>
		</div>
	{/if}
	{#if $library.status}
		<p class="feedback error" role="alert">{$library.status}</p>
	{/if}
	{#if $library.loading}
		<p role="status">Loading…</p>
	{/if}
	<Uploads
		uploading={$uploads.uploading}
		progress={$uploads.progress}
		failures={$uploads.failures}
		completed={$uploads.completed}
		notices={$uploads.notices}
		status={$uploads.status}
		ondismiss={uploads.dismissCompleted}
	/>
	{#if $library.empty}
		<section class="panel empty stack">
			{#if $library.empty === "library"}
				<h2>Your library is empty</h2>
				<p>Upload a photo, video, audio file, or document to get started.</p>
				<button
					type="button"
					disabled={$uploads.uploading}
					onclick={() => pickFiles(filesInput)}
				>
					Upload files
				</button>
			{:else}
				<h2>No files match your search</h2>
				<p>Try different tags or clear your search to see all files.</p>
				<button type="button" class="secondary" onclick={library.clearSearch}>
					Show all files
				</button>
			{/if}
		</section>
	{/if}
	<div class="results">
		{#each $library.cards as media (media.id)}
			<MediaCard
				{media}
				suggestions={$tags.tags}
				onsearch={library.addTag}
				onreveal={(opener) => library.reveal(media.id, opener)}
				ondownload={() => library.download(media.id)}
				onremove={() => library.remove(media.id)}
				onupdate={(patch) => library.updateMetadata(media.id, patch)}
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
<MediaDialog
	selected={previewMedia || null}
	opener={$library.selected?.opener}
	hasPrevious={previewIndex > 0}
	hasNext={previewIndex >= 0 && previewIndex < previewable.length - 1}
	onprevious={() => movePreview(-1)}
	onnext={() => movePreview(1)}
	onretry={() => $library.selected && library.reveal($library.selected.id)}
	onclose={library.closePreview}
/>
<style>
.toolbar {
	display: grid;
	grid-template-columns: minmax(0, 1fr) auto auto;
	align-items: start;
	gap: 0.5rem;
	margin-bottom: 1rem;
}
.search-container {
	min-width: 0;
}
.upload,
.refresh {
	min-height: 3rem;
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
		grid-template-columns: 1fr 1fr;
	}
	.search-container {
		grid-column: 1 / -1;
	}
}
</style>
