<script lang="ts">
import type { MediaDisplay } from "../media/display.ts";

interface Props {
	media: MediaDisplay | null | undefined;
	presentation?: "dialog" | "page";
}
let { media, presentation = "page" }: Props = $props();
const name = $derived(media?.metadata?.name || media?.id || "");
const type = $derived(
	media?.metadata?.content_type || "application/octet-stream",
);
const text = $derived(media?.text);
const url = $derived(media?.url);
const autoplay = $derived(presentation === "dialog");
let player = $state<HTMLMediaElement>();
let failed = $state(false);
let loading = $state(false);
$effect(() => {
	const current = player;
	return () => current?.pause();
});
$effect(() => {
	loading = Boolean(url) && /^(image|audio|video)\//.test(type);
	failed = false;
});
</script>

<div class="content" class:page={presentation === "page"}>
	{#if media}
		{#key media.id}
			{#if text !== null && text !== undefined}
				<section class="text-preview" aria-label={name}>
					<p class="text-name">{name}</p>
					<pre>{text}</pre>
					{#if media.textTruncated}
						<p>
							Preview limited to the first 256 KiB. Download the file to read it
							all.
						</p>
					{/if}
				</section>
			{:else if type.startsWith("image/") && (media.url || media.preview)}
				{#if media.url}
					{#if loading && media.preview}
						<img src={media.preview} alt={name}>
					{/if}
					<img
						class:pending={loading && Boolean(media.preview)}
						src={media.url}
						alt={loading && media.preview ? "" : name}
						onload={() => (loading = false)}
						onerror={() => {
							failed = true;
							loading = false;
						}}
					>
				{:else if media.preview}
					<img src={media.preview} alt={name}>
				{/if}
			{:else if type.startsWith("video/") && media.url}
				<video
					bind:this={player}
					onloadeddata={() => (loading = false)}
					src={media.url}
					aria-label={name}
					onerror={() => {
						failed = true;
						loading = false;
					}}
					controls
					{autoplay}
					playsinline
				>
					<track kind="captions">
				</video>
			{:else if type.startsWith("audio/") && media.url}
				<div class="audio">
					{#if media.preview}
						<img src={media.preview} alt={name}>
					{/if}
					<p>{name}</p>
					<audio
						bind:this={player}
						onloadeddata={() => (loading = false)}
						src={media.url}
						aria-label={name}
						onerror={() => {
							failed = true;
							loading = false;
						}}
						controls
						{autoplay}
					></audio>
				</div>
			{:else if media.preview}
				<img src={media.preview} alt={name}>
			{:else if media.ready}
				<p>This file is ready to download.</p>
			{/if}
		{/key}
		{#if loading && !media.error}
			<div class="loading stack" role="status">
				<p>{name}</p>
				<p>Loading…</p>
			</div>
		{/if}
		{#if failed && !media.error}
			<p class="error" role="alert">This browser could not display the file.</p>
		{/if}
	{/if}
</div>
<style>
img.pending {
	position: absolute;
	visibility: hidden;
}

.loading {
	position: fixed;
	top: 50%;
	left: 50%;
	transform: translate(-50%, -50%);
	max-width: min(22rem, calc(100vw - 2rem));
	overflow-wrap: anywhere;
	padding: 1rem;
	background: var(--paper);
	border-radius: 0.5rem;
}

.text-preview {
	width: min(60rem, 95vw);
	max-height: 95vh;
	overflow: auto;
	padding: 3rem;
	background: var(--paper);
	border-radius: 0.5rem;
}
.text-name {
	font-weight: 600;
	overflow-wrap: anywhere;
	margin-bottom: 1rem;
}
pre {
	white-space: pre-wrap;
	overflow-wrap: anywhere;
	font: 0.9rem / 1.5 monospace;
	margin: 0 0 1rem;
}
img,
video {
	display: block;
	max-width: 95vw;
	max-height: 95vh;
	object-fit: contain;
}
.audio {
	max-width: 95vw;
}
.audio p {
	position: fixed;
	top: 1rem;
	left: 1rem;
	max-width: calc(100vw - 6rem);
	padding: 0.5rem 0.75rem;
	background: var(--paper);
	border-radius: 0.25rem;
	overflow-wrap: anywhere;
}
.audio img {
	max-height: 75vh;
	max-width: 100%;
}
audio {
	position: fixed;
	bottom: 1rem;
	left: 50%;
	transform: translateX(-50%);
	width: min(28rem, calc(100vw - 2rem));
}

@media (max-width: 32rem) {
	img,
	video {
		max-height: calc(100dvh - 9rem);
	}
	.text-preview {
		width: calc(100vw - 2rem);
		max-height: calc(100dvh - 9rem);
		padding: 1.5rem 1rem;
	}
	audio {
		bottom: 5rem;
	}
	.audio img {
		max-height: calc(100dvh - 12rem);
	}
	.audio p {
		top: 5rem;
	}
}

.content.page {
	flex: 1;
	min-height: 0;
	display: grid;
	place-items: center;
}
.page > img,
.page video {
	max-width: 100%;
	max-height: calc(100dvh - 8rem);
}
.page .audio {
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: 1.5rem;
	width: min(36rem, 100%);
}
.page .audio img {
	max-height: calc(100dvh - 14rem);
}
.page .audio p,
.page .text-name {
	display: none;
}
.page audio {
	position: static;
	transform: none;
	width: 100%;
}
.page:has(.text-preview) {
	align-items: start;
}
.page .text-preview {
	width: min(64rem, 100%);
	max-height: none;
	padding: 1rem;
}
.page .error {
	padding: 1rem;
}
@media (max-width: 32rem) {
	.page > img,
	.page video {
		max-height: calc(100dvh - 12rem);
	}
}
</style>
