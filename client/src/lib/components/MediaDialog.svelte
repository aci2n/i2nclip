<script>
import { modal } from "../ui/dom.js";
import { previewSwipes } from "../ui/preview-swipes.js";

let {
	selected,
	progress = null,
	hasPrevious = false,
	hasNext = false,
	onprevious,
	onnext,
	onretry,
	onclose,
} = $props();
let player = $state();
$effect(() => {
	const current = player;
	if (selected?.loading) {
		current?.pause();
	}
	return () => current?.pause();
});
</script>

<dialog
	aria-label="Media preview"
	use:modal={selected}
	use:previewSwipes={{
		key: selected?.id,
		enabled: Boolean(selected) && !selected.loading,
		onleft: hasNext ? onnext : undefined,
		onright: hasPrevious ? onprevious : undefined,
		onup: selected?.text == null ? onclose : undefined,
	}}
	class:text={selected?.text != null}
	onclick={(event) => {
		if (event.target === event.currentTarget) {
			onclose();
		}
	}}
	onkeydown={(event) => {
		if (event.key === "Escape") {
			event.preventDefault();
			onclose();
		} else if (
			!event.altKey &&
			!event.ctrlKey &&
			!event.metaKey &&
			!event.shiftKey
		) {
			if (event.key === "ArrowLeft") {
				event.preventDefault();
				if (hasPrevious && !selected?.loading) {
					onprevious();
				}
			} else if (event.key === "ArrowRight") {
				event.preventDefault();
				if (hasNext && !selected?.loading) {
					onnext();
				}
			}
		}
	}}
	oncancel={(event) => {
		event.preventDefault();
		onclose();
	}}
>
	{#if selected}
		{#if selected.text !== null && selected.text !== undefined}
			<section class="text-preview" aria-label={selected.name}>
				<p class="text-name">{selected.name}</p>
				<pre>{selected.text}</pre>
				{#if selected.textTruncated}
					<p>
						Preview limited to the first 256 KiB. Download the file to read it
						all.
					</p>
				{/if}
			</section>
		{:else if selected.type.startsWith("image/") &&
			(selected.url || selected.preview)}
			<img src={selected.url || selected.preview} alt={selected.name}>
		{:else if selected.type.startsWith("video/") && selected.url}
			<video
				bind:this={player}
				src={selected.url}
				aria-label={selected.name}
				controls
				autoplay
				playsinline
			>
				<track kind="captions">
			</video>
		{:else if selected.type.startsWith("audio/") && selected.url}
			<div class="audio">
				{#if selected.preview}
					<img src={selected.preview} alt={selected.name}>
				{/if}
				<p>{selected.name}</p>
				<audio
					bind:this={player}
					src={selected.url}
					aria-label={selected.name}
					controls
					autoplay
				></audio>
			</div>
		{:else if selected.preview}
			<img src={selected.preview} alt={selected.name}>
		{/if}
		{#if selected.loading}
			<p class="status" role="status">Loading {progress ?? 0}%</p>
		{:else if selected.error}
			<div class="status stack">
				<p role="alert">{selected.error}</p>
				<button type="button" onclick={onretry}>Retry</button>
			</div>
		{/if}
		<button
			type="button"
			class="previous arrow"
			aria-label="Previous media"
			disabled={!hasPrevious || selected.loading}
			onclick={onprevious}
		>
			←
		</button>
		<button
			type="button"
			class="next arrow"
			aria-label="Next media"
			disabled={!hasNext || selected.loading}
			onclick={onnext}
		>
			→
		</button>
		<button
			type="button"
			class="close"
			aria-label="Close preview"
			onclick={onclose}
		>
			×
		</button>
	{/if}
</dialog>

<style>
dialog {
	touch-action: pinch-zoom;
	overscroll-behavior: contain;
	padding: 0;
	border: 0;
	background: transparent;
	max-width: 95vw;
	max-height: 95vh;
	min-width: min(16rem, 95vw);
	min-height: min(10rem, 95vh);
}
dialog.text {
	touch-action: pan-y pinch-zoom;
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
dialog::backdrop {
	background: #000b;
}
dialog img,
dialog video {
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
.status {
	position: fixed;
	top: 50%;
	left: 50%;
	transform: translate(-50%, -50%);
	max-width: min(22rem, calc(100vw - 2rem));
	margin: 0;
	padding: 0.75rem 1rem;
	border-radius: 0.25rem;
	background: var(--paper);
	color: inherit;
}
.status p {
	margin: 0;
}
.arrow,
.close {
	position: fixed;
	font-size: 1.5rem;
	background: var(--paper);
	color: inherit;
}
.arrow {
	top: 50%;
	transform: translateY(-50%);
}
.previous {
	left: 1rem;
}
.next {
	right: 1rem;
}
.close {
	top: 1rem;
	right: 1rem;
}
@media (max-width: 32rem) {
	dialog img,
	dialog video {
		max-height: calc(100dvh - 9rem);
	}
	.text-preview {
		width: calc(100vw - 2rem);
		max-height: calc(100dvh - 9rem);
		padding: 1.5rem 1rem;
	}
	.arrow,
	.close {
		min-width: 3rem;
		min-height: 3rem;
		padding: 0.25rem 0.5rem;
	}
	.arrow {
		top: auto;
		bottom: 1rem;
		transform: none;
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
</style>
