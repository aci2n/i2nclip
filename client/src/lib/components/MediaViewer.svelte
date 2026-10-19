<script lang="ts">
import { routeHref } from "../routes.ts";
import type { ViewerState } from "../stores/media-viewer.ts";
import MediaContent from "./MediaContent.svelte";

interface Props {
	value: ViewerState;
	onretry: () => void;
	ondownload: () => void;
}
let { value, onretry, ondownload }: Props = $props();
const media = $derived(value.media);
const name = $derived(media?.metadata?.name || media?.id || "Open file");
const error = $derived(value.error || (media?.error ? media.message : ""));
const ready = $derived(!value.loading && !error && Boolean(media?.ready));
</script>

<section class="viewer" aria-label="File viewer">
	<header>
		<a href={routeHref({ page: "library" })}>Library</a>
		<h1>{name}</h1>
		<button
			type="button"
			class="secondary"
			onclick={ondownload}
			disabled={!ready || media?.busy}
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
		<MediaContent {media} />
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
}
</style>
