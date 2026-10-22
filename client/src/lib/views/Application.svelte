<script lang="ts">
import { onDestroy } from "svelte";
import { routeHref } from "../routes.ts";
import { createApplication } from "../stores/application.ts";
import History from "./History.svelte";
import Library from "./Library.svelte";
import Media from "./Media.svelte";
import Settings from "./Settings.svelte";
import Setup from "./Setup.svelte";
import Unlock from "./Unlock.svelte";

const application = createApplication();
const { session, preferences, pairing, routing } = application;
const workspace = $derived($application.workspace);
// The file viewer places Lock in its own header row instead of a separate one.
const viewing = $derived(
	$routing.page === "media" &&
		/^[0-9a-f]{64}$/.test($routing.id) &&
		$session.status === "unlocked" &&
		Boolean($session.context) &&
		Boolean(workspace),
);
onDestroy(application.dispose);
application.start();
function dragFiles(event: DragEvent) {
	if (!event.dataTransfer?.types.includes("Files")) {
		return;
	}
	event.preventDefault();
	event.dataTransfer.dropEffect = application.canDropFiles() ? "copy" : "none";
}
function dropFiles(event: DragEvent) {
	if (!event.dataTransfer?.types.includes("Files")) {
		return;
	}
	event.preventDefault();
	application.dropFiles(Array.from(event.dataTransfer.files));
}
function pasteFiles(event: ClipboardEvent) {
	const target = event.target;
	if (
		target instanceof HTMLElement &&
		(target.closest("input, textarea, select") || target.isContentEditable)
	) {
		return;
	}
	const files = Array.from(event.clipboardData?.files ?? []);
	if (files.length && application.canDropFiles()) {
		event.preventDefault();
		application.dropFiles(files);
	}
}
</script>

<svelte:window ondragover={dragFiles} ondrop={dropFiles} onpaste={pasteFiles} />

{#snippet lock()}
	<button
		type="button"
		class="secondary icon lock-control"
		aria-label="Lock"
		title="Lock"
		onclick={() => session.lock()}
	>
		<svg
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="2"
			stroke-linecap="round"
			stroke-linejoin="round"
			aria-hidden="true"
		>
			<rect x="5" y="10" width="14" height="11" rx="2" />
			<path d="M8 10V7a4 4 0 0 1 8 0v3" />
		</svg>
	</button>
{/snippet}

<main class:media={$routing.page === "media" && Boolean($session.context)}>
	{#if $session.unlocked}
		{#if !viewing}
			<header class:media-header={$routing.page === "media"}>
				{#if $routing.page !== "media"}
					<nav aria-label="Main navigation">
						<a
							href={routeHref({ page: "library" })}
							aria-current={$routing.page === "library" ? "page" : undefined}
							>Library</a
						>
						<a
							href={routeHref({ page: "history" })}
							aria-current={$routing.page === "history" ? "page" : undefined}
							>History</a
						>
						<a
							href={routeHref({ page: "settings" })}
							aria-current={$routing.page === "settings" ? "page" : undefined}
							>Settings</a
						>
					</nav>
				{/if}
				{@render lock()}
			</header>
		{/if}
		{#if $session.notice && $routing.page !== "settings"}
			<p class="error session-notice" role="alert">{$session.notice}</p>
		{/if}
	{/if}
	{#if $routing.page === "media" && !/^[0-9a-f]{64}$/.test($routing.id)}
		<section class="panel stack">
			<p class="error" role="alert">Invalid media link.</p>
			<a href={routeHref({ page: "library" })}>Library</a>
		</section>
	{:else if $session.status !== "unlocked"}
		<Unlock {session} />
	{:else if $routing.page === "media"}
		{#if $session.context}
			{#if workspace}
				<Media id={$routing.id} library={workspace.library} actions={lock} />
			{:else}
				<p role="status">Loading library…</p>
			{/if}
		{:else}
			<p>Connect the library that contains this file to open it.</p>
			<Setup {session} {pairing} />
		{/if}
	{:else}
		{#if $routing.page === "settings"}
			<Settings
				{session}
				{pairing}
				quota={workspace?.quota ?? null}
				uploads={workspace?.uploads ?? null}
				{preferences}
			/>
		{:else if $routing.page === "history" && workspace}
			<History
				history={workspace.history}
				view={workspace.view}
				onview={async (sequence) => {
					if (await workspace.view.select(sequence)) {
						routing.navigate({ page: "library" });
					}
				}}
			/>
		{:else if $session.configured && $preferences.loading}
			<p role="status">Loading library…</p>
		{:else if workspace}
			<Library
				library={workspace.library}
				uploads={workspace.uploads}
				view={workspace.view}
			/>
		{:else}
			<Setup {session} {pairing} />
		{/if}
	{/if}
</main>
<style>
.lock-control {
	grid-column: 3;
	justify-self: end;
}
.lock-control svg {
	width: 1.25rem;
	height: 1.25rem;
}
.session-notice {
	margin-bottom: var(--space-4);
}
main {
	max-width: 76rem;
	padding: var(--space-6);
	margin: auto;
}
main.media {
	max-width: none;
	padding: var(--space-4);
}
header {
	display: grid;
	grid-template-columns: minmax(var(--touch), 1fr) auto minmax(
			var(--touch),
			1fr
		);
	align-items: center;
	gap: var(--space-2);
	margin-bottom: var(--space-8);
}
header.media-header {
	margin-bottom: var(--space-4);
}
nav {
	grid-column: 2;
	display: flex;
	align-items: center;
	flex-wrap: wrap;
	gap: var(--space-4);
}
nav a {
	display: inline-flex;
	align-items: center;
	min-height: var(--target);
	color: var(--muted);
	text-decoration: none;
}
nav a[aria-current] {
	color: var(--accent);
	font-weight: 600;
}
@media (max-width: 32rem) {
	header {
		margin-bottom: var(--space-6);
	}
	nav {
		justify-content: center;
		gap: var(--space-6);
	}
	main {
		padding: var(--space-4);
	}
}
</style>
