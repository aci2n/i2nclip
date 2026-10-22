<script lang="ts">
interface Props {
	sequence: number;
	busy: boolean;
	error: string;
	oncurrent: () => void;
}
let { sequence, busy, error, oncurrent }: Props = $props();
</script>
<section class="banner panel" aria-label="Earlier version">
	<p>
		Viewing version {sequence}, read-only. Uploads and changes are disabled;
		permanently deleted files stay unavailable.
	</p>
	<button type="button" class="secondary" disabled={busy} onclick={oncurrent}>
		Back to current
	</button>
	{#if error}
		<p class="error" role="alert">{error}</p>
	{/if}
</section>
<style>
.banner {
	display: flex;
	align-items: center;
	justify-content: space-between;
	flex-wrap: wrap;
	gap: var(--space-3);
	margin-bottom: var(--space-4);
}
p {
	flex: 1 1 18rem;
	margin: 0;
}
</style>
