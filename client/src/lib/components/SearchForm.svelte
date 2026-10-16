<script>
import TagInput from "./TagInput.svelte";

let {
	draft,
	query,
	suggestions = [],
	onchange,
	onadd,
	onremove,
	onclear,
} = $props();
let input = $state();
</script>
<div class="search">
	<form
		aria-label="Search library"
		onsubmit={(event) => {
			event.preventDefault();
			if (draft.trim()) {
				onadd(draft);
			}
		}}
	>
		<div class="terms">
			{#each query as tag}
				<span class="chip"
					><span>{tag}</span
					><button
						type="button"
						aria-label={`Remove search tag ${tag}`}
						onclick={() => onremove(tag)}
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
					</button></span
				>
			{/each}
			<TagInput
				value={draft}
				{suggestions}
				excluded={query}
				label="Search tags"
				placeholder="Search tags"
				search
				borderless
				{onchange}
				oncommit={onadd}
				onready={(node) => {
					input = node;
				}}
			/>
		</div>
		{#if draft || query.length}
			<button
				class="clear"
				type="button"
				aria-label="Clear search"
				title="Clear all search tags"
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
		{query.length
			? "Matching all selected tags."
			: "Add tags with Enter or choose a suggestion. All tags must match."}
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
	align-items: flex-start;
	gap: 0.25rem;
	min-width: 0;
	padding-left: 0.5rem;
	border-radius: 0.4rem;
	background: var(--paper);
	box-shadow: inset 0 0 0 1px var(--line);
}
form:focus-within {
	outline: 2px solid var(--accent);
	outline-offset: 2px;
}
.terms {
	display: flex;
	flex: 1;
	align-items: center;
	flex-wrap: wrap;
	gap: 0.5rem;
	min-width: 0;
}
.chip {
	display: inline-flex;
	align-items: center;
	gap: 0.25rem;
	max-width: 100%;
	margin-block: 0.25rem;
	padding-left: 0.375rem;
	border-radius: 0.25rem;
	background: var(--soft);
	color: var(--accent);
}
.chip span {
	overflow-wrap: anywhere;
	min-width: 0;
}
.chip button,
.clear {
	display: grid;
	place-items: center;
	flex: none;
	width: 3rem;
	height: 3rem;
	padding: 0.5rem;
	background: transparent;
	color: var(--accent);
}
.chip button {
	font-size: 1.5rem;
}
.clear svg,
.chip svg {
	width: 1.25rem;
	height: 1.25rem;
}
p {
	font-size: 0.85rem;
	overflow-wrap: anywhere;
}
</style>
