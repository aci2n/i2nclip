<script>
let { session, id = "unlock", statusId = "unlock-status" } = $props();
let password = $state("");
function submit(event) {
	event.preventDefault();
	session.unlock(password);
}
</script>

<form {id} onsubmit={submit} class="panel stack">
	<h2>Unlock your library</h2>
	<p>Your library stays unlocked for this browser session.</p>
	<div class="field">
		<label for="pass">Unlock password</label>
		<div class="bar">
			<input
				id="pass"
				type="password"
				required
				autocomplete="current-password"
				bind:value={password}
				disabled={$session.busy}
			>
			<button type="submit" disabled={$session.busy}>
				{$session.busy ? "Unlocking…" : "Unlock"}
			</button>
		</div>
	</div>
	<p id={statusId} role="status">{$session.error}</p>
</form>

<style>
form {
	min-width: 0;
}
form[id="unlock"] {
	max-width: 32rem;
	margin: 2rem auto;
}
</style>
