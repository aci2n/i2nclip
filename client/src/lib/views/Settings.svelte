<script>
import { selectTab, validateInput } from "../stores/dom.js";

let { session, settings } = $props();
let serverInput = $state();
let serverDetails = $state();
const savedServer = $derived($session.serverUrl);
const mode = $derived($settings.mode);
const feedback = $derived($settings.feedback);
const feedbackAt = $derived(
	$session.wrappedKey && ["create", "restore"].includes(feedback.scope)
		? "library"
		: feedback.scope === "reset" && !$session.wrappedKey
			? "setup"
			: feedback.scope,
);
function navigateTabs(event) {
	if (!$session.busy)
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
	{#if !$session.wrappedKey}
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
					disabled={$session.busy}
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
				<form id="create" onsubmit={create}>
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
					<label for="pass">Unlock password</label>
					<input
						id="pass"
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
					<p>
						Use at least 8 characters. Your password is never stored or sent to
						the server.
					</p>
					<button id="create-library" type="submit" disabled={$session.busy}>
						Create library
					</button>
					{@render notice("create")}
				</form>
			</div>
			<div
				id="restore-panel"
				role="tabpanel"
				aria-labelledby="restore-tab"
				hidden={mode !== "restore"}
			>
				<form
					id="restore-settings"
					onsubmit={(event) => {
						event.preventDefault();
						settings.restore();
					}}
				>
					<p>Choose your recovery file and enter its password.</p>
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
					<button id="restore" type="submit" disabled={$session.busy}>
						Restore library
					</button>
					{@render notice("restore")}
				</form>
			</div>
		</section>
	{:else}
		<section id="configured" class="panel">
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
		</details>
	{/if}
	<details id="server-details" class="panel" bind:this={serverDetails}>
		<summary>
			Server settings <span class="server-address">{savedServer}</span>
		</summary>
		<form
			id="server-settings"
			onsubmit={(event) => {
				event.preventDefault();
				settings.setServer();
			}}
		>
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
					disabled={$session.busy}
				>
				<button id="save-server" type="submit" disabled={$session.busy}>
					Update URL
				</button>
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
