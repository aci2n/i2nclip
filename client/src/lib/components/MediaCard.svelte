<script lang="ts">
import { fileSize, fileType } from "../media/format.ts";
import type { Metadata } from "../protocol/meta-plain.ts";
import { routeHref } from "../routes.ts";
import type { LibraryCard } from "../stores/chain-library.ts";
import FilenameEditor from "./FilenameEditor.svelte";
import TagEditor from "./TagEditor.svelte";

interface Props {
	media: LibraryCard;
	suggestions?: readonly string[];
	readonly?: boolean;
	onsearch: (tag: string) => void;
	onreveal: (opener: HTMLElement) => void;
	ondownload: () => void;
	onremove: () => void;
	onrestore: () => void;
	onpurge: () => void;
	onupdate: (patch: Metadata, revision: string) => Promise<boolean>;
}
let {
	media,
	suggestions = [],
	readonly = false,
	onsearch,
	onreveal,
	ondownload,
	onremove,
	onrestore,
	onpurge,
	onupdate,
}: Props = $props();
const name = $derived(media.metadata?.name || media.id);
const type = $derived(media.metadata?.content_type || "");
const editable = $derived(
	!readonly &&
		!media.busy &&
		!media.deleted &&
		!media.unavailable &&
		Boolean(media.metadata),
);
const source = $derived.by(() => {
	try {
		const url = new URL(media.metadata?.source_url || "");
		return ["https:", "http:"].includes(url.protocol) ? url.href : "";
	} catch {
		return "";
	}
});
</script>
<article class="panel card" class:deleted={media.deleted}>
	<button
		type="button"
		class="preview"
		aria-label={`Open ${name}`}
		onclick={(event) => onreveal(event.currentTarget)}
		disabled={media.busy || media.unavailable || !media.metadata}
	>
		{#if media.preview}
			<img src={media.preview} alt={name}>
		{:else}
			<span>{media.unavailable ? "Permanently purged" : fileType(type)}</span>
		{/if}
	</button>
	<FilenameEditor
		{name}
		revision={media.revision}
		disabled={!editable}
		onsave={(name, revision) => onupdate({ name }, revision)}
	/>
	<p class="meta">
		{[fileType(type), fileSize(media.metadata?.size)]
			.filter(Boolean)
			.join(" · ")}
	</p>
	<TagEditor
		tags={media.metadata?.tags || []}
		suggestions={[...suggestions]}
		{name}
		disabled={!editable}
		{onsearch}
		revision={media.revision}
		onsave={(tags, revision) => onupdate({ tags }, revision)}
	/>
	<details>
		<summary>File details</summary>
		<div class="stack details">
			<p>Added in block {media.createdSequence}</p>
			{#if type}
				<p>{type}</p>
			{/if}
			{#if media.metadata?.image}
				<p>{media.metadata.image.width} × {media.metadata.image.height}</p>
			{/if}
			{#if source}
				<a href={source} target="_blank" rel="noreferrer"
					>{media.metadata?.source_title || source}</a
				>
			{/if}
			<p class="identifier">{media.id}</p>
		</div>
	</details>
	<div class="actions">
		<a
			class="button secondary"
			target="_blank"
			rel="noreferrer"
			href={routeHref({ page: "media", id: media.id })}
			aria-label={`Link to ${name}`}
			>Private link</a
		>
		<button
			type="button"
			class="secondary"
			onclick={ondownload}
			disabled={media.busy || media.unavailable || !media.metadata}
		>
			Download
		</button>
		{#if media.deleted}
			<button
				type="button"
				class="secondary"
				onclick={onrestore}
				disabled={readonly || media.busy || media.unavailable}
			>
				Restore
			</button><button
				type="button"
				class="secondary danger"
				onclick={onpurge}
				disabled={readonly || media.busy || media.unavailable}
			>
				Permanently delete
			</button>
		{:else}
			<button
				type="button"
				class="secondary danger"
				onclick={onremove}
				disabled={readonly || media.busy || media.unavailable}
			>
				Delete
			</button>
		{/if}
	</div>
	{#if media.busy}
		<p role="status">Working…</p>
	{/if}
	{#if media.message}
		<p class:error={media.error} role={media.error ? "alert" : "status"}>
			{media.message}
		</p>
	{/if}
</article>
<style>
.card {
	display: flex;
	flex-direction: column;
	gap: 0.75rem;
	min-width: 0;
}
.preview {
	display: grid;
	place-items: center;
	aspect-ratio: 16 / 10;
	overflow: hidden;
	padding: 0;
	background: var(--soft);
	color: var(--muted);
	border: 0;
}
.preview img {
	width: 100%;
	height: 100%;
	object-fit: contain;
}
.preview span {
	padding: 1rem;
}
.meta {
	color: var(--muted);
	font-size: 0.875rem;
}
.actions {
	display: flex;
	flex-wrap: wrap;
	gap: 0.5rem;
	margin-top: auto;
}
.details {
	padding-top: 0.75rem;
	gap: 0.5rem;
	overflow-wrap: anywhere;
}
.identifier {
	font-family: monospace;
	font-size: 0.75rem;
}
.deleted {
	border-style: dashed;
}
</style>
