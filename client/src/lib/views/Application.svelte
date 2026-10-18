<script lang="ts">
import { onDestroy } from "svelte";
import { createApplication } from "../stores/application.ts";
import { routeHref } from "../stores/routing.ts";
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
function navigate(event: MouseEvent, name: "library" | "settings") {
	if (
		event.button !== 0 ||
		event.metaKey ||
		event.ctrlKey ||
		event.shiftKey ||
		event.altKey
	) {
		return;
	}
	event.preventDefault();
	routing.navigate({ page: name });
}
</script>

<svelte:window ondragover={dragFiles} ondrop={dropFiles} />

<main class:media={$routing.page === "media" && Boolean($session.context)}>
	{#if $routing.page === "media" && !/^[0-9a-f]{64}$/.test($routing.id)}
		<section class="panel stack">
			<p class="error" role="alert">Invalid media link.</p>
			<a
				href={routeHref({ page: "library" })}
				onclick={(event) => navigate(event, "library")}
				>Library</a
			>
		</section>
	{:else if $session.status !== "unlocked"}
		<Unlock {session} />
	{:else if $routing.page === "media"}
		{#if $session.context}
			<Media
				id={$routing.id}
				context={$session.context}
				onlibrary={(event) => navigate(event, "library")}
			/>
		{:else}
			<p>Connect the library that contains this file to open it.</p>
			<Setup {session} {pairing} />
		{/if}
	{:else}
		<header>
			<a
				class="brand"
				href={routeHref({ page: "library" })}
				onclick={(event) => navigate(event, "library")}
				>i2nclip</a
			>
			<nav aria-label="Main navigation">
				<a
					href={routeHref({ page: "library" })}
					aria-current={$routing.page === "library" ? "page" : undefined}
					onclick={(event) => navigate(event, "library")}
					>Library</a
				>
				<a
					href={routeHref({ page: "settings" })}
					aria-current={$routing.page === "settings" ? "page" : undefined}
					onclick={(event) => navigate(event, "settings")}
					>Settings</a
				>
			</nav>
		</header>
		{#if $routing.page === "settings"}
			<Settings {session} {pairing} {workspace} {preferences} />
		{:else if workspace}
			<Library
				{session}
				library={workspace.library}
				tags={workspace.tags}
				uploads={workspace.uploads}
				onsettings={(event) => navigate(event, "settings")}
			/>
		{:else}
			<section class="panel empty stack">
				<h2>Your library starts here</h2>
				<p>
					<a
						href={routeHref({ page: "settings" })}
						onclick={(event) => navigate(event, "settings")}
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
