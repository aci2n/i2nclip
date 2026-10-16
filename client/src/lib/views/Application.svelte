<script>
import { onDestroy } from "svelte";
import { createExtensionReceiver } from "../stores/extension.js";
import { createLibrary } from "../stores/library.js";
import { createPairing } from "../stores/pairing.js";
import { createPreferences } from "../stores/preferences.js";
import { createSession } from "../stores/session.js";
import { createTags } from "../stores/tags.js";
import { createUploads } from "../stores/uploads.js";
import Library from "./Library.svelte";
import Settings from "./Settings.svelte";
import Unlock from "./Unlock.svelte";

const session = createSession();
const tags = createTags(session);
const library = createLibrary(session, { onChange: tags.refresh });
const preferences = createPreferences();
const uploads = createUploads(session, {
	onComplete: () => {
		void tags.refresh();
		return library.refresh();
	},
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
	tags.dispose();
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
			<button
				type="button"
				class="secondary lock"
				aria-label="Lock"
				title="Lock"
				onclick={session.lock}
			>
				<svg
					viewBox="0 0 24 24"
					aria-hidden="true"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"
					stroke-linejoin="round"
				>
					<rect x="5" y="10" width="14" height="11" rx="2" />
					<path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3" />
				</svg>
			</button>
		</header>
		{#if page === "settings"}
			<Settings {session} {pairing} {uploads} {preferences} />
		{:else}
			<Library
				{session}
				{library}
				{tags}
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
.lock {
	display: grid;
	place-items: center;
	width: 3rem;
	height: 3rem;
	padding: 0.5rem;
}
.lock svg {
	width: 1.25rem;
	height: 1.25rem;
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
