<script lang="ts">
import { onDestroy } from "svelte";
import { routeHref } from "../routes.ts";
import { createApplication } from "../stores/application.ts";
import Library from "./Library.svelte";
import Media from "./Media.svelte";
import Settings from "./Settings.svelte";
import Setup from "./Setup.svelte";
import Unlock from "./Unlock.svelte";

const application = createApplication();
const { session, preferences, pairing, routing } = application;
const workspace = $derived($application.workspace);
onDestroy(application.dispose);
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
</script>

<svelte:window ondragover={dragFiles} ondrop={dropFiles} />

<main class:media={$routing.page === "media" && Boolean($session.context)}>
	{#if $routing.page === "media" && !/^[0-9a-f]{64}$/.test($routing.id)}
		<section class="panel stack">
			<p class="error" role="alert">Invalid media link.</p>
			<a href={routeHref({ page: "library" })}>Library</a>
		</section>
	{:else if $session.status !== "unlocked"}
		<Unlock {session} />
	{:else if $routing.page === "media"}
		{#if $session.context}
			<Media id={$routing.id} context={$session.context} />
		{:else}
			<p>Connect the library that contains this file to open it.</p>
			<Setup {session} {pairing} />
		{/if}
	{:else}
		<header>
			<a class="brand" href={routeHref({ page: "library" })}>i2nclip</a>
			<nav aria-label="Main navigation">
				<a
					href={routeHref({ page: "library" })}
					aria-current={$routing.page === "library" ? "page" : undefined}
					>Library</a
				>
				<a
					href={routeHref({ page: "settings" })}
					aria-current={$routing.page === "settings" ? "page" : undefined}
					>Settings</a
				>
			</nav>
		</header>
		{#if $routing.page === "settings"}
			<Settings
				{session}
				{pairing}
				quota={workspace?.quota ?? null}
				uploads={workspace?.uploads ?? null}
				{preferences}
			/>
		{:else if workspace}
			<Library
				{session}
				library={workspace.library}
				tags={workspace.tags}
				uploads={workspace.uploads}
			/>
		{:else}
			<section class="panel empty stack">
				<h2>Your library starts here</h2>
				<p>
					<a href={routeHref({ page: "settings" })}
						>Create or restore your library</a
					>
					to start saving encrypted media.
				</p>
			</section>
		{/if}
	{/if}
</main>
<style>
main {
	max-width: 76rem;
	padding: 1.5rem;
	margin: auto;
}
main.media {
	max-width: none;
	padding: 1rem;
}
header {
	display: grid;
	grid-template-columns: auto 1fr;
	align-items: center;
	gap: 1rem;
	margin-bottom: 2rem;
}
.brand {
	font-size: 1.35rem;
	font-weight: 700;
	text-decoration: none;
	color: inherit;
}
nav {
	justify-self: center;
	display: flex;
	align-items: center;
	flex-wrap: wrap;
	gap: 1rem;
}
nav a {
	color: var(--muted);
	text-decoration: none;
}
nav a[aria-current] {
	color: var(--accent);
	font-weight: 600;
}
@media (max-width: 32rem) {
	header {
		grid-template-columns: 1fr;
		gap: 0.5rem;
		margin-bottom: 1.5rem;
	}
	nav {
		grid-column: 1 / -1;
		grid-row: 2;
		justify-self: start;
		gap: 1.5rem;
	}
	nav a {
		display: inline-flex;
		align-items: center;
		min-height: 3rem;
	}
	main {
		padding: 1rem;
	}
}
</style>
