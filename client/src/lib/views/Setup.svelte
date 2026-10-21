<script lang="ts">
import { untrack } from "svelte";
import PairingReceive from "../components/PairingReceive.svelte";
import RecoveryImport from "../components/RecoveryImport.svelte";
import type { Pairing } from "../stores/chain-pairing.ts";
import type { Session } from "../stores/identity.ts";

interface Props {
	session: Session;
	pairing: Pairing;
}
let { session, pairing }: Props = $props();
let mode = $state("create");
let server = $state(untrack(() => $session.serverUrl));
let otc = $state("");
const busy = $derived($session.busy || $pairing.active);
const phase = $derived(
	$session.prepared ? session.device().identity.phase : null,
);
</script>
<section class="panel stack setup">
	<h2>Your encrypted library</h2>
	<p>
		Files are encrypted in your browser before upload. Device keys stay on this
		device.
	</p>
	{#if phase === "registering"}
		<h3>Save your recovery file</h3>
		{#if $session.recoveryFile}
			<p>
				Download this file and store its generated password securely and
				separately. Both are required to restore control if every device is
				lost.
			</p>
			<label class="field"
				>Recovery password<input
					type="text"
					readonly
					value={$session.recoveryFile.password}
					autocomplete="off"
					spellcheck="false"
				></label
			>
			<div class="actions">
				<button
					type="button"
					class="secondary"
					disabled={busy}
					onclick={session.copyRecoveryPassword}
				>
					Copy password
				</button><button
					type="button"
					disabled={busy}
					onclick={session.downloadRecovery}
				>
					Download recovery file
				</button>
			</div>
		{:else if !$session.recoveryDownloaded}
			<RecoveryImport
				{busy}
				error=""
				label="Load matching recovery file"
				description="Creation was interrupted. Load its recovery file to continue, or discard this preparation and start again."
				onrestore={session.resumeCreation}
			/>
		{/if}
		{#if $session.recoveryStatus}
			<p role="status">{$session.recoveryStatus}</p>
		{/if}
		<form
			class="stack"
			onsubmit={(event) => {
				event.preventDefault();
				void session.create({ serverUrl: $session.serverUrl, otc: otc.trim() });
			}}
		>
			<label class="field"
				>Invitation code<input required bind:value={otc} disabled={busy}></label
			><button type="submit" disabled={busy || !$session.recoveryDownloaded}>
				Create library
			</button>
		</form>
		<button
			type="button"
			class="secondary"
			disabled={busy}
			onclick={session.forget}
		>
			Discard prepared library
		</button>
	{:else if phase === "recovering"}
		<h3>Recovery enrollment prepared</h3>
		<p>
			History has been verified. Submit this enrollment to authorize this
			device. Existing devices and file history retain their current state.
		</p>
		<div class="actions">
			<button type="button" disabled={busy} onclick={session.submitRecovery}>
				Submit recovery enrollment
			</button><button
				type="button"
				class="secondary"
				disabled={busy}
				onclick={session.reconcileRecovery}
			>
				Check enrollment outcome
			</button>
		</div>
		<details>
			<summary>Prepare against a newer head</summary>
			<RecoveryImport
				{busy}
				error=""
				label="Prepare another enrollment"
				description="If the chain changed, unlock the recovery file again to prepare a fresh enrollment."
				allowRevocation
				onrestore={session.restore}
			/>
		</details>
		<button
			type="button"
			class="secondary"
			disabled={busy}
			onclick={session.forget}
		>
			Forget local candidate
		</button>
	{:else if phase === "pairing"}
		<h3>Device enrollment pending</h3>
		<p>
			Your fresh device credentials are saved locally. If enrollment committed,
			activation verifies the full chain before opening the library.
		</p>
		<button
			type="button"
			disabled={busy}
			onclick={() => session.activatePairing()}
		>
			Retry activation
		</button><button
			type="button"
			class="secondary"
			disabled={busy}
			onclick={session.forget}
		>
			Discard pending device
		</button>
	{:else}
		<fieldset class="choices" aria-label="Setup method">
			{#each ["create", "restore", "pair"] as choice}
				<button
					type="button"
					class="secondary"
					aria-pressed={mode === choice}
					disabled={busy}
					onclick={() => (mode = choice)}
				>
					{choice === "create"
						? "Create"
						: choice === "restore"
							? "Restore"
							: "Pair device"}
				</button>
			{/each}
		</fieldset>
		{#if mode === "create" || mode === "pair"}
			<details>
				<summary>Server configuration</summary>
				<label class="field server"
					>Server<input
						type="url"
						bind:value={server}
						disabled={busy}
						required
					></label
				>
			</details>
		{/if}
		{#if mode === "create"}
			<p>
				Create a library and its offline recovery file before registering the
				first device.
			</p>
			<button
				type="button"
				disabled={busy}
				onclick={() => session.prepareCreation(server.trim())}
			>
				Prepare library
			</button>
		{:else if mode === "restore"}
			<RecoveryImport
				{busy}
				error=""
				allowRevocation
				onrestore={session.restore}
				description="Unlock the offline recovery file to verify history and prepare this device’s enrollment. This works without any authorized device."
			/>
		{:else}
			<PairingReceive
				state={$pairing}
				busy={$session.busy}
				onreceive={(code) => pairing.receive(code, server.trim())}
				onreject={pairing.rejectVerification}
				oncancel={pairing.cancel}
			/>
		{/if}
	{/if}
	{#if $session.error}
		<p class="error" role="alert">{$session.error}</p>
	{/if}
	{#if $session.notice}
		<p role="status">{$session.notice}</p>
	{/if}
	<details>
		<summary>Reset this client</summary>
		<div class="stack content">
			<p>
				Remove local credentials and cached history. This also removes local
				rollback protection; server data remains.
			</p>
			<button
				type="button"
				class="secondary danger"
				disabled={busy}
				onclick={() => {
					if (confirm("Remove this client's credentials and cached history?")) {
						void session.reset();
					}
				}}
			>
				Reset client
			</button>
		</div>
	</details>
</section>
<style>
fieldset {
	border: 0;
	padding: 0;
	min-width: 0;
}
.setup {
	max-width: 42rem;
	margin: auto;
}
.choices,
.actions {
	display: flex;
	flex-wrap: wrap;
	gap: 0.5rem;
}
.choices button[aria-pressed="true"] {
	outline: 2px solid var(--accent);
}
.server,
.content {
	margin-top: 1rem;
}
input[readonly] {
	font-family: monospace;
}
</style>
