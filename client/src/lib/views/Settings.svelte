<script>
import Pairing from "../components/Pairing.svelte";
import { selectTab, validateInput } from "../stores/dom.js";

let { session, settings, pairing, management } = $props();
let serverInput = $state();
let serverDetails = $state();
const savedServer = $derived($session.serverUrl);
const mode = $derived($settings.mode);
const feedback = $derived($settings.feedback);
const feedbackAt = $derived(
	$session.configured && ["create", "restore"].includes(feedback.scope)
		? "library"
		: feedback.scope === "reset" && !$session.configured
			? "setup"
			: feedback.scope,
);
function navigateTabs(event) {
	if (!$session.busy && !$session.pendingRegistration)
		selectTab(event, mode, (next) => settings.edit("mode", next));
}
function create(event) {
	event.preventDefault();
	if (!validateInput(serverInput, serverDetails)) return;
	settings.create();
}
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

<div id="settings" class="settings">
	{#if !$session.configured}
		<section class="panel">
			<h2>Your encrypted library</h2>
			<p>Files are encrypted in your browser before upload.</p>
			{@render notice("setup")}
			<div
				class="setup-tabs"
				role="tablist"
				tabindex="-1"
				aria-label="Library setup"
				onkeydown={navigateTabs}
			>
				<button
					id="create-tab"
					type="button"
					role="tab"
					aria-selected={mode === "create"}
					tabindex={mode === "create" ? 0 : -1}
					aria-controls="create-panel"
					disabled={$session.busy}
					onclick={() => {
						settings.edit("mode", "create");
					}}
				>
					Create
				</button>
				<button
					id="restore-tab"
					type="button"
					role="tab"
					aria-selected={mode === "restore"}
					tabindex={mode === "restore" ? 0 : -1}
					aria-controls="restore-panel"
					disabled={$session.busy || Boolean($session.pendingRegistration)}
					onclick={() => {
						settings.edit("mode", "restore");
					}}
				>
					Restore
				</button>
			</div>
			<div
				id="create-panel"
				role="tabpanel"
				aria-labelledby="create-tab"
				hidden={mode !== "create"}
			>
				<form class="stack" id="create" onsubmit={create}>
					{#if $session.pendingRegistration}
						<p id="pending-creation">
							Your encrypted identity is saved. Retry registration with the
							original password and invitation code. You can close this page and
							return later.
						</p>
					{/if}
					<div class="field">
						<label for="authorizer">Register using</label>
						<select
							id="authorizer"
							bind:value={
								() => $settings.authorizerLibraryId,
								(value) => settings.edit("authorizerLibraryId", value)
							}
							disabled={$session.busy}
						>
							<option value="">Invitation code</option>
							{#each $session.catalog.filter(
								(row) => row.id !== $session.libraryId && row.unlocked,
							) as row}
								<option value={row.id}>{row.name}</option>
							{/each}
						</select>
					</div>
					{#if !$settings.authorizerLibraryId}
						<div class="field">
							<label for="otc">Invitation code</label>
							<input
								id="otc"
								type="text"
								required
								autocomplete="off"
								spellcheck="false"
								bind:value={
									() => $settings.otc,
									(value) => settings.edit("otc", value)
								}
								disabled={$session.busy}
							>
						</div>
					{/if}
					<div class="field">
						<label for="pass">Unlock password</label>
						<input
							id="pass"
							aria-describedby="create-password-hint"
							type="password"
							required
							minlength="8"
							autocomplete="new-password"
							bind:value={
								() => $settings.password,
								(value) => settings.edit("password", value)
							}
							disabled={$session.busy}
						>
						<p id="create-password-hint">
							Use at least 8 characters. Your password is never stored or sent
							to the server.
						</p>
					</div>
					<button id="create-library" type="submit" disabled={$session.busy}>
						{$session.pendingRegistration
							? "Retry registration"
							: "Create library"}
					</button>
					{@render notice("create")}
					{#if $session.pendingRegistration}
						<button
							id="discard-creation"
							type="button"
							class="secondary danger"
							disabled={$session.busy}
							onclick={settings.discardCreation}
						>
							Discard pending creation
						</button>
					{/if}
				</form>
			</div>
			<div
				id="restore-panel"
				role="tabpanel"
				aria-labelledby="restore-tab"
				hidden={mode !== "restore"}
			>
				<form
					class="stack"
					id="restore-settings"
					onsubmit={(event) => {
						event.preventDefault();
						settings.restore();
					}}
				>
					<p>Choose your recovery file and enter its password.</p>
					<div class="field">
						<label for="file">Recovery file</label>
						<input
							id="file"
							type="file"
							required
							accept=".json,application/json"
							bind:files={
								() => $settings.recoveryFiles,
								(value) => settings.edit("recoveryFiles", value)
							}
							disabled={$session.busy}
						>
					</div>
					<div class="field">
						<label for="restore-pass">Recovery password</label>
						<input
							id="restore-pass"
							type="password"
							required
							autocomplete="current-password"
							bind:value={
								() => $settings.restorePassword,
								(value) => settings.edit("restorePassword", value)
							}
							disabled={$session.busy}
						>
					</div>
					<button id="restore" type="submit" disabled={$session.busy}>
						Restore library
					</button>
					{@render notice("restore")}
				</form>
			</div>
		</section>
	{:else}
		<section id="configured" class="panel stack">
			<h2>Your library</h2>
			<p>
				Keep a recovery file and remember your password. You need both to
				restore your library.
			</p>
			<button
				id="backup"
				type="button"
				disabled={$session.busy}
				onclick={settings.backup}
			>
				Download recovery file
			</button>
			{@render notice("library")}
			{@render notice("backup")}
		</section>
		<details id="reset-settings" class="panel">
			<summary>Reset this browser</summary>
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
	{/if}
	{@render management?.()}
	<Pairing {session} {pairing} server={$settings.server} />
	<details id="server-details" class="panel" bind:this={serverDetails}>
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
	{#if $session.error && !feedback.text}
		<p class="feedback error" role="alert">{$session.error}</p>
	{/if}
</div>

<style>
.settings {
	max-width: 42rem;
	display: grid;
	gap: 1rem;
	margin: auto;
}
.setup-tabs {
	display: flex;
	border-bottom: 1px solid var(--line);
	margin: 1rem 0;
}
.setup-tabs button {
	background: transparent;
	color: var(--muted);
	border: 0;
	border-bottom: 2px solid transparent;
	border-radius: 0;
	padding: 0.5rem 1rem;
	margin-bottom: -1px;
}
.setup-tabs button[aria-selected="true"] {
	color: var(--accent);
	border-bottom-color: var(--accent);
	font-weight: 600;
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
