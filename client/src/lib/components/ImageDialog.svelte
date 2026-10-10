<script>
import { modal } from "../stores/dom.js";

let { selected, onclose } = $props();
</script>

<dialog
	id="full"
	use:modal={selected}
	onclick={(event) => {
		if (event.target === event.currentTarget) onclose();
	}}
	onkeydown={(event) => {
		if (event.key === "Escape") {
			event.preventDefault();
			onclose();
		}
	}}
	oncancel={(event) => {
		event.preventDefault();
		onclose();
	}}
>
	{#if selected}
		<img src={selected.url} alt={selected.name}>
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
#full {
	padding: 0;
	border: 0;
	background: transparent;
	max-width: 95vw;
	max-height: 95vh;
}
#full::backdrop {
	background: #000b;
}
#full img {
	display: block;
	max-width: 95vw;
	max-height: 95vh;
	object-fit: contain;
}
.close {
	position: fixed;
	top: 1rem;
	right: 1rem;
	font-size: 1.5rem;
	background: var(--paper);
	color: inherit;
}
</style>
