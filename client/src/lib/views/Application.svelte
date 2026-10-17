<script lang="ts">
import { onDestroy, untrack } from "svelte";
import { get } from "svelte/store";
import { createExtensionReceiver } from "../stores/extension.ts";
import { createPairing } from "../stores/pairing.ts";
import { createPreferences } from "../stores/preferences.ts";
import { createSession } from "../stores/session.ts";
import { createWorkspace, type Workspace } from "../stores/workspace.ts";
import Library from "./Library.svelte";
import Settings from "./Settings.svelte";
import Unlock from "./Unlock.svelte";

const session = createSession();
const preferences = createPreferences();
let workspace = $state<Workspace | null>(null);
const stopSession = session.subscribe((value) =>
	untrack(() => {
		if (workspace?.context === value.context) {
			return;
		}
		workspace?.dispose();
		workspace = value.context
			? createWorkspace(value.context, preferences)
			: null;
	}),
);
const pairing = createPairing(session);
function pageAtLocation() {
	return new URLSearchParams(location.search).get("page") === "settings"
		? "settings"
		: "library";
}
let page = $state(pageAtLocation());
const extension = createExtensionReceiver(
	session,
	() => workspace?.uploads ?? null,
	() => {
		page = "library";
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
	page = "library";
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
	page = name;
	history.pushState({}, "", `?page=${name}`);
}
const popstate = () => {
	page = pageAtLocation();
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

<main>
	{#if $session.status !== "unlocked"}
		<Unlock {session} />
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
					aria-current={page === "library" ? "page" : undefined}
					onclick={(event) => navigate(event, "library")}
					>Library</a
				>
				<a
					href="?page=settings"
					aria-current={page === "settings" ? "page" : undefined}
					onclick={(event) => navigate(event, "settings")}
					>Settings</a
				>
			</nav>
		</header>
		{#if page === "settings"}
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
