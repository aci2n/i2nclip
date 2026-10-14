<script>
import { onDestroy } from "svelte";
import AboutDialog from "../components/AboutDialog.svelte";
import { createExtensionReceiver } from "../stores/extension.js";
import { createLibrary } from "../stores/library.js";
import { createPairing } from "../stores/pairing.js";
import { createSession } from "../stores/session.js";
import Library from "./Library.svelte";
import Settings from "./Settings.svelte";
import Unlock from "./Unlock.svelte";

const session = createSession();
const library = createLibrary(session);
const pairing = createPairing(session);
function pageAtLocation() {
	return new URLSearchParams(location.search).get("page") === "settings"
		? "settings"
		: "library";
}
let page = $state(pageAtLocation());
let about = $state(false);
const extension = createExtensionReceiver(session, library, () => {
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
				<button type="button" onclick={session.lock}>Lock</button>
				<button type="button" onclick={() => (about = true)}>About</button>
			</nav>
		</header>
		{#if page === "settings"}
			<Settings {session} {pairing} />
		{:else}
			<Library
				{session}
				{library}
				onsettings={(event) => navigate(event, "settings")}
			/>
		{/if}
	{/if}
</main>
<AboutDialog
	open={about && $session.unlocked}
	onclose={() => (about = false)}
/>

<style>
main {
	max-width: 76rem;
	padding: 1.5rem;
	margin: auto;
}
header {
	display: flex;
	justify-content: space-between;
	align-items: center;
	gap: 1rem;
	flex-wrap: wrap;
	margin-bottom: 2rem;
}
.brand {
	font-size: 1.35rem;
	font-weight: 700;
	text-decoration: none;
	color: inherit;
}
nav {
	display: flex;
	align-items: center;
	flex-wrap: wrap;
	gap: 1rem;
}
nav a,
nav button {
	color: var(--muted);
	text-decoration: none;
}
nav button {
	padding: 0;
	border: 0;
	border-radius: 0;
	background: transparent;
}
nav a[aria-current] {
	color: var(--accent);
	font-weight: 600;
}
@media (max-width: 32rem) {
	main {
		padding: 1rem;
	}
}
</style>
