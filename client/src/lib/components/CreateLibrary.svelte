<script lang="ts">
interface Props {
	busy: boolean;
	error: string;
	oncreate: (value: { otc: string }) => void;
}
let { busy, error, oncreate }: Props = $props();
let otc = $state("");
</script>
<form
	class="stack"
	onsubmit={(event) => {
		event.preventDefault();
		oncreate({ otc });
	}}
>
	<label class="field"
		>Invitation code<input
			required
			autocomplete="off"
			bind:value={otc}
			disabled={busy}
		></label
	>
	<button type="submit" disabled={busy}>Create library</button>
	{#if error}
		<p class="error" role="alert">{error}</p>
	{/if}
</form>
