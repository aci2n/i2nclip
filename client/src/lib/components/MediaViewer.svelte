<script lang="ts">
import type { ViewerState } from "../stores/media-viewer.ts";

interface Props {
	value: ViewerState;
	onretry: () => void;
	ondownload: () => void;
	onlibrary: (event: MouseEvent) => void;
}
let { value, onretry, ondownload, onlibrary }: Props = $props();
const media = $derived(value.media);
const name = $derived(media?.metadata?.name || media?.id || "Open file");
const type = $derived(
	media?.metadata?.content_type || "application/octet-stream",
);
const error = $derived(value.error || (media?.error ? media.message : ""));
const ready = $derived(!value.loading && !error && Boolean(media?.url));
let player = $state<HTMLMediaElement>();
let failed = $state(false);
$effect(() => {
	const current = player;
	return () => current?.pause();
});
$effect(() => {
	void media?.url;
	failed = false;
});
</script>

<section class="viewer" aria-label="File viewer">
	<header>
		<a href="?page=library" onclick={onlibrary}>Library</a>
		<h1>{name}</h1>
		<button
			type="button"
			class="secondary"
			onclick={ondownload}
			disabled={!ready}
		>
			Download
		</button>
	</header>
	{#if value.loading}
		<div class="status stack" role="status">
			{#if !media}
				<p>Loading metadata…</p>
			{:else if media.progress === 100}
				<p>Preparing…</p>
			{:else}
				<p>
					{media.progress === null ? "Loading…" : `Loading ${media.progress}%`}
				</p>
			{/if}
			<progress
				max="100"
				value={media?.progress ?? undefined}
				aria-label="Download progress"
			></progress>
		</div>
	{:else if error}
		<div class="status stack">
			<p class="error" role="alert">{error}</p>
			<button type="button" onclick={onretry}>Retry</button>
		</div>
	{:else if ready && media}
		<div class="content" class:text={media.text !== null}>
			{#if media.text !== null}
				<div class="text-content">
					<pre>{media.text}</pre>
					{#if media.textTruncated}
						<p>
							Preview limited to the first 256 KiB. Download the file to read it
							all.
						</p>
					{/if}
				</div>
			{:else if type.startsWith("image/")}
				<img
					src={media.url}
					alt={name}
					onerror={() => {
						failed = true;
					}}
				>
			{:else if type.startsWith("video/")}
				<video
					bind:this={player}
					src={media.url}
					aria-label={name}
					controls
					playsinline
					onerror={() => {
						failed = true;
					}}
				>
					<track kind="captions">
				</video>
			{:else if type.startsWith("audio/")}
				<div class="audio">
					{#if media.preview}
						<img src={media.preview} alt="Album artwork">
					{/if}
					<audio
						bind:this={player}
						src={media.url}
						aria-label={name}
						controls
						onerror={() => {
							failed = true;
						}}
					></audio>
				</div>
			{:else}
				<p>This file is ready to download.</p>
			{/if}
		</div>
		{#if failed}
			<p class="error" role="alert">
				This browser could not display the file. Use Download to save it.
			</p>
		{/if}
	{/if}
</section>

<style>
.viewer {
	min-height: calc(100dvh - 2rem);
	display: flex;
	flex-direction: column;
	gap: 1rem;
}
header {
	display: flex;
	align-items: center;
	flex-wrap: wrap;
	gap: 1rem;
}
h1 {
	flex: 1;
	min-width: 0;
	font-size: 1rem;
	overflow-wrap: anywhere;
}
header a {
	display: inline-flex;
	align-items: center;
	min-height: 3rem;
}
header button {
	flex: none;
}
.status {
	margin: auto;
	width: min(24rem, 100%);
	padding-block: 3rem;
}
progress {
	width: 100%;
	accent-color: var(--accent);
}
.content {
	flex: 1;
	min-height: 0;
	display: grid;
	place-items: center;
}
.content > img,
video {
	display: block;
	max-width: 100%;
	max-height: calc(100dvh - 8rem);
	object-fit: contain;
}
.audio {
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: 1.5rem;
	width: min(36rem, 100%);
}
.audio img {
	max-width: 100%;
	max-height: calc(100dvh - 14rem);
	object-fit: contain;
}
audio {
	width: 100%;
}
.content.text {
	align-items: start;
}
.text-content {
	width: min(64rem, 100%);
	display: flex;
	flex-direction: column;
	gap: 1rem;
}
pre {
	margin: 0;
	padding: 1rem;
	background: var(--paper);
	border-radius: 0.5rem;
	white-space: pre-wrap;
	overflow-wrap: anywhere;
	font: 0.9rem / 1.5 monospace;
}
@media (max-width: 32rem) {
	header {
		gap: 0.5rem;
	}
	h1 {
		flex-basis: calc(100% - 5rem);
	}
	header button {
		margin-left: auto;
	}
	.content > img,
	video {
		max-height: calc(100dvh - 12rem);
	}
}
</style>
