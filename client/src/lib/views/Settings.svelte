<script>
import { onMount } from "svelte";
import Pairing from "../components/Pairing.svelte";
import Setup from "../components/Setup.svelte";
import VaultSettings from "../components/VaultSettings.svelte";

let {
	session,
	settings,
	pairing,
	management,
	setup,
	vault,
	onRestore,
	forget,
	onForget,
} = $props();
onMount(() => {
	if (!$session.configured) {
		setup.start();
	}
});
const setupSession = $derived(setup.session);
const setupPairing = $derived(setup.pairing);
const feedback = $derived($settings.feedback);
const feedbackAt = $derived(
	$session.configured && ["create", "restore"].includes(feedback.scope)
		? "library"
		: feedback.scope,
);
</script>

{#snippet notice(
	scope,
)}
	{#if feedbackAt === scope && feedback.text}
		<p
			id="status"
			class="feedback"
			class:error={feedback.error}
			role={feedback.error ? "alert" : "status"}
		>
			{feedback.text}
		</p>
	{/if}
{/snippet}

<div id="settings" class="settings">
	{#if !$session.configured}
		<section class="panel stack">
			<h2>Your encrypted library</h2>
			<p>Files are encrypted in your browser before upload.</p>
			{@render notice("setup")}
			<Setup
				session={setup.session}
				settings={setup.settings}
				pairingState={$setupPairing}
				pairingBusy={$setupSession.busy}
				onReceive={setup.pairing.receive}
				onApprove={setup.pairing.approve}
				onRejectVerification={setup.pairing.rejectVerification}
				onCancel={setup.pairing.cancel}
				{vault}
				{onRestore}
			/>
		</section>
	{:else}
		<section id="configured" class="panel stack">
			<h2>Your library</h2>
			<p class="server-address">
				{$session.libraryName}
				· {$session.serverUrl}
			</p>
			<p>
				Keep recovery files and their recovery passwords safe. Your master
				password protects this client.
			</p>
			{@render notice("library")}
			{@render notice("backup")}
		</section>
	{/if}
	{#if $session.configured}
		<Pairing
			state={$pairing}
			configured={$session.configured}
			busy={$session.busy}
			onSend={pairing.send}
			onReceive={pairing.receive}
			onApprove={pairing.approve}
			onRejectVerification={pairing.rejectVerification}
			onCancel={pairing.cancel}
			server={$session.serverUrl}
		/>
		{@render management?.()}
	{/if}

	{#if $session.configured && $session.catalog.length}
		<details id="add-library-settings" class="panel" open={$setup.open}>
			<!-- biome-ignore lint/a11y/noStaticElementInteractions: summary is a native keyboard-operable disclosure control. -->
			<summary
				onclick={(event) => {
					event.preventDefault();
					if ($setup.open) {
						setup.close();
					} else {
						setup.start();
					}
				}}
			>
				Add library
			</summary>
			<div class="stack disclosure-body">
				<Setup
					session={setup.session}
					settings={setup.settings}
					pairingState={$setupPairing}
					pairingBusy={$setupSession.busy}
					onReceive={setup.pairing.receive}
					onApprove={setup.pairing.approve}
					onRejectVerification={setup.pairing.rejectVerification}
					onCancel={setup.pairing.cancel}
					{vault}
					{onRestore}
					additional
				/>
			</div>
		</details>
	{/if}
	<VaultSettings {vault} />
	{#if $session.configured}
		<details class="panel">
			<summary class="danger">Forget library</summary>
			<div class="stack disclosure-body">
				<p>Keep a recovery file first. Uploads on the server stay saved.</p>
				<button
					id="forget-library"
					type="button"
					class="secondary danger"
					disabled={$session.busy || $forget.busy}
					onclick={onForget}
				>
					Forget this library
				</button>
				{#if $forget.error}
					<p role="alert" class="error">{$forget.error}</p>
				{/if}
			</div>
		</details>
	{/if}
	<details id="reset-settings" class="panel">
		<summary class="danger">Reset browser</summary>
		<div class="stack disclosure-body">
			<p>Keep a recovery file first. Uploads on the server stay saved.</p>
			<button
				id="reset"
				type="button"
				class="secondary danger"
				disabled={$session.busy}
				onclick={vault.reset}
			>
				Reset everything
			</button>
			{@render notice("reset")}
		</div>
	</details>
	{#if $session.error && !feedback.text}
		<p class="feedback error" role="alert">{$session.error}</p>
	{/if}
</div>

<style>
.danger {
	color: var(--error);
}
.settings {
	max-width: 42rem;
	display: grid;
	gap: 1rem;
	margin: auto;
}
.disclosure-body {
	margin-top: 1rem;
}
.server-address {
	overflow-wrap: anywhere;
}
</style>
