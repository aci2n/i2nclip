<script>
import { untrack } from "svelte";
import Pairing from "./Pairing.svelte";
import RecoveryImport from "./RecoveryImport.svelte";

let {
	busy,
	defaultServer,
	error,
	pairingState,
	oncreate,
	onrestore,
	onreceive,
	onapprove,
	onreject,
	oncancel,
} = $props();
let mode = $state("create");
let server = $state(untrack(() => defaultServer));
let name = $state("My library");
let otc = $state("");
const disabled = $derived(busy || pairingState.active);
</script>
<section class="panel stack">
	<h2>Your encrypted library</h2>
	<p>Files are encrypted in your browser before upload.</p>
	<fieldset class="choices" aria-label="Setup method">
		<button
			type="button"
			class="secondary"
			aria-pressed={mode === "create"}
			{disabled}
			onclick={() => (mode = "create")}
		>
			Create
		</button>
		<button
			type="button"
			class="secondary"
			aria-pressed={mode === "restore"}
			{disabled}
			onclick={() => (mode = "restore")}
		>
			Restore
		</button>
		<button
			type="button"
			class="secondary"
			aria-pressed={mode === "pair"}
			{disabled}
			onclick={() => (mode = "pair")}
		>
			Pair device
		</button>
	</fieldset>
	{#if mode === "create" || mode === "pair"}
		<details>
			<summary>Server configuration</summary>
			<label class="field server"
				>Server<input type="url" required bind:value={server} {disabled}></label
			>
		</details>
	{/if}
	{#if mode === "create"}
		<form
			class="stack"
			onsubmit={(event) => {
				event.preventDefault();
				oncreate({ serverUrl: server.trim(), name, otc });
			}}
		>
			<label class="field"
				>Library name<input
					required
					maxlength="80"
					bind:value={name}
					{disabled}
				></label
			>
			<label class="field"
				>Invitation code<input
					required
					autocomplete="off"
					bind:value={otc}
					{disabled}
				></label
			>
			<button type="submit" {disabled}>Create library</button>
			{#if error}
				<p class="error" role="alert">{error}</p>
			{/if}
		</form>
	{:else if mode === "restore"}
		<RecoveryImport busy={disabled} {error} {onrestore} />
	{:else}
		<Pairing
			state={pairingState}
			{server}
			{busy}
			embedded
			onReceive={onreceive}
			onApprove={onapprove}
			onRejectVerification={onreject}
			onCancel={oncancel}
		/>
	{/if}
</section>
<style>
.choices {
	border: 0;
	min-width: 0;
	display: flex;
	flex-wrap: wrap;
	gap: 0.5rem;
}
button[aria-pressed="true"] {
	outline: 2px solid var(--accent);
}
.server {
	margin-top: 1rem;
}
</style>
