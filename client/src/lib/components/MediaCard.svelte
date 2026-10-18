<script lang="ts">
import { canPreview, fileSize, fileType, uploadedAt } from "../media/format.ts";
import type { Metadata } from "../protocol/meta-plain.ts";
import type { MediaState } from "../stores/media-item.ts";
import FilenameEditor from "./FilenameEditor.svelte";
import TagEditor from "./TagEditor.svelte";

interface Props {
	media: MediaState;
	suggestions?: string[];
	onsearch: (tag: string) => void;
	onreveal: (opener: HTMLElement) => void;
	ondownload: () => void;
	onremove: () => void;
	onupdate: (patch: Metadata) => Promise<boolean>;
}

let {
	media,
	suggestions = [],
	onsearch,
	onreveal,
	ondownload,
	onremove,
	onupdate,
}: Props = $props();
const type = $derived(media.metadata?.content_type || "");
const playable = $derived(/^(audio|video)\//.test(type));
const image = $derived(type.startsWith("image/"));
const name = $derived(media.metadata?.name || media.id);
const source = $derived.by(() => {
	try {
		const url = new URL(media.metadata?.source_url || "");
		return ["http:", "https:"].includes(url.protocol) ? url.href : "";
	} catch {
		return "";
	}
});
const summary = $derived(
	[fileType(type), fileSize(media.metadata?.size)].filter(Boolean).join(" · "),
);
</script>

<article class="panel card" class:deleted={media.deleted}>
	<div class="media">
		{#if canPreview(type, name)}
			<button
				type="button"
				class="preview-button"
				aria-label={`${playable ? "Play" : "Open"} ${name}`}
				onclick={(event) => onreveal(event.currentTarget)}
				disabled={media.busy || media.deleted}
			>
				{#if media.preview || (image && media.url)}
					<img src={media.preview || media.url} alt={name}>
				{:else}
					<span class="file-type">{fileType(type)}</span>
				{/if}
				{#if playable}
					<span class="play" aria-hidden="true">▶</span>
				{/if}
			</button>
		{:else if media.preview}
			<img src={media.preview} alt={name}>
		{:else}
			<span class="file-type">{fileType(type)}</span>
		{/if}
		{#if media.progress !== null}
			<span class="pct">{media.progress}%</span>
		{/if}
	</div>
	<FilenameEditor
		{name}
		disabled={media.busy || media.deleted || !media.metadata}
		onsave={(name) => onupdate({ name })}
	/>
	<p class="meta">{summary}</p>
	{#if media.metadata}
		<TagEditor
			tags={media.metadata.tags || []}
			{suggestions}
			{name}
			{onsearch}
			disabled={media.busy || media.deleted}
			onsave={(tags) => onupdate({ tags })}
		/>
	{/if}
	<details class="card-details">
		<summary>File details</summary>
		<dl>
			<dt>Filename</dt>
			<dd>{name}</dd>
			{#if source}
				<dt>Source</dt>
				<dd>
					<a href={source} title={source} target="_blank" rel="noreferrer">
						{media.metadata?.source_title || source}
					</a>
				</dd>
			{/if}
			<dt>Uploaded</dt>
			<dd>{uploadedAt(media.createdAt)}</dd>
			{#if type}
				<dt>Type</dt>
				<dd>{type}</dd>
			{/if}
			{#if media.metadata?.image}
				<dt>Dimensions</dt>
				<dd>{media.metadata.image.width} × {media.metadata.image.height}</dd>
			{/if}
		</dl>
	</details>
	<output class="feedback" class:error={media.error}>{media.message}</output>
	<div class="bar actions">
		{#if !media.deleted}
			<!-- biome-ignore lint/a11y/noAmbiguousAnchorText: The accessible label includes the filename. -->
			<a
				class="button secondary"
				aria-label={`Link to ${name}`}
				href={`?page=media&id=${media.id}`}
				target="_blank"
				rel="noopener noreferrer"
				>Link</a
			>
		{/if}
		<button
			type="button"
			class="secondary"
			data-act="download"
			onclick={ondownload}
			disabled={media.busy || media.deleted}
		>
			Download
		</button>
		<button
			type="button"
			class="secondary danger"
			data-act="delete"
			onclick={() => onremove()}
			disabled={media.busy || media.deleted}
		>
			Delete
		</button>
	</div>
</article>

<style>
.card {
	padding: 0.75rem;
	display: flex;
	flex-direction: column;
	gap: 0.5rem;
}
.meta {
	font-size: 0.85rem;
	margin: 0;
}
.card.deleted {
	opacity: 0.2;
}
.media {
	position: relative;
	aspect-ratio: 16 / 10;
	grid-template: minmax(0, 1fr) / minmax(0, 1fr);
	display: grid;
	place-items: center;
	overflow: hidden;
	border-radius: 0.3rem;
	background: var(--line);
}
.media img {
	width: 100%;
	height: 100%;
	object-fit: contain;
	display: block;
}
.preview-button {
	grid-template: minmax(0, 1fr) / minmax(0, 1fr);
	min-width: 0;
	min-height: 0;
	border: 0;
	padding: 0;
	background: transparent;
	width: 100%;
	height: 100%;
	display: grid;
	place-items: center;
	color: inherit;
}
.file-type {
	color: var(--accent);
	font-size: 1.1rem;
	letter-spacing: 0.08em;
}
.play {
	position: absolute;
	inset: 0;
	display: grid;
	place-items: center;
	background: transparent;
	color: var(--accent);
	font-size: 2rem;
}
.media:has(img) .play {
	background: #0004;
	color: white;
}
.media:has(.play) .file-type {
	position: absolute;
	top: 0.5rem;
	left: 0.75rem;
	font-size: 0.8rem;
}
.pct {
	position: absolute;
	inset: 0;
	display: grid;
	place-items: center;
	background: #0006;
	color: white;
}
.card-details {
	margin: 0;
	color: var(--muted);
	font-size: 0.85rem;
}
dl {
	display: grid;
	gap: 0.25rem;
	margin: 0.75rem 0;
	font-size: 0.85rem;
}
dt {
	color: var(--muted);
}
dd {
	margin: 0 0 0.5rem;
	overflow-wrap: anywhere;
}
.actions button,
.actions a {
	font-size: 0.85rem;
	padding: 0.25rem 0.5rem;
}
.actions {
	flex-wrap: wrap;
	padding-top: 0.5rem;
	margin-top: auto;
}
output {
	display: block;
	margin: 0;
}
@media (max-width: 32rem), (pointer: coarse) {
	.actions button,
	.actions a {
		min-height: 3rem;
		padding: 0.5rem 0.75rem;
		font-size: 1rem;
	}
}
</style>
