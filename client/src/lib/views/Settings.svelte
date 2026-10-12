<script>
import Unlock from "../components/Unlock.svelte";
import Setup from "../components/Setup.svelte";
import Pairing from "../components/Pairing.svelte";

let { session, settings, pairing, management, setup } = $props();
let serverInput = $state();
let serverDetails = $state();
const savedServer = $derived($session.serverUrl);
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
	{#if feedbackAt === scope}
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

{#snippet serverControls()}
	<details id="server-details" class="server-details" bind:this={serverDetails}>
		<summary>
			Server settings <span class="server-address">{savedServer}</span>
		</summary>
		<form
			class="stack server-form"
			id="server-settings"
			onsubmit={(event) => {
				event.preventDefault();
				settings.setServer();
			}}
		>
			<div class="field">
				<label for="server">Server URL</label>
				<div class="bar server-bar">
					<input
						id="server"
						bind:this={serverInput}
						type="url"
						required
						bind:value={
							() => $settings.server,
							(value) => settings.edit("server", value)
						}
						disabled={$session.busy || Boolean($session.pendingRegistration)}
					>
					<button
						id="save-server"
						type="submit"
						disabled={$session.busy || Boolean($session.pendingRegistration)}
					>
						Update URL
					</button>
				</div>
			</div>
			{@render notice("server")}
		</form>
	</details>
{/snippet}

<div id="settings" class="settings">
	{#if !$session.configured}
		<section class="panel stack">
			<h2>Your encrypted library</h2>
			<p>Files are encrypted in your browser before upload.</p>
			{@render notice("setup")}
			<Setup {session} {settings} {pairing} unlockSource={setup.unlockSource} />
		</section>
	{:else}
		<section id="configured" class="panel stack">
			<h2>Your library</h2>
			<p class="server-address">
				{$session.libraryName}
				· {$session.serverUrl}
			</p>
			{#if !$session.unlocked}
				<Unlock
					{session}
					id="library-unlock"
					statusId="library-unlock-status"
				/>
			{/if}
			<p>
				Keep a recovery file and remember your password. You need both to
				restore your library.
			</p>
			<button
				id="backup"
				type="button"
				disabled={$session.busy || !$session.unlocked}
				onclick={settings.backup}
			>
				Download recovery file
			</button>
			{@render notice("library")}
			{@render notice("backup")}
		</section>
	{/if}
	{#if $session.configured}
		<Pairing {session} {pairing} server={$session.serverUrl} />
		{@render management?.(serverControls)}
	{/if}

	{#if $session.catalog.length}
		<details id="add-library-settings" class="panel" open={$setup.open}>
			<!-- biome-ignore lint/a11y/noStaticElementInteractions: summary is a native keyboard-operable disclosure control. -->
			<summary
				onclick={(event) => {
					event.preventDefault();
					if ($setup.open) setup.close();
					else setup.start();
				}}
			>
				Add library
			</summary>
			<div class="stack disclosure-body">
				{#each $setup.resumable as row}
					<button
						type="button"
						class="secondary"
						onclick={() => setup.resume(row.id)}
					>
						Resume setup: {row.name}
					</button>
				{/each}
				<Setup
					session={setup.session}
					settings={setup.settings}
					pairing={setup.pairing}
					unlockSource={setup.unlockSource}
					additional
				/>
				<button type="button" class="secondary" onclick={setup.discard}>
					Cancel setup
				</button>
			</div>
		</details>
	{/if}
	<details id="reset-settings" class="panel">
		<summary class="danger">Reset Browser</summary>
		<div class="stack disclosure-body">
			<p>Keep a recovery file first. Uploads on the server stay saved.</p>
			<button
				id="reset"
				type="button"
				class="secondary danger"
				disabled={$session.busy}
				onclick={settings.reset}
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
.server-form,
.disclosure-body {
	margin-top: 1rem;
}
.server-address {
	overflow-wrap: anywhere;
}
@media (max-width: 32rem) {
	.server-bar {
		flex-wrap: wrap;
	}
	.server-bar input {
		flex-basis: 100%;
	}
}
</style>
