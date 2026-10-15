<script>
import { fileSize, fileType, uploadedAt } from "../media/format.js";
import FilenameEditor from "./FilenameEditor.svelte";
import TagEditor from "./TagEditor.svelte";

let { media, onreveal, ondownload, onremove, onupdate } = $props();
const type = $derived(media.metadata?.content_type || "");
const name = $derived(media.metadata?.name || media.id);
const summary = $derived(
	[fileType(type), fileSize(media.metadata?.size)].filter(Boolean).join(" · "),
);
</script>

<article class="panel card" class:deleted={media.deleted}>
	<div class="media">
		{#if type.startsWith("image/") && (media.preview || media.url)}
			<button
				type="button"
				class="image-button"
				aria-label={`Open ${name}`}
				onclick={(event) => onreveal(event.currentTarget)}
				disabled={media.busy || media.deleted}
			>
				<img
					src={media.shown || !media.preview ? media.url : media.preview}
					alt={name}
				>
			</button>
		{:else if type.startsWith("audio/") || type.startsWith("video/")}
			{#if media.shown}
				{#if type.startsWith("audio/")}
					{#if media.preview}
						<img src={media.preview} alt={name}>
					{:else}
						<span class="file-type">{fileType(type)}</span>
					{/if}
					<audio controls autoplay src={media.url}></audio>
				{:else}
					<video controls autoplay src={media.url}>
						<track kind="captions">
					</video>
				{/if}
			{:else}
				{#if media.preview}
					<img src={media.preview} alt={name}>
				{:else}
					<span class="file-type">{fileType(type)}</span>
				{/if}
				<button
					type="button"
					class="play"
					data-act="play"
					aria-label={`Play ${name}`}
					onclick={(event) => onreveal(event.currentTarget)}
					disabled={media.busy || media.deleted}
				>
					▶
				</button>
			{/if}
		{:else if type.startsWith("image/") && !media.deleted}
			<button
				type="button"
				class="image-button file-type"
				aria-label={`Open ${name}`}
				onclick={(event) => onreveal(event.currentTarget)}
				disabled={media.busy}
			>
				Open image
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
		disabled={media.busy ||
			media.deleted ||
			media.metadataUnavailable ||
			!media.metadata}
		onsave={(name) => onupdate({ name })}
	/>
	<p class="meta">{summary}</p>
	{#if media.metadata}
		<TagEditor
			tags={media.metadata.tags || []}
			{name}
			disabled={media.busy || media.deleted || media.metadataUnavailable}
			onsave={(tags) => onupdate({ tags })}
		/>
	{/if}
	<details class="card-details">
		<summary>File details</summary>
		<dl>
			<dt>Filename</dt>
			<dd>{name}</dd>
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
.media button:disabled {
	opacity: 1;
}
.media img,
.media video {
	width: 100%;
	height: 100%;
	object-fit: contain;
	display: block;
}
.media audio {
	position: absolute;
	bottom: 0.5rem;
	width: calc(100% - 1rem);
}
.image-button {
	border: 0;
	padding: 0;
	background: transparent;
	width: 100%;
	height: 100%;
	display: block;
}
.file-type {
	color: var(--accent);
	font-size: 1.1rem;
	letter-spacing: 0.08em;
}
.play {
	position: absolute;
	inset: 0;
	width: 100%;
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
.actions button {
	font-size: 0.85rem;
	padding: 0.25rem 0.5rem;
}
.actions {
	padding-top: 0.5rem;
	margin-top: auto;
}
output {
	display: block;
	margin: 0;
}
</style>
