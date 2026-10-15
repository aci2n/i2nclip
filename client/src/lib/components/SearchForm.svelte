<script>
let { draft, query, onchange, onsubmit, onclear } = $props();
let input = $state();
</script>
<div class="search">
	<form
		aria-label="Search library"
		onsubmit={(event) => {
			event.preventDefault();
			onsubmit();
		}}
	>
		<button type="submit" aria-label="Search" title="Search tags">
			<svg
				viewBox="0 0 24 24"
				aria-hidden="true"
				fill="none"
				stroke="currentColor"
				stroke-width="2"
				stroke-linecap="round"
			>
				<circle cx="10.5" cy="10.5" r="6.5" />
				<path d="m16 16 4 4" />
			</svg>
		</button>
		<input
			bind:this={input}
			type="search"
			placeholder="Search tags"
			aria-label="Tags, separated by commas"
			value={draft}
			oninput={(event) => onchange(event.currentTarget.value)}
		>
		{#if draft || query}
			<button
				type="button"
				aria-label="Clear search"
				title="Clear search"
				onclick={() => {
					onclear();
					input?.focus();
				}}
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
	</form>
	<p>
		{#if query.trim()}
			Matching all tags: <span>{query}</span>
		{:else}
			Separate tags with commas. All tags must match.
		{/if}
	</p>
</div>
<style>
.search {
	display: grid;
	gap: 0.5rem;
	min-width: 0;
}
form {
	display: flex;
	align-items: center;
	min-width: 0;
	border-radius: 0.4rem;
	background: var(--paper);
	box-shadow: inset 0 0 0 1px var(--line);
}
form:focus-within {
	outline: 2px solid var(--accent);
	outline-offset: 2px;
}
input {
	flex: 1;
	width: 0;
	min-height: 3rem;
	padding: 0.5rem 0;
	border: 0;
	border-radius: 0;
	background: transparent;
}
input:focus-visible {
	outline: none;
}
input::-webkit-search-cancel-button {
	display: none;
}
button {
	display: grid;
	place-items: center;
	flex: none;
	width: 3rem;
	height: 3rem;
	padding: 0.5rem;
	background: transparent;
	color: var(--muted);
}
button:hover {
	color: var(--accent);
}
svg {
	width: 1.25rem;
	height: 1.25rem;
}
p {
	font-size: 0.85rem;
	overflow-wrap: anywhere;
}
span {
	color: var(--accent);
}
@media (max-width: 32rem) {
	input {
		font-size: 1.1rem;
	}
}
</style>
