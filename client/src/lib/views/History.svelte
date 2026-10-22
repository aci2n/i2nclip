<script lang="ts">
import { onDestroy, onMount } from "svelte";
import Timeline from "../components/Timeline.svelte";
import type { History } from "../stores/history.ts";
import type { MaterializedView } from "../stores/materialized-view.ts";

interface Props {
	history: History;
	view: MaterializedView;
	onview: (sequence: number) => void;
}
let { history, view, onview }: Props = $props();
onMount(() => {
	void history.open();
});
onDestroy(() => history.close());
</script>
<section class="stack" aria-label="History">
	<h2>History</h2>
	{#if $history.error}
		<p class="error" role="alert">{$history.error}</p>
	{/if}
	{#if $view.selectionError}
		<p class="error" role="alert">{$view.selectionError}</p>
	{/if}
	{#if $history.loading && !$history.items.length}
		<p role="status">Loading history…</p>
	{:else}
		<Timeline
			items={$history.items}
			more={$history.more}
			viewing={$view.historical ? ($view.selected?.sequence ?? null) : null}
			undoing={$history.undoing}
			busy={$view.selecting}
			{onview}
			onundo={history.undo}
			onmore={history.more}
		/>
	{/if}
</section>
