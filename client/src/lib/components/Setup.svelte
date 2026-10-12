<script>
import RecoveryImport from "./RecoveryImport.svelte";
import Pairing from "./Pairing.svelte";
import { selectTab } from "../stores/dom.js";
let {
	session,
	settings,
	pairing,
	vault,
	onRestore,
	additional = false,
} = $props();
const mode = $derived($pairing.active ? "pair" : $settings.mode);
const authorizer = $derived(
	$session.catalog?.find((row) => row.id === $settings.authorizerLibraryId),
);
const blocked = $derived(
	$session.busy || $pairing.active || Boolean($session.pendingRegistration),
);
</script>

{#snippet notice(
	scope,
)}
	{#if $settings.feedback.scope === scope && $settings.feedback.text}
		<p
			id="status"
			role={$settings.feedback.error ? "alert" : "status"}
			class:error={$settings.feedback.error}
		>
			{$settings.feedback.text}
		</p>
	{/if}
{/snippet}
{#snippet registration(
	method,
)}
	<form
		class="stack"
		id={method === "create" ? "create" : "authorize-create"}
		onsubmit={(event) => {
			event.preventDefault();
			settings.create();
		}}
	>
		{#if $session.pendingRegistration}
			<p id="pending-creation">
				Your encrypted identity is saved. Retry registration with your chosen
				registration method. You can close this page and return later.
			</p>
		{/if}
		{#if method === "create"}
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
		<button
			id={method === "create" ? "create-library" : "authorize-library"}
			type="submit"
			disabled={$session.busy ||
				(method === "authorize" && !authorizer?.unlocked)}
		>
			{$session.pendingRegistration ? "Retry registration" : "Create library"}
		</button>
		{#if mode === method}
			{@render notice("create")}
		{/if}
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
{/snippet}
<div class="stack">
	{#if additional}
		{@render notice("setup")}
	{/if}
	{#if mode !== "restore"}
		<div class="field">
			<label for={additional ? "new-library-name" : "library-name"}
				>Library name</label
			>
			<input
				id={additional ? "new-library-name" : "library-name"}
				required
				maxlength="80"
				bind:value={
					() => $settings.libraryName,
					(value) => settings.edit("libraryName", value)
				}
				disabled={blocked}
			>
		</div>
	{/if}
	<div
		class="setup-tabs"
		role="tablist"
		tabindex="-1"
		aria-label="Library setup"
		onkeydown={(event) => {
			if (!blocked)
				selectTab(event, mode, (next) => settings.edit("mode", next), [
					"create",
					"authorize",
					"pair",
					"restore",
				]);
		}}
	>
		{#each [
			["create", "OTC"],
			["authorize", "Authorize"],
			["pair", "Pair"],
			["restore", "Restore"],
		] as [key, label]}
			<button
				id={`${key}-tab`}
				type="button"
				role="tab"
				aria-selected={mode === key}
				tabindex={mode === key ? 0 : -1}
				aria-controls={`${key}-panel`}
				disabled={blocked}
				onclick={() => settings.edit("mode", key)}
			>
				{label}
			</button>
		{/each}
	</div>
	<div
		id="create-panel"
		role="tabpanel"
		aria-labelledby="create-tab"
		hidden={mode !== "create"}
	>
		<p>Create a new library with a one-time invitation code.</p>
		<div class="field">
			<label for={additional ? "setup-server" : "server"}>Server</label>
			<input
				id={additional ? "setup-server" : "server"}
				type="url"
				required
				bind:value={
					() => $settings.server,
					(value) => settings.edit("server", value)
				}
				disabled={blocked}
			>
		</div>
		{@render registration("create")}
	</div>
	<div
		id="authorize-panel"
		role="tabpanel"
		aria-labelledby="authorize-tab"
		hidden={mode !== "authorize"}
	>
		<p>Create an independent library using an existing registered library.</p>
		{#if !$session.catalog?.length}
			<p>
				Create your first library using an invitation code, pair from another
				device, or restore a recovery file.
			</p>
		{:else}
			{#if $session.catalog.length === 1 && authorizer}
				<p>Authorizing library: {authorizer.name}</p>
			{:else}
				<div class="field">
					<label for="authorizer">Authorizing library</label>
					<select
						id="authorizer"
						bind:value={
							() => $settings.authorizerLibraryId,
							(value) => settings.edit("authorizerLibraryId", value)
						}
						disabled={blocked}
					>
						{#each $session.catalog as row}
							<option value={row.id}>{row.name} — {row.serverUrl}</option>
						{/each}
					</select>
				</div>
			{/if}
			{#if authorizer}
				<p class="address">Server: {authorizer.serverUrl}</p>
				{@render registration("authorize")}
			{/if}
		{/if}
	</div>
	<div
		id="pair-panel"
		role="tabpanel"
		aria-labelledby="pair-tab"
		hidden={mode !== "pair"}
	>
		<div class="field">
			<label for="pair-server">Pairing server</label>
			<input
				id="pair-server"
				type="url"
				required
				bind:value={
					() => $settings.pairServer || $settings.server,
					(value) => settings.edit("pairServer", value)
				}
				disabled={blocked}
			>
		</div>
		<Pairing
			{session}
			{pairing}
			server={$settings.pairServer || $settings.server}
			embedded
		/>
	</div>
	<div
		id="restore-panel"
		role="tabpanel"
		aria-labelledby="restore-tab"
		hidden={mode !== "restore"}
	>
		<RecoveryImport {vault} onComplete={onRestore} />
	</div>
</div>
<style>
.setup-tabs {
	display: flex;
	flex-wrap: wrap;
	border-bottom: 1px solid var(--line);
	gap: 0.25rem;
}
.setup-tabs button {
	background: transparent;
	color: var(--muted);
	border: 0;
	border-bottom: 2px solid transparent;
	border-radius: 0;
	padding: 0.5rem;
}
.setup-tabs button[aria-selected="true"] {
	color: var(--accent);
	border-bottom-color: var(--accent);
	font-weight: 600;
}
[role="tabpanel"] {
	display: grid;
	gap: 1rem;
}
[role="tabpanel"][hidden] {
	display: none;
}
.address {
	overflow-wrap: anywhere;
}
</style>
