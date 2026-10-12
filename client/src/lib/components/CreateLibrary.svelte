<script>
let { busy, error, oncreate } = $props();
let name = $state("My library");
let otc = $state("");
</script>
<form
	class="stack"
	onsubmit={(event) => {
		event.preventDefault();
		oncreate({ name, otc });
	}}
>
	<label class="field"
		>Library name<input
			required
			maxlength="80"
			bind:value={name}
			disabled={busy}
		></label
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
