<script>
let { vault } = $props();
let password = $state("");
let confirmation = $state("");
let error = $state("");
let busy = $state(false);
const creating = $derived($vault.status === "uninitialized");
async function submit(event) {
	event.preventDefault();
	if (busy) {
		return;
	}
	error = "";
	if (creating && password !== confirmation) {
		error = "Passwords do not match.";
		return;
	}
	const secret = password;
	password = "";
	confirmation = "";
	busy = true;
	try {
		await (creating ? vault.initialize(secret) : vault.unlock(secret));
	} catch (failure) {
		error = failure.message;
	} finally {
		busy = false;
	}
}
</script>
<section class="panel stack vault-screen">
	{#if !$vault.ready}
		<p role="status">Loading…</p>
	{:else}
		<h1>{creating ? "Create your master password" : "Unlock i2nclip"}</h1>
		<p>
			{creating
				? "One password protects all libraries and pending uploads saved in this client. Other clients have their own master password."
				: "Enter this client’s master password to unlock all libraries."}
		</p>
		<form class="stack" id="vault-unlock" onsubmit={submit}>
			<div class="field">
				<label for="master-password">Master password</label>
				<input
					id="master-password"
					type="password"
					required
					minlength={creating ? 8 : undefined}
					autocomplete={creating ? "new-password" : "current-password"}
					bind:value={password}
					disabled={busy || $vault.busy}
				>
			</div>
			{#if creating}
				<div class="field">
					<label for="master-confirmation">Confirm master password</label>
					<input
						id="master-confirmation"
						type="password"
						required
						minlength="8"
						autocomplete="new-password"
						bind:value={confirmation}
						disabled={busy || $vault.busy}
					>
				</div>
			{/if}
			<button id="unlock-vault" type="submit" disabled={busy || $vault.busy}>
				{busy || $vault.busy
					? "Working…"
					: creating
						? "Create master password"
						: "Unlock"}
			</button>
			{#if error || $vault.error}
				<p class="error" role="alert">{error || $vault.error}</p>
			{/if}
		</form>
		{#if !creating}
			<details>
				<summary>Forgot your master password?</summary>
				<div class="stack recovery-help">
					<p>
						The password cannot be recovered. To start again, reset this client,
						create a new master password, then restore your recovery files or
						pair from another unlocked client. Reset removes pending uploads.
					</p>
					<button
						class="secondary danger"
						type="button"
						disabled={busy || $vault.busy}
						onclick={async () => {
							try {
								await vault.reset();
							} catch (failure) {
								error = failure.message;
							}
						}}
					>
						Reset this client
					</button>
				</div>
			</details>
		{/if}
	{/if}
</section>
<style>
.vault-screen {
	max-width: 32rem;
	margin: 2rem auto;
}
.recovery-help {
	margin-top: 1rem;
}
.danger {
	color: var(--error);
}
</style>
