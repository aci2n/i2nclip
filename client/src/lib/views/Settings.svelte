<script>
import { onDestroy, untrack } from "svelte";
import PairingSend from "../components/PairingSend.svelte";
import PasswordSettings from "../components/PasswordSettings.svelte";
import RecoveryExport from "../components/RecoveryExport.svelte";
import UploadPreferences from "../components/UploadPreferences.svelte";
import { fileSize } from "../media/format.js";
import { createQuota } from "../stores/quota.js";
import Setup from "./Setup.svelte";

let { session, pairing, uploads, preferences } = $props();
const quota = untrack(() => createQuota(session));
onDestroy(quota.dispose);
const quotaContext = $derived(
	$session.configured &&
		$session.unlocked &&
		!$session.busy &&
		!$uploads.uploading
		? $session.epoch
		: null,
);
$effect(() => {
	if (quotaContext !== null) {
		quota.refresh();
	}
});
let feedback = $state({ scope: "", text: "", error: false });
const busy = $derived($session.busy || $pairing.active);
async function action(scope, work, success) {
	feedback = { scope, text: "", error: false };
	const done = await work();
	feedback = { scope, text: done ? success : $session.error, error: !done };
}
</script>
<div class="settings stack">
	{#if !$session.configured}
		<Setup {session} {pairing} />
	{:else}
		<section class="panel stack">
			<h2>Your library</h2>
			<p class="address">{$session.serverUrl}</p>
			<section class="usage" aria-label="Library usage">
				{#if $quota.loading}
					<p role="status">Loading usage…</p>
				{:else if $quota.error}
					<p role="alert" class="error">Unable to load usage: {$quota.error}</p>
					<button type="button" class="secondary" onclick={quota.refresh}>
						Retry
					</button>
				{:else if $quota.value}
					<p>
						Storage: {fileSize($quota.value.used_content_bytes)} of
						{fileSize($quota.value.max_content_bytes)}
					</p>
					<p>
						Files: {$quota.value.file_count.toLocaleString()} of
						{$quota.value.max_files.toLocaleString()}
					</p>
				{/if}
			</section>
			<p>
				Keep your recovery file and its password safe. Your master password
				protects this client.
			</p>
		</section>
		<RecoveryExport
			{busy}
			error={feedback.scope === "recovery" && feedback.error
				? feedback.text
				: ""}
			status={feedback.scope === "recovery" && !feedback.error
				? feedback.text
				: ""}
			onexport={(password) =>
				action(
					"recovery",
					() => session.downloadRecovery(password),
					"Recovery file downloaded.",
				)}
		/>
		<PairingSend
			state={$pairing}
			busy={$session.busy}
			onsend={pairing.send}
			onapprove={pairing.approve}
			onreject={pairing.rejectVerification}
			oncancel={pairing.cancel}
		/>
		<details class="panel">
			<summary>Forget this library</summary>
			<div class="stack content">
				<p>
					This removes the saved library identity from this device. Server files
					remain.
				</p>
				<button
					type="button"
					class="secondary danger"
					disabled={busy}
					onclick={() => {
						if (
							confirm(
								"Forget this library? Keep a recovery file before continuing.",
							)
						) {
							action("forget", session.forget, "Library forgotten.");
						}
					}}
				>
					Forget library
				</button>
				{#if feedback.scope === "forget" && feedback.error}
					<p role="alert" class="error">{feedback.text}</p>
				{/if}
			</div>
		</details>
	{/if}
	<UploadPreferences
		compressImages={$preferences.compressImages}
		error={$preferences.error}
		onchange={preferences.setCompression}
	/>
	<PasswordSettings
		{busy}
		error={feedback.scope === "password" && feedback.error ? feedback.text : ""}
		status={feedback.scope === "password" && !feedback.error
			? feedback.text
			: ""}
		onpassword={(current, password) =>
			action(
				"password",
				() => session.changePassword(current, password),
				"Master password changed.",
			)}
	/>
</div>
<style>
.settings {
	max-width: 42rem;
	margin: auto;
}
.usage {
	display: grid;
	gap: 0.5rem;
	justify-items: start;
	overflow-wrap: anywhere;
}
.address {
	overflow-wrap: anywhere;
}
.content {
	margin-top: 1rem;
}
</style>
