<script lang="ts">
import type { MediaDisplay } from "../media/display.ts";
import { modal } from "../ui/dom.ts";
import { previewSwipes } from "../ui/preview-swipes.ts";
import MediaContent from "./MediaContent.svelte";

interface Props {
	selected?: MediaDisplay;
	opener?: HTMLElement;
	hasPrevious?: boolean;
	hasNext?: boolean;
	onprevious: () => void;
	onnext: () => void;
	onretry: () => void;
	onclose: () => void;
}

let {
	selected,
	opener,
	hasPrevious = false,
	hasNext = false,
	onprevious,
	onnext,
	onretry,
	onclose,
}: Props = $props();
const name = $derived(selected?.metadata?.name || selected?.id || "");
const text = $derived(selected?.text);
</script>

<dialog
	aria-label="Media preview"
	use:modal={selected ? { opener } : null}
	use:previewSwipes={{
		key: selected?.id,
		enabled: Boolean(selected),
		onleft: hasNext ? onnext : undefined,
		onright: hasPrevious ? onprevious : undefined,
		onup: text == null ? onclose : undefined,
	}}
	class:text={text != null}
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
				if (hasPrevious) {
					onprevious();
				}
			} else if (event.key === "ArrowRight") {
				event.preventDefault();
				if (hasNext) {
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
		{#key selected.id}
			<MediaContent media={selected} presentation="dialog" />
		{/key}
		{#if selected.busy}
			<div class="status stack" role="status">
				<p>{name}</p>
				<p>Loading…</p>
			</div>
		{:else if selected.error}
			<div class="status stack">
				<p role="alert">{selected.message}</p>
				<button type="button" onclick={onretry}>Retry</button>
			</div>
		{/if}
		<button
			type="button"
			class="previous arrow"
			aria-label="Previous media"
			aria-disabled={!hasPrevious}
			onclick={() => {
				if (hasPrevious) {
					onprevious();
				}
			}}
		>
			<svg
				viewBox="0 0 24 24"
				aria-hidden="true"
				fill="none"
				stroke="currentColor"
				stroke-width="2"
				stroke-linecap="round"
				stroke-linejoin="round"
			>
				<path d="m14 6-6 6 6 6" />
			</svg>
		</button>
		<button
			type="button"
			class="next arrow"
			aria-label="Next media"
			aria-disabled={!hasNext}
			onclick={() => {
				if (hasNext) {
					onnext();
				}
			}}
		>
			<svg
				viewBox="0 0 24 24"
				aria-hidden="true"
				fill="none"
				stroke="currentColor"
				stroke-width="2"
				stroke-linecap="round"
				stroke-linejoin="round"
			>
				<path d="m10 6 6 6-6 6" />
			</svg>
		</button>
		<button
			type="button"
			class="close"
			aria-label="Close preview"
			onclick={onclose}
		>
			<svg
				viewBox="0 0 24 24"
				aria-hidden="true"
				fill="none"
				stroke="currentColor"
				stroke-width="2"
				stroke-linecap="round"
			>
				<path d="M6 6l12 12M18 6L6 18" />
			</svg>
		</button>
	{/if}
</dialog>

<style>
dialog {
	color: inherit;
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
dialog::backdrop {
	background: #000b;
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
	overflow-wrap: anywhere;
	margin: 0;
}
.arrow,
.close {
	position: fixed;
	display: grid;
	place-items: center;
	width: 3rem;
	height: 3rem;
	padding: 0.5rem;
	background: var(--paper);
	color: inherit;
}
svg {
	width: 1.25rem;
	height: 1.25rem;
}
.arrow {
	top: 50%;
	transform: translateY(-50%);
}
.arrow[aria-disabled="true"] {
	opacity: 0.5;
	cursor: default;
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
	.arrow {
		top: auto;
		bottom: 1rem;
		transform: none;
	}
}
</style>
