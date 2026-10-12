<script>
import { onDestroy, untrack } from "svelte";
import AboutDialog from "./lib/components/AboutDialog.svelte";
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
let aboutOpen = $state(false);
let libraryName = $state("");
let catalogError = $state("");
let adding = $state(false);
async function catalogAction(action) {
	catalogError = "";
	try {
		await action();
		libraryName = "";
		adding = false;
	} catch (error) {
		catalogError = error.message;
	}
}
onDestroy(app.dispose);
</script>

<main class:compact={page === "upload" || page === "unlock"}>
	<header>
		<a
			class="brand"
			href={app.href("library", $app.libraryId)}
			onclick={(event) => app.navigate(event, "library")}
			>i2nclip</a
		>
		<nav aria-label="Main navigation">
			{#if $app.popupPage}
				<a
					href={app.href($app.popupPage, $app.libraryId)}
					aria-current={page === "upload" || page === "unlock"
						? "page"
						: undefined}
					onclick={(event) => app.navigate(event, $app.popupPage)}
					>Upload</a
				>
			{/if}
			<a
				href={app.href("library", $app.libraryId)}
				aria-current={page === "library" ? "page" : undefined}
				onclick={(event) => app.navigate(event, "library")}
				>Library</a
			>
			<a
				href={app.href("options", $app.libraryId)}
				aria-current={page === "options" ? "page" : undefined}
				onclick={(event) => app.navigate(event, "options")}
				>Settings</a
			>
			<button type="button" onclick={() => (aboutOpen = true)}>About</button>
		</nav>
	</header>
	{#if !$app.popupPage && $app.catalog.length}
		<div class="catalog bar">
			<label for="library-selector">Library</label>
			<select
				id="library-selector"
				value={$app.libraryId}
				onchange={(event) => app.selectLibrary(event.currentTarget.value)}
			>
				{#each $app.catalog as saved}
					<option value={saved.id}>{saved.name}</option>
				{/each}
			</select>
			<button
				type="button"
				class="secondary"
				onclick={() => {
					adding = !adding;
					libraryName = "";
				}}
			>
				Add library
			</button>
		</div>
		{#if adding}
			<form
				class="bar catalog"
				onsubmit={(event) => {
					event.preventDefault();
					catalogAction(() => app.addLibrary(libraryName));
				}}
			>
				<label for="new-library-name">Library name</label>
				<input
					id="new-library-name"
					bind:value={libraryName}
					required
					maxlength="80"
				>
				<button type="submit">Add</button>
			</form>
		{:else if page === "options"}
			<form
				class="bar catalog"
				onsubmit={(event) => {
					event.preventDefault();
					catalogAction(() => app.renameLibrary(libraryName));
				}}
			>
				<label for="rename-library">Rename library</label>
				<input
					id="rename-library"
					bind:value={libraryName}
					required
					maxlength="80"
				>
				<button type="submit">Rename</button>
				<button
					type="button"
					class="secondary danger"
					onclick={() => catalogAction(app.forgetLibrary)}
				>
					Forget this library
				</button>
			</form>
		{/if}
		{#if catalogError}
			<p role="alert">{catalogError}</p>
		{/if}
	{/if}
	{#if !$session.ready}
		<p role="status">Loading…</p>
	{:else if page === "options"}
		{#key $app.libraryId}
			<Settings {session} settings={app.settings} pairing={app.pairing} />
		{/key}
	{:else if page === "upload" || page === "unlock"}
		<Upload
			{session}
			pending={$app.pending}
			auto={$app.auto}
			settingsHref={app.href("options", $app.libraryId)}
		/>
	{:else}
		{#key $app.libraryId}
			<Library
				{session}
				{library}
				settingsHref={app.href("options", $app.libraryId)}
				onsettings={(event) => app.navigate(event, "options")}
			/>
		{/key}
	{/if}
</main>
<AboutDialog open={aboutOpen} onclose={() => (aboutOpen = false)} />

<style>
.catalog {
	flex-wrap: wrap;
	margin-bottom: 1rem;
	gap: 0.5rem;
}
.catalog select {
	flex: 1;
	min-width: 0;
}
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
