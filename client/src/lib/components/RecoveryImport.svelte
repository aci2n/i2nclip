<script>
let { busy, error, onrestore } = $props();
let file = $state(null);
let password = $state("");
</script>
<form
	class="stack"
	onsubmit={(event) => {
		event.preventDefault();
		if (file) {
			onrestore(file, password);
		}
	}}
>
	<p>Restore your library from an encrypted recovery file.</p>
	<label class="field"
		>Recovery file<input
			type="file"
			accept=".msgpack,application/msgpack"
			required
			disabled={busy}
			onchange={(event) => (file = event.currentTarget.files[0] || null)}
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
	<button type="submit" disabled={busy || !file}>Restore library</button>
	{#if error}
		<p class="error" role="alert">{error}</p>
	{/if}
</form>
