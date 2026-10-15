<script>
import { modal } from "../ui/dom.js";

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
</script>

<dialog
	aria-label="Image preview"
	use:modal={selected}
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
		{#if selected.url}
			<img src={selected.url} alt={selected.name}>
		{/if}
		{#if selected.loading}
			<p class="status" role="status">
				{#if selected.paging}
					Loading more images…
				{:else}
					Loading {progress ?? 0}%
				{/if}
			</p>
		{:else if selected.error}
			<div class="status stack">
				<p role="alert">{selected.error}</p>
				<button type="button" onclick={onretry}>Retry</button>
			</div>
		{/if}
		<button
			type="button"
			class="previous arrow"
			aria-label="Previous image"
			disabled={!hasPrevious || selected.loading}
			onclick={onprevious}
		>
			←
		</button>
		<button
			type="button"
			class="next arrow"
			aria-label="Next image"
			disabled={!hasNext || selected.loading}
			onclick={onnext}
		>
			→
		</button>
		<button
			type="button"
			class="close"
			aria-label="Close image"
			onclick={onclose}
		>
			×
		</button>
	{/if}
</dialog>

<style>
dialog {
	padding: 0;
	border: 0;
	background: transparent;
	max-width: 95vw;
	max-height: 95vh;
	min-width: min(16rem, 95vw);
	min-height: min(10rem, 95vh);
}
dialog::backdrop {
	background: #000b;
}
dialog img {
	display: block;
	max-width: 95vw;
	max-height: 95vh;
	object-fit: contain;
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
</style>
