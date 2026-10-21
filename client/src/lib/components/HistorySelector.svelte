<script lang="ts">
interface Props {
	sequence: number;
	live: number;
	historical: boolean;
	busy: boolean;
	error: string;
	onselect: (sequence: number | null) => void;
}
let { sequence, live, historical, busy, error, onselect }: Props = $props();
let draft = $state<number | undefined>(0);
$effect(() => {
	draft = sequence;
});
</script>
<section class="history panel stack" aria-label="Library history">
	<form
		onsubmit={(event) => {
			event.preventDefault();
			onselect(Number(draft));
		}}
	>
		<label class="field"
			>Block<input
				type="number"
				min="0"
				max={live}
				step="1"
				required
				bind:value={draft}
				disabled={busy}
			></label
		>
		<button type="submit" class="secondary" disabled={busy}>
			Browse block
		</button>
		<button type="button" class="secondary" onclick={() => onselect(null)}>
			Live view
		</button>
	</form>
	<p>
		{historical
			? `Read-only history at block ${sequence}.`
			: `Live view · block ${sequence}.`}
	</p>
	{#if historical}
		<p>
			Uploads and file changes are disabled. Purged data stays unavailable in
			history.
		</p>
	{/if}
	{#if error}
		<p class="error" role="alert">{error}</p>
	{/if}
</section>
<style>
form {
	display: flex;
	align-items: end;
	flex-wrap: wrap;
	gap: 0.75rem;
}
label {
	max-width: 10rem;
}
.history {
	margin-bottom: 1rem;
}
</style>
