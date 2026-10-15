<script>
import { onDestroy } from "svelte";
import { createExtensionReceiver } from "../stores/extension.js";
import { createLibrary } from "../stores/library.js";
import { createPairing } from "../stores/pairing.js";
import { createPreferences } from "../stores/preferences.js";
import { createSession } from "../stores/session.js";
import { createUploads } from "../stores/uploads.js";
import Library from "./Library.svelte";
import Settings from "./Settings.svelte";
import Unlock from "./Unlock.svelte";

const session = createSession();
const library = createLibrary(session);
const preferences = createPreferences();
const uploads = createUploads(session, {
	onComplete: library.refresh,
	preferences,
});
const pairing = createPairing(session);
function pageAtLocation() {
	return new URLSearchParams(location.search).get("page") === "settings"
		? "settings"
		: "library";
}
let page = $state(pageAtLocation());
const extension = createExtensionReceiver(session, uploads, () => {
	page = "library";
	history.replaceState({}, "", "?page=library");
});
function navigate(event, name) {
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
	uploads.dispose();
	library.dispose();
	session.dispose();
});
</script>

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
			<button type="button" class="secondary lock" onclick={session.lock}>
				Lock
			</button>
		</header>
		{#if page === "settings"}
			<Settings {session} {pairing} {uploads} {preferences} />
		{:else}
			<Library
				{session}
				{library}
				{uploads}
				onsettings={(event) => navigate(event, "settings")}
			/>
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
	grid-template-columns: auto 1fr auto;
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
		grid-template-columns: 1fr auto;
		gap: 0.5rem;
		margin-bottom: 1.5rem;
	}
	nav {
		grid-column: 1 / -1;
		grid-row: 2;
		justify-self: start;
		gap: 1.5rem;
	}
	.lock {
		grid-column: 2;
		grid-row: 1;
		min-height: 3rem;
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
