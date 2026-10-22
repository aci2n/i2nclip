<script lang="ts">
interface Props {
	query: string;
	onsearch: (query: string) => void;
}
let { query, onsearch }: Props = $props();
let draft = $state("");
$effect(() => {
	draft = query;
});
</script>
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
<style>
form {
	display: flex;
	flex-wrap: wrap;
	gap: var(--space-3);
	align-items: end;
}
label {
	flex: 1;
	min-width: 10rem;
}
</style>
