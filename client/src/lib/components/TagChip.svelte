<script lang="ts">
interface Props {
	text: string;
	removeLabel: string;
	disabled?: boolean;
	onselect?: () => void;
	onremove: () => void;
}
let {
	text,
	removeLabel,
	disabled = false,
	onselect,
	onremove,
}: Props = $props();
</script>

<span class="chip">
	{#if onselect}
		<button
			class="tag-text select"
			type="button"
			aria-label={`Search for tag ${text}`}
			{disabled}
			onclick={onselect}
		>
			{text}
		</button>
	{:else}
		<span class="tag-text">{text}</span>
	{/if}
	<button type="button" aria-label={removeLabel} {disabled} onclick={onremove}>
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
</span>

<style>
.chip {
	display: inline-flex;
	align-items: center;
	gap: 0.25rem;
	max-width: 100%;
	min-height: 2rem;
	padding: 0.125rem 0.375rem;
	font-size: 0.85rem;
	line-height: 1.5;
	border-radius: 0.25rem;
	background: var(--soft);
	color: var(--accent);
}
.tag-text {
	min-width: 0;
	overflow-wrap: anywhere;
}
button {
	display: grid;
	place-items: center;
	flex: none;
	width: 1.5rem;
	height: 1.5rem;
	padding: 0.125rem;
	border: 0;
	background: transparent;
	color: inherit;
}
button.select {
	display: block;
	flex: 0 1 auto;
	width: auto;
	height: auto;
	text-align: left;
	font-size: inherit;
	line-height: inherit;
}
button.select:hover {
	text-decoration: underline;
}
svg {
	width: 1rem;
	height: 1rem;
}
@media (max-width: 32rem), (pointer: coarse) {
	.chip {
		min-height: 3rem;
		padding-block: 0;
		font-size: 1rem;
	}
	button {
		width: 3rem;
		height: 3rem;
		padding: 0.5rem;
	}
}
</style>
