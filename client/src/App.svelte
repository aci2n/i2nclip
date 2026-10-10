<script>
import { onDestroy, untrack } from "svelte";
import { createApplication } from "./lib/stores/application.js";
import Library from "./lib/views/Library.svelte";
import Settings from "./lib/views/Settings.svelte";
import Upload from "./lib/views/Upload.svelte";
import "./app.css";

let { platform, page: initialPage } = $props();
const app = untrack(() => createApplication(platform, initialPage));
const session = app.session;
const page = $derived($app.page);
const library = $derived($app.library);
onDestroy(app.dispose);
</script>

<main class:compact={page === "upload" || page === "unlock"}>
	<header>
		<a
			class="brand"
			href={app.href("library")}
			onclick={(event) => app.navigate(event, "library")}
			>i2nclip</a
		>
		<nav aria-label="Main navigation">
			<a
				href={app.href("library")}
				aria-current={page === "library" ? "page" : undefined}
				onclick={(event) => app.navigate(event, "library")}
				>Library</a
			>
			<a
				href={app.href("options")}
				aria-current={page === "options" ? "page" : undefined}
				onclick={(event) => app.navigate(event, "options")}
				>Settings</a
			>
		</nav>
	</header>
	{#if !$session.ready}
		<p role="status">Loading…</p>
	{:else if page === "options"}
		<Settings {session} settings={app.settings} />
	{:else if page === "upload" || page === "unlock"}
		<Upload
			{session}
			pending={$app.pending}
			auto={$app.auto}
			settingsHref={app.href("options")}
		/>
	{:else}
		<Library
			{session}
			{library}
			settingsHref={app.href("options")}
			onsettings={(event) => app.navigate(event, "options")}
		/>
	{/if}
</main>

<style>
main {
	max-width: 76rem;
	padding: 1.5rem;
	margin: auto;
}
main.compact {
	max-width: 32rem;
}
header {
	display: flex;
	justify-content: space-between;
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
	display: flex;
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
	main {
		padding: 1rem;
	}
}
</style>
