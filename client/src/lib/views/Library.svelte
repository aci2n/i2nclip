<script lang="ts">
import { onDestroy, onMount } from "svelte";
import HistorySelector from "../components/HistorySelector.svelte";
import LibrarySearch from "../components/LibrarySearch.svelte";
import MediaCard from "../components/MediaCard.svelte";
import MediaDialog from "../components/MediaDialog.svelte";
import Uploads from "../components/Uploads.svelte";
import type { ChainStore } from "../stores/chain.ts";
import type { ChainLibrary } from "../stores/chain-library.ts";
import type { ChainUploads } from "../stores/chain-uploads.ts";
import type { MaterializedView } from "../stores/materialized-view.ts";
import { pickFiles, selectFiles } from "../ui/dom.ts";

interface Props {
	library: ChainLibrary;
	uploads: ChainUploads;
	view: MaterializedView;
	chain: ChainStore;
}
let { library, uploads, view, chain }: Props = $props();
let filesInput = $state<HTMLInputElement>();
onMount(() => {
	void library.browse();
});
onDestroy(() => library.closePreview());
const previewIndex = $derived(
	$library.cards.findIndex((card) => card.id === $library.preview?.id),
);
function movePreview(step: number) {
	const card = $library.cards[previewIndex + step];
	if (card) {
		void library.reveal(card.id);
	}
}
</script>
<HistorySelector
	sequence={$view.selected?.sequence ?? 0}
	live={$chain.live?.sequence ?? 0}
	historical={$view.historical}
	busy={$view.selecting}
	error={$view.selectionError}
	onselect={view.select}
/>
<div class="toolbar">
	<div class="search">
		<LibrarySearch
			query={$library.query}
			suggestions={$library.suggestions}
			onsearch={library.search}
		/>
	</div>
	<div class="actions">
		<button
			type="button"
			class="secondary"
			disabled={$library.loading}
			onclick={library.refresh}
		>
			Refresh
		</button><button
			type="button"
			disabled={$library.readonly || $uploads.uploading}
			onclick={() => pickFiles(filesInput)}
		>
			Upload
		</button>
	</div>
	<input
		bind:this={filesInput}
		type="file"
		aria-label="Upload"
		hidden
		multiple
		disabled={$library.readonly || $uploads.uploading}
		onchange={(event) => selectFiles(event, uploads.upload)}
	>
</div>
<fieldset class="scope" aria-label="File collection">
	<button
		type="button"
		class="secondary"
		aria-pressed={!$library.deleted}
		onclick={() => library.showDeleted(false)}
	>
		Files
	</button><button
		type="button"
		class="secondary"
		aria-pressed={$library.deleted}
		onclick={() => library.showDeleted(true)}
	>
		Deleted files
	</button>
</fieldset>
<Uploads
	uploading={$uploads.uploading}
	progress={$uploads.progress}
	failures={$uploads.failures}
	completed={$uploads.completed}
	notices={$uploads.notices}
	status={$uploads.status}
	ondismiss={uploads.dismissCompleted}
/>
{#if $library.status}
	<p class="error feedback" role="alert">{$library.status}</p>
{/if}
{#if $library.loading}
	<p role="status">Loading metadata… {$view.indexed} of {$view.total}</p>
{:else if $library.incomplete}
	<p class="feedback" role="status">
		Some metadata is unavailable. Search results may be incomplete.
	</p>
{/if}
{#if $library.empty}
	<section class="panel empty stack">
		{#if $library.empty === "library"}
			<h2>Your library is empty</h2>
			<p>Upload a photo, video, audio file, or document to get started.</p>
			<button
				type="button"
				disabled={$library.readonly || $uploads.uploading}
				onclick={() => pickFiles(filesInput)}
			>
				Upload files
			</button>
		{:else if $library.empty === "deleted"}
			<h2>No deleted files</h2>
			<p>
				Deleted files remain here until you restore or permanently delete them.
			</p>
		{:else}
			<h2>No files match your search</h2>
			<button
				type="button"
				class="secondary"
				onclick={() => library.search("")}
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
			suggestions={$library.suggestions}
			readonly={$library.readonly}
			onsearch={library.search}
			onreveal={(opener) => library.reveal(media.id, opener)}
			ondownload={() => library.download(media.id)}
			onremove={() => library.remove(media.id)}
			onrestore={() => library.restore(media.id)}
			onpurge={() => library.purge(media.id)}
			onupdate={(patch, revision) =>
				library.updateMetadata(media.id, patch, revision)}
		/>
	{/each}
</div>
{#if $library.more}
	<button type="button" class="secondary more" onclick={library.more}>
		Load more
	</button>
{/if}
<MediaDialog
	selected={$library.preview ?? undefined}
	opener={$library.opener}
	hasPrevious={previewIndex > 0}
	hasNext={previewIndex >= 0 && previewIndex < $library.cards.length - 1}
	onprevious={() => movePreview(-1)}
	onnext={() => movePreview(1)}
	onretry={() => {
		if ($library.preview) {
			void library.reveal($library.preview.id);
		}
	}}
	onclose={library.closePreview}
/>
<style>
fieldset {
	border: 0;
	padding: 0;
	min-width: 0;
}
.toolbar {
	display: flex;
	align-items: end;
	gap: 1rem;
	flex-wrap: wrap;
	margin-bottom: 1rem;
}
.search {
	flex: 1;
	min-width: 0;
}
.actions,
.scope {
	display: flex;
	gap: 0.5rem;
	flex-wrap: wrap;
}
.scope {
	margin-bottom: 1rem;
}
.scope button[aria-pressed="true"] {
	outline: 2px solid var(--accent);
}
.results {
	display: grid;
	grid-template-columns: repeat(auto-fill, minmax(min(100%, 19rem), 1fr));
	gap: 1rem;
	margin-top: 1rem;
}
.feedback {
	margin: 0.75rem 0;
}
.more {
	display: block;
	margin: 1.5rem auto;
}
</style>
