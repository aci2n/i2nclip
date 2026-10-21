<script lang="ts">
interface Props {
	busy: boolean;
	error: string;
	onrestore: (file: File, password: string) => void;
	label?: string;
	description?: string;
}
let {
	busy,
	error,
	onrestore,
	label = "Restore library",
	description = "Restore your library from its encrypted recovery file.",
}: Props = $props();
let file = $state<File | null>(null);
let password = $state("");
</script>
<form
	class="stack"
	onsubmit={(event) => {
		event.preventDefault();
		if (file) {
			file && onrestore(file, password);
		}
	}}
>
	<p>{description}</p>
	<label class="field"
		>Recovery file<input
			type="file"
			accept=".msgpack,application/msgpack"
			required
			disabled={busy}
			onchange={(event) => (file = event.currentTarget.files?.[0] || null)}
		></label
	>
	<label class="field"
		>Recovery password<input
			type="password"
			required
			autocomplete="off"
			bind:value={password}
			disabled={busy}
		></label
	>
	<button type="submit" disabled={busy || !file}>{label}</button>
	{#if error}
		<p class="error" role="alert">{error}</p>
	{/if}
</form>
