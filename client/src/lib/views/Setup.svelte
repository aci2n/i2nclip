<script lang="ts">
import { untrack } from "svelte";
import LibraryBackup from "../components/LibraryBackup.svelte";
import PairingReceive from "../components/PairingReceive.svelte";
import type { Pairing } from "../stores/pairing.ts";
import type { Session } from "../stores/session.ts";

interface Props {
	session: Session;
	pairing: Pairing;
}
let { session, pairing }: Props = $props();
let mode = $state("create");
let server = $state(untrack(() => $session.serverUrl));
let otc = $state("");
let file = $state<File | null>(null);
let password = $state("");
const busy = $derived($session.busy || $pairing.active);
</script>
<section class="panel stack setup">
	<h2>Your encrypted library</h2>
	<p>
		Files are encrypted in your browser. Connected browsers share full access to
		the library.
	</p>
	{#if $session.prepared}
		<h3>Save your library backup</h3>
		<LibraryBackup
			password={$session.backup?.password ?? ""}
			{busy}
			downloaded={$session.backupDownloaded}
			onprepare={session.prepareBackup}
			ondownload={session.downloadBackup}
			oncopy={session.copyBackupPassword}
		/>
		<form
			class="stack"
			onsubmit={(event) => {
				event.preventDefault();
				void session.create({ serverUrl: $session.serverUrl, otc: otc.trim() });
			}}
		>
			<label class="field"
				>Invitation code<input required bind:value={otc} disabled={busy}></label
			>
			<button type="submit" disabled={busy || !$session.backupDownloaded}>
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
	{:else if $session.pendingConnection}
		<p>
			Your credentials are saved. Connect to the server to verify the library
			history.
		</p>
		<button type="button" disabled={busy} onclick={session.retryConnection}>
			Retry connection
		</button>
		<button
			type="button"
			class="secondary"
			disabled={busy}
			onclick={session.forget}
		>
			Forget this browser
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
							? "Restore backup"
							: "Connect"}
				</button>
			{/each}
		</fieldset>
		{#if mode !== "restore"}
			<details>
				<summary>Server configuration</summary>
				<label class="field content"
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
			<button
				type="button"
				disabled={busy}
				onclick={() => session.prepareCreation(server.trim())}
			>
				Prepare library
			</button>
		{:else if mode === "restore"}
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
					Restore your credentials with a library backup and its generated
					password. History is verified before opening the library.
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
		<summary>Reset this browser</summary>
		<div class="stack content">
			<p>
				Remove the saved library access and cached data from this browser. Files
				on the server are not affected.
			</p>
			<button
				type="button"
				class="secondary danger"
				disabled={busy}
				onclick={() => {
					if (confirm("Remove saved library access from this browser?")) {
						void session.reset();
					}
				}}
			>
				Reset browser
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
.choices {
	display: flex;
	flex-wrap: wrap;
	gap: 0.5rem;
}
.choices button[aria-pressed="true"] {
	outline: 2px solid var(--accent);
}
.content {
	margin-top: 1rem;
}
</style>
