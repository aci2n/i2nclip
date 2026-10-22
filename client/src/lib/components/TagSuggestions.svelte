<script lang="ts">
interface Props {
	suggestions: readonly string[];
	onsearch: (query: string) => void;
}
let { suggestions, onsearch }: Props = $props();
</script>
<fieldset class="cluster" aria-label="Tag suggestions">
	{#each suggestions.slice(0, 12) as tag}
		<button type="button" class="chip" onclick={() => onsearch(tag)}>
			{tag}
		</button>
	{/each}
</fieldset>
<style>
button {
	overflow-wrap: anywhere;
	text-align: left;
}
</style>
