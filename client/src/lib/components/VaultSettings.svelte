<script>
let { busy, error, status, onpassword } = $props();
let current = $state("");
let password = $state("");
let confirmation = $state("");
let localError = $state("");
function submit(event) {
	event.preventDefault();
	localError = "";
	if (password !== confirmation) {
		localError = "Passwords do not match.";
		return;
	}
	onpassword(current, password);
}
</script>
<details class="panel">
	<summary>Change master password</summary>
	<form class="stack" onsubmit={submit}>
		<label class="field"
			>Current master password<input
				type="password"
				required
				autocomplete="current-password"
				bind:value={current}
				disabled={busy}
			></label
		>
		<label class="field"
			>New master password<input
				type="password"
				required
				minlength="8"
				autocomplete="new-password"
				bind:value={password}
				disabled={busy}
			></label
		>
		<label class="field"
			>Confirm new master password<input
				type="password"
				required
				minlength="8"
				autocomplete="new-password"
				bind:value={confirmation}
				disabled={busy}
			></label
		>
		<button type="submit" disabled={busy}>Change password</button>
		{#if localError || error}
			<p class="error" role="alert">{localError || error}</p>
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
