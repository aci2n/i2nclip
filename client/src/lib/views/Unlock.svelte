<script lang="ts">
import type { Session } from "../stores/session.ts";

interface Props {
	session: Session;
}
let { session }: Props = $props();
let password = $state("");
let confirmation = $state("");
let error = $state("");
async function submit(event: SubmitEvent) {
	event.preventDefault();
	error = "";
	if ($session.status === "new" && password !== confirmation) {
		error = "Passwords do not match.";
		return;
	}
	const success =
		$session.status === "new"
			? await session.initialize(password)
			: await session.unlock(password);
	if (success) {
		password = "";
		confirmation = "";
	}
}
</script>
<section class="panel stack">
	<h1>i2nclip</h1>
	<h2>
		{$session.status === "new" ? "Protect this client" : "Unlock this client"}
	</h2>
	<p>
		Your master password protects your saved library identity on this device.
	</p>
	<form class="stack" onsubmit={submit}>
		<label class="field"
			>Master password<input
				type="password"
				required
				minlength="8"
				autocomplete={$session.status === "new"
					? "new-password"
					: "current-password"}
				bind:value={password}
				disabled={$session.busy}
			></label
		>
		{#if $session.status === "new"}
			<label class="field"
				>Confirm master password<input
					type="password"
					required
					minlength="8"
					autocomplete="new-password"
					bind:value={confirmation}
					disabled={$session.busy}
				></label
			>
		{/if}
		<button type="submit" disabled={$session.busy}>
			{$session.busy
				? "Working…"
				: $session.status === "new"
					? "Create master password"
					: "Unlock"}
		</button>
		{#if error || $session.error}
			<p class="error" role="alert">{error || $session.error}</p>
		{/if}
	</form>
	{#if $session.status === "locked"}
		<details>
			<summary>Reset this client</summary>
			<div class="stack reset">
				<p>
					This removes the saved identity from this device. Server files remain.
					You will need a recovery file or another paired device to reconnect.
				</p>
				<button
					class="secondary danger"
					type="button"
					onclick={() => {
						if (confirm("Reset this client and remove its saved identity?")) {
							session.reset();
						}
					}}
				>
					Reset client
				</button>
			</div>
		</details>
	{/if}
</section>
<style>
section {
	max-width: 32rem;
	margin: 3rem auto;
}
.reset {
	margin-top: 1rem;
}
</style>
