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
<details class="history panel" open={historical}>
	<summary>
		{historical
			? `Viewing version ${sequence} (read-only)`
			: "Earlier versions"}
	</summary>
	<div class="stack">
		<form
			onsubmit={(event) => {
				event.preventDefault();
				onselect(Number(draft));
			}}
		>
			<label class="field"
				>Version<input
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
				Show version
			</button>
			<button type="button" class="secondary" onclick={() => onselect(null)}>
				Back to current
			</button>
		</form>
		<p>
			{historical
				? `Viewing version ${sequence}. Uploads and changes are disabled; permanently deleted files stay unavailable.`
				: `Current version ${sequence}.`}
		</p>
		{#if error}
			<p class="error" role="alert">{error}</p>
		{/if}
	</div>
</details>
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
