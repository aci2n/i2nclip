<script lang="ts">
import { onDestroy, untrack } from "svelte";
import { get } from "svelte/store";
import { createExtensionReceiver } from "../stores/extension.ts";
import { createPairing } from "../stores/pairing.ts";
import { createPreferences } from "../stores/preferences.ts";
import { createSession } from "../stores/session.ts";
import { createWorkspace, type Workspace } from "../stores/workspace.ts";
import Library from "./Library.svelte";
import Media from "./Media.svelte";
import Settings from "./Settings.svelte";
import Setup from "./Setup.svelte";
import Unlock from "./Unlock.svelte";

const session = createSession();
const preferences = createPreferences();
let workspace = $state<Workspace | null>(null);
function pageAtLocation() {
	const params = new URLSearchParams(location.search);
	const name = params.get("page");
	return {
		page:
			name === "media" ? "media" : name === "settings" ? "settings" : "library",
		id: params.get("id") || "",
	};
}
let route = $state(pageAtLocation());
function syncWorkspace(context = get(session).context) {
	if (workspace && workspace.context !== context) {
		workspace.dispose();
		workspace = null;
	}
	if (context && route.page !== "media" && !workspace) {
		workspace = createWorkspace(context, preferences);
	}
}
const stopSession = session.subscribe((value) =>
	untrack(() => syncWorkspace(value.context)),
);
const pairing = createPairing(session);
const extension = createExtensionReceiver(
	session,
	() => workspace?.uploads ?? null,
	() => {
		route = { page: "library", id: "" };
		syncWorkspace();
		history.replaceState({}, "", "?page=library");
	},
);
function dragFiles(event: DragEvent) {
	if (!event.dataTransfer?.types.includes("Files")) {
		return;
	}
	event.preventDefault();
	event.dataTransfer.dropEffect =
		session.ready && workspace && !get(workspace.uploads).uploading
			? "copy"
			: "none";
}
function dropFiles(event: DragEvent) {
	if (!event.dataTransfer?.types.includes("Files")) {
		return;
	}
	event.preventDefault();
	const files = Array.from(event.dataTransfer.files);
	if (
		!files.length ||
		!session.ready ||
		!workspace ||
		get(workspace.uploads).uploading
	) {
		return;
	}
	route = { page: "library", id: "" };
	syncWorkspace();
	history.replaceState({}, "", "?page=library");
	void workspace.uploads.upload(files);
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
	route = { page: name, id: "" };
	syncWorkspace();
	history.pushState({}, "", `?page=${name}`);
}
const popstate = () => {
	route = pageAtLocation();
	syncWorkspace();
};
window.addEventListener("popstate", popstate);
onDestroy(() => {
	window.removeEventListener("popstate", popstate);
	extension.dispose();
	pairing.dispose();
	stopSession();
	workspace?.dispose();
	session.dispose();
});
</script>

<svelte:window ondragover={dragFiles} ondrop={dropFiles} />

<main class:media={route.page === "media" && Boolean($session.context)}>
	{#if route.page === "media" && !/^[0-9a-f]{64}$/.test(route.id)}
		<section class="panel stack">
			<p class="error" role="alert">Invalid media link.</p>
			<a href="?page=library" onclick={(event) => navigate(event, "library")}
				>Library</a
			>
		</section>
	{:else if $session.status !== "unlocked"}
		<Unlock {session} />
	{:else if route.page === "media"}
		{#if $session.context}
			<Media
				id={route.id}
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
				href="?page=library"
				onclick={(event) => navigate(event, "library")}
				>i2nclip</a
			>
			<nav aria-label="Main navigation">
				<a
					href="?page=library"
					aria-current={route.page === "library" ? "page" : undefined}
					onclick={(event) => navigate(event, "library")}
					>Library</a
				>
				<a
					href="?page=settings"
					aria-current={route.page === "settings" ? "page" : undefined}
					onclick={(event) => navigate(event, "settings")}
					>Settings</a
				>
			</nav>
		</header>
		{#if route.page === "settings"}
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
						href="?page=settings"
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
