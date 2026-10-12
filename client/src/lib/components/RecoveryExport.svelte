<script>
let { busy, status, error, onexport } = $props();
let password = $state("");
let confirmation = $state("");
let localError = $state("");
function submit(event) {
	event.preventDefault();
	localError = "";
	if (password !== confirmation) {
		localError = "Recovery passwords do not match.";
		return;
	}
	onexport(password);
}
</script>
<details class="panel">
	<summary>Download recovery file</summary>
	<form class="stack" onsubmit={submit}>
		<p>
			A recovery file gives full access to this library. Its password is
			independent of your master password.
		</p>
		<label class="field"
			>Recovery password<input
				type="password"
				required
				minlength="8"
				autocomplete="new-password"
				bind:value={password}
				disabled={busy}
			></label
		>
		<label class="field"
			>Confirm recovery password<input
				type="password"
				required
				minlength="8"
				autocomplete="new-password"
				bind:value={confirmation}
				disabled={busy}
			></label
		>
		<button type="submit" disabled={busy}>Download recovery file</button>
		{#if localError || error}
			<p role="alert" class="error">{localError || error}</p>
		{:else if status}
			<p role="status">{status}</p>
		{/if}
	</form>
</details>
<style>
form {
	margin-top: 1rem;
}
</style>
