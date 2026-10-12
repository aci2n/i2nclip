<script>
import ContextDestination from "./lib/components/ContextDestination.svelte";
import VaultScreen from "./lib/components/VaultScreen.svelte";
import { onDestroy, untrack } from "svelte";
import ManageLibraries from "./lib/components/ManageLibraries.svelte";
import AboutDialog from "./lib/components/AboutDialog.svelte";
import { createApplication } from "./lib/stores/application.js";
import Library from "./lib/views/Library.svelte";
import Settings from "./lib/views/Settings.svelte";
import Upload from "./lib/views/Upload.svelte";
import "./app.css";

let { platform, page: initialPage } = $props();
const app = untrack(() => createApplication(platform, initialPage));
const session = app.session;
const vault = app.vault;
const page = $derived($app.page);
const library = $derived($app.library);
let aboutOpen = $state(false);
onDestroy(app.dispose);
</script>

<main class:compact={page === "upload" || page === "unlock"}>
	{#if $vault.status === "unlocked"}
		<header>
			<a
				class="brand"
				href={app.href("library", $app.libraryId)}
				onclick={(event) => app.navigate(event, "library")}
				>i2nclip</a
			>
			{#if !$app.popupPage && $app.catalog.length > 1}
				<select
					id="library-selector"
					aria-label="Library"
					value={$app.libraryId}
					onchange={(event) => app.selectLibrary(event.currentTarget.value)}
				>
					{#each $app.catalog as saved}
						<option value={saved.id}>{saved.name}</option>
					{/each}
				</select>
			{/if}
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
				<button type="button" onclick={() => void vault.lock()}>Lock</button>
				<button type="button" onclick={() => (aboutOpen = true)}>About</button>
			</nav>
		</header>
	{/if}
	{#if $vault.status !== "unlocked"}
		<VaultScreen {vault} />
	{:else if $app.transientUpload}
		<ContextDestination {app} />
	{:else if !$session.ready}
		<p role="status">Loading…</p>
	{:else if page === "options"}
		{#key $app.libraryId}
			<Settings
				{session}
				settings={app.settings}
				pairing={app.pairing}
				setup={app.setup}
				{vault}
				onRestore={app.restoredLibrary}
			>
				{#snippet management(
					serverControls,
				)}
					<ManageLibraries
						{app}
						{vault}
						{serverControls}
						catalog={$app.catalog}
						libraryId={$app.libraryId}
					/>
				{/snippet}
			</Settings>
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
#library-selector {
	width: auto;
	max-width: min(12rem, 100%);
	min-width: 0;
	padding: 0.375rem 0.5rem;
	font-size: 0.875rem;
	margin-right: auto;
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
