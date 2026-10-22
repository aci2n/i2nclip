<script lang="ts">
interface Props {
	query: string;
	suggestions: readonly string[];
	onsearch: (query: string) => void;
}
let { query, suggestions, onsearch }: Props = $props();
let draft = $state("");
$effect(() => {
	draft = query;
});
</script>
<div class="stack">
	<form
		onsubmit={(event) => {
			event.preventDefault();
			onsearch(draft);
		}}
	>
		<label class="field"
			>Search files<input
				type="search"
				placeholder="Name or tag"
				bind:value={draft}
			></label
		>
		<button type="submit" class="secondary">Search</button>
		{#if query}
			<button type="button" class="secondary" onclick={() => onsearch("")}>
				Clear search
			</button>
		{/if}
	</form>
	{#if suggestions.length}
		<fieldset class="cluster suggestions" aria-label="Tag suggestions">
			{#each suggestions.slice(0, 12) as tag}
				<button type="button" class="secondary" onclick={() => onsearch(tag)}>
					{tag}
				</button>
			{/each}
		</fieldset>
	{/if}
</div>
<style>
form {
	display: flex;
	flex-wrap: wrap;
	gap: 0.75rem;
	align-items: end;
}
label {
	flex: 1;
	min-width: 10rem;
}
.suggestions button {
	max-width: 100%;
	overflow-wrap: anywhere;
	text-align: left;
	padding: 0.125rem 0.375rem;
	min-height: 2rem;
	font-size: 0.875rem;
}
@media (max-width: 32rem), (pointer: coarse) {
	.suggestions button {
		min-height: 3rem;
	}
}
</style>
