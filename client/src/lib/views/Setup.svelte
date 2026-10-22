<script lang="ts">
import { untrack } from "svelte";
import LibraryBackup from "../components/LibraryBackup.svelte";
import PairingReceive from "../components/PairingReceive.svelte";
import SetupChoices, {
	type SetupChoice,
} from "../components/SetupChoices.svelte";
import type { Pairing } from "../stores/pairing.ts";
import type { Session } from "../stores/session.ts";

interface Props {
	session: Session;
	pairing: Pairing;
}
let { session, pairing }: Props = $props();
let choice = $state<SetupChoice | null>(null);
let server = $state(untrack(() => $session.serverUrl));
let otc = $state("");
let file = $state<File | null>(null);
let password = $state("");
let stored = $state(false);
let backupSaved = $state(false);
const busy = $derived($session.busy || $pairing.active);
function startOver() {
	if (
		confirm("Discard this new library? Its backup file will not be needed.")
	) {
		stored = false;
		backupSaved = false;
		void session.forget();
	}
}
</script>
{#snippet serverSettings()}
	<details>
		<summary>Server settings</summary>
		<label class="field"
			>Server<input
				type="url"
				bind:value={server}
				disabled={busy}
				required
			></label
		>
	</details>
{/snippet}
{#snippet step(
	number: number,
)}
	<p class="step">Step {number} of 3</p>
{/snippet}
<section class="panel stack setup">
	{#if $session.pendingConnection}
		<h2>Can’t reach your library</h2>
		<p>
			Your library is saved in this browser, but the server could not be reached
			to check its history.
		</p>
		<button type="button" disabled={busy} onclick={session.retryConnection}>
			Try again
		</button>
		<div class="cluster">
			<button
				type="button"
				class="secondary"
				disabled={busy}
				onclick={() => {
					if (confirm("Remove the library from this browser?")) {
						void session.forget();
					}
				}}
			>
				Remove library from this browser
			</button>
		</div>
	{:else if $session.prepared && !backupSaved}
		<div>
			{@render step(2)}
			<h2>Save your backup</h2>
		</div>
		<p>
			A backup is the only way to recover your library if you lose this browser.
		</p>
		<LibraryBackup
			password={$session.backup?.password ?? ""}
			{busy}
			downloaded={$session.backupDownloaded}
			onprepare={session.prepareBackup}
			ondownload={session.downloadBackup}
			oncopy={session.copyBackupPassword}
		/>
		<label class="confirm">
			<input type="checkbox" bind:checked={stored} disabled={busy}>
			I saved the backup file and its password
		</label>
		<button
			type="button"
			disabled={busy || !$session.backupDownloaded || !stored}
			onclick={() => (backupSaved = true)}
		>
			Continue
		</button>
		<div class="cluster">
			<button
				type="button"
				class="secondary"
				disabled={busy}
				onclick={startOver}
			>
				Start over
			</button>
		</div>
	{:else if $session.prepared}
		<div>
			{@render step(3)}
			<h2>Enter your invitation code</h2>
		</div>
		<form
			class="stack"
			onsubmit={(event) => {
				event.preventDefault();
				void session.create({ serverUrl: $session.serverUrl, otc: otc.trim() });
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
			<button type="submit" disabled={busy || !otc.trim()}>
				Create library
			</button>
		</form>
		<div class="cluster">
			<button
				type="button"
				class="secondary"
				disabled={busy}
				onclick={() => (backupSaved = false)}
			>
				Back
			</button>
			<button
				type="button"
				class="secondary"
				disabled={busy}
				onclick={startOver}
			>
				Start over
			</button>
		</div>
	{:else if choice === null}
		<h2>Set up your library</h2>
		<SetupChoices {busy} onchoose={(next) => (choice = next)} />
	{:else}
		{#if choice === "create"}
			<div>
				{@render step(1)}
				<h2>Create your library</h2>
			</div>
			<p>
				Your library keys are created and kept in this browser. Next, you save a
				backup of them, then enter your invitation code.
			</p>
			<form
				class="stack"
				onsubmit={(event) => {
					event.preventDefault();
					stored = false;
					backupSaved = false;
					void session.prepareCreation(server.trim());
				}}
			>
				{@render serverSettings()}
				<button type="submit" disabled={busy}>Create library keys</button>
			</form>
		{:else if choice === "restore"}
			<h2>Restore from a backup</h2>
			<form
				class="stack"
				onsubmit={(event) => {
					event.preventDefault();
					if (file) {
						void session.restore(file, password);
					}
				}}
			>
				<p>
					Choose your library backup file and enter its password. The library
					history is checked before it opens.
				</p>
				<label class="field"
					>Library backup<input
						type="file"
						disabled={busy}
						required
						onchange={(event) =>
							(file = event.currentTarget.files?.[0] ?? null)}
					></label
				>
				<label class="field"
					>Backup password<input
						type="password"
						bind:value={password}
						disabled={busy}
						required
						autocomplete="off"
					></label
				>
				<button type="submit" disabled={busy || !file}>Restore library</button>
			</form>
		{:else}
			<h2>Connect from another device</h2>
			{@render serverSettings()}
			<PairingReceive
				state={$pairing}
				busy={$session.busy}
				onreceive={(code) => pairing.receive(code, server.trim())}
				onreject={pairing.rejectVerification}
				oncancel={pairing.cancel}
			/>
		{/if}
		<div class="cluster">
			<button
				type="button"
				class="secondary"
				disabled={busy}
				onclick={() => (choice = null)}
			>
				Back
			</button>
		</div>
	{/if}
	{#if $session.error}
		<p class="error" role="alert">{$session.error}</p>
	{/if}
	{#if $session.notice}
		<p role="status">{$session.notice}</p>
	{/if}
</section>
<style>
.setup {
	width: 100%;
	max-width: 36rem;
	margin: auto;
}
.step {
	margin: 0 0 var(--space-1);
	font-size: var(--text-sm);
}
.confirm {
	display: flex;
	align-items: center;
	gap: var(--space-2);
}
.confirm input {
	width: auto;
	flex: none;
}
</style>
