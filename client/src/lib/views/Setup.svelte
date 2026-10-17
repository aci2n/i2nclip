<script lang="ts">
import type { Pairing } from "../stores/pairing.ts";
import type { Session } from "../stores/session.ts";

interface Props {
	session: Session;
	pairing: Pairing;
}

import { untrack } from "svelte";
import CreateLibrary from "../components/CreateLibrary.svelte";
import PairingReceive from "../components/PairingReceive.svelte";
import RecoveryImport from "../components/RecoveryImport.svelte";

let { session, pairing }: Props = $props();
let mode = $state("create");
let server = $state(untrack(() => $session.serverUrl));
const busy = $derived($session.busy || $pairing.active);
</script>
<section class="panel stack">
	<h2>Your encrypted library</h2>
	<p>Files are encrypted in your browser before upload.</p>
	<fieldset class="choices" aria-label="Setup method">
		<button
			type="button"
			class="secondary"
			aria-pressed={mode === "create"}
			disabled={busy}
			onclick={() => (mode = "create")}
		>
			Create
		</button>
		<button
			type="button"
			class="secondary"
			aria-pressed={mode === "restore"}
			disabled={busy}
			onclick={() => (mode = "restore")}
		>
			Restore
		</button>
		<button
			type="button"
			class="secondary"
			aria-pressed={mode === "pair"}
			disabled={busy}
			onclick={() => (mode = "pair")}
		>
			Pair device
		</button>
	</fieldset>
	{#if mode === "create" || mode === "pair"}
		<details>
			<summary>Server configuration</summary>
			<label class="field server"
				>Server<input
					type="url"
					required
					bind:value={server}
					disabled={busy}
				></label
			>
		</details>
	{/if}
	{#if mode === "create"}
		<CreateLibrary
			{busy}
			error={$session.error}
			oncreate={(value) =>
				session.create({ ...value, serverUrl: server.trim() })}
		/>
	{:else if mode === "restore"}
		<RecoveryImport {busy} error={$session.error} onrestore={session.restore} />
	{:else}
		<PairingReceive
			state={$pairing}
			busy={$session.busy}
			onreceive={(code) => pairing.receive(code, server.trim())}
			onreject={pairing.rejectVerification}
			oncancel={pairing.cancel}
		/>
	{/if}
</section>
<style>
.choices {
	display: flex;
	flex-wrap: wrap;
	gap: 0.5rem;
	border: 0;
	min-width: 0;
}
button[aria-pressed="true"] {
	outline: 2px solid var(--accent);
}
.server {
	margin-top: 1rem;
}
</style>
