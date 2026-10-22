<script lang="ts">
import AboutDialog from "../components/AboutDialog.svelte";
import LibraryBackup from "../components/LibraryBackup.svelte";
import PairingSend from "../components/PairingSend.svelte";
import PasswordSettings from "../components/PasswordSettings.svelte";
import UploadPreferences from "../components/UploadPreferences.svelte";
import { fileSize } from "../media/format.ts";
import type { Pairing } from "../stores/pairing.ts";
import type { Preferences } from "../stores/preferences.ts";
import type { Quota } from "../stores/quota.ts";
import type { Session } from "../stores/session.ts";
import type { Uploads } from "../stores/uploads.ts";
import Setup from "./Setup.svelte";

interface Props {
	session: Session;
	pairing: Pairing;
	quota: Quota | null;
	uploads: Uploads | null;
	preferences: Preferences;
}
let { session, pairing, quota, uploads, preferences }: Props = $props();
let about = $state(false);
const busy = $derived($session.busy || $pairing.active);
</script>
<div class="settings stack">
	{#if !$session.configured}
		<Setup {session} {pairing} />
	{:else}
		<section class="panel stack">
			<h2>Your library</h2>
			<p class="address">{$session.serverUrl}</p>
			<p>
				Every connected browser has full access, and access cannot be revoked
				later. Keep your library backup and its password somewhere safe.
			</p>
			<section class="stack" aria-label="Library usage">
				<h3>Storage</h3>
				{#if $quota?.loading}
					<p role="status">Loading usage…</p>
				{/if}
				{#if $quota?.error}
					<p class="error" role="alert">{$quota.error}</p>
				{/if}
				{#if $quota?.value}
					<p>
						Storage: {fileSize($quota.value.usedBytes)} of
						{fileSize($quota.value.maximumBytes)}
					</p>
					<p>
						Files: {$quota.value.retainedFiles} of
						{$quota.value.maximumFiles}
					</p>
					<p>Change history: {fileSize($quota.value.logBytes)}</p>
				{/if}
				<p>Includes deleted files until you delete them permanently.</p>
				<button
					type="button"
					class="secondary"
					disabled={$quota?.loading || $uploads?.uploading}
					onclick={() => quota?.refresh()}
				>
					Refresh usage
				</button>
			</section>
		</section>
		<PairingSend
			state={$pairing}
			{busy}
			onsend={pairing.send}
			onapprove={pairing.approve}
			onreject={pairing.rejectVerification}
			oncancel={pairing.cancel}
		/>
		<details class="panel">
			<summary>Library backup</summary>
			<div class="stack content">
				<LibraryBackup
					password={$session.backup?.password ?? ""}
					{busy}
					downloaded={$session.backupDownloaded}
					onprepare={session.prepareBackup}
					ondownload={session.downloadBackup}
					oncopy={session.copyBackupPassword}
				/>
				{#if ["prepareBackup", "downloadBackup", "copyBackupPassword"].includes(
					$session.lastAction,
				) && $session.error}
					<p class="error" role="alert">{$session.error}</p>
				{/if}
				{#if $session.lastAction === "copyBackupPassword" && $session.notice}
					<p role="status">{$session.notice}</p>
				{/if}
			</div>
		</details>
		<details class="panel">
			<summary>Forget this browser</summary>
			<div class="stack content">
				<p>
					This removes the library and its saved data from this browser. Your
					files stay on the server and on your other browsers. To reconnect, use
					your library backup or connect from another browser.
				</p>
				<button
					type="button"
					class="secondary danger"
					disabled={busy || $uploads?.uploading}
					onclick={() => {
						if (confirm("Remove the library from this browser?")) {
							void session.forget();
						}
					}}
				>
					Forget browser
				</button>
				{#if $session.lastAction === "forget" && $session.error}
					<p class="error" role="alert">{$session.error}</p>
				{/if}
			</div>
		</details>
	{/if}
	<UploadPreferences
		compressImages={$preferences.compressImages}
		busy={$preferences.loading || $preferences.busy}
		error={$preferences.error}
		onchange={preferences.setCompression}
	/>
	<PasswordSettings
		{busy}
		error={$session.lastAction === "changePassword" ? $session.error : ""}
		status={$session.lastAction === "changePassword" &&
		!$session.busy &&
		!$session.error
			? "Master password changed."
			: ""}
		onpassword={session.changePassword}
	/>
	<button type="button" class="secondary about" onclick={() => (about = true)}>
		About
	</button>
</div>
<AboutDialog open={about} onclose={() => (about = false)} />
<style>
.settings {
	max-width: 44rem;
	margin: auto;
}
.content {
	margin-top: 1rem;
}
.address {
	overflow-wrap: anywhere;
}
.about {
	width: fit-content;
}
</style>
