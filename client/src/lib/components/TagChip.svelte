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
	<button
		class="icon"
		type="button"
		aria-label={removeLabel}
		{disabled}
		onclick={onremove}
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
</span>

<style>
.tag-text {
	min-width: 0;
	overflow-wrap: anywhere;
}
button.icon {
	width: var(--target);
	height: var(--target);
	padding: var(--space-1);
}
button.select {
	display: block;
	flex: 0 1 auto;
	padding: 0;
	border: 0;
	background: transparent;
	color: inherit;
	text-align: left;
	font-size: inherit;
	line-height: inherit;
}
button.select:hover {
	text-decoration: underline;
}
</style>
