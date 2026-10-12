<script>
import { onDestroy } from "svelte";
import { createTabAdmission } from "./lib/stores/tab.js";
import Application from "./lib/views/Application.svelte";
import "./app.css";

const admission = createTabAdmission();
onDestroy(admission.dispose);
</script>

{#if $admission.status === "active"}
	<Application />
{:else}
	<main class="panel stack">
		<h1>i2nclip</h1>
		{#if $admission.error}
			<p role="alert">{$admission.error}</p>
			{#if $admission.status === "blocked"}
				<button type="button" onclick={admission.retry}>Retry</button>
			{/if}
		{:else}
			<p role="status">Checking tab access…</p>
		{/if}
	</main>
{/if}

<style>
main {
	max-width: 32rem;
	margin: 3rem auto;
}
</style>
