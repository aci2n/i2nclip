<script lang="ts">
import AboutDialog from "../components/AboutDialog.svelte";
import DevicesPanel from "../components/DevicesPanel.svelte";
import PairingSend from "../components/PairingSend.svelte";
import PasswordSettings from "../components/PasswordSettings.svelte";
import UploadPreferences from "../components/UploadPreferences.svelte";
import { fileSize } from "../media/format.ts";
import { bytesToHex } from "../protocol/bytes.ts";
import type { Bytes } from "../protocol/chain.ts";
import { type ChainStore, stateCheckpoint } from "../stores/chain.ts";
import type { Pairing } from "../stores/chain-pairing.ts";
import type { ChainQuota } from "../stores/chain-quota.ts";
import type { ChainUploads } from "../stores/chain-uploads.ts";
import type { Devices } from "../stores/devices.ts";
import type { Session } from "../stores/identity.ts";
import type { Preferences } from "../stores/preferences.ts";
import Setup from "./Setup.svelte";

interface Props {
	session: Session;
	pairing: Pairing;
	quota: ChainQuota | null;
	uploads: ChainUploads | null;
	preferences: Preferences;
	devices: Devices | null;
	chain: ChainStore | null;
}
let { session, pairing, quota, uploads, preferences, devices, chain }: Props =
	$props();
let about = $state(false);
const busy = $derived($session.busy || $pairing.active);
function revoke(key: Bytes) {
	const state = $chain?.live;
	if (state && devices) {
		void devices.revoke(key, stateCheckpoint(state));
	}
}
</script>
<div class="settings stack">
	{#if !$session.configured}
		<Setup {session} {pairing} />
	{:else}
		<section class="panel stack">
			<h2>Your library</h2>
			<p class="address">{$session.serverUrl}</p>
			<p>
				The recovery file is your offline safety net. It is never stored on
				paired devices and cannot be exported from them. Lost devices must
				re-pair; if all devices are lost, restore the recovery file.
			</p>
			<section class="stack" aria-label="Library usage">
				<h3>Current server usage</h3>
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
						Retained files: {$quota.value.retainedFiles} of
						{$quota.value.maximumFiles}
					</p>
					<p>Encrypted history: {fileSize($quota.value.logBytes)}</p>
				{/if}
				<p>
					Usage includes staged uploads and retained deleted files. It describes
					current server storage and does not rewind with history.
				</p>
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
			busy={busy || $session.pendingRotation}
			onsend={pairing.send}
			onapprove={pairing.approve}
			onreject={pairing.rejectVerification}
			oncancel={pairing.cancel}
		/>
		{#if devices && $devices}
			<DevicesPanel
				state={$devices}
				current={$session.context
					? bytesToHex($session.context.key.publicKey)
					: ""}
				{busy}
				onrevoke={revoke}
				onprepare={devices.prepareRotation}
				onsubmit={devices.submitRotation}
				onreconcile={devices.reconcile}
			/>
		{/if}
		{#if $session.notice}
			<p role="status">{$session.notice}</p>
		{/if}
		<details class="panel">
			<summary>Forget this device</summary>
			<div class="stack content">
				<p>
					This removes this client's device keys and cached history, including
					its trusted head. Server data and other devices remain. Reconnect by
					pairing or recovery.
				</p>
				<button
					type="button"
					class="secondary danger"
					disabled={busy || $uploads?.uploading}
					onclick={() => {
						if (confirm("Forget this device and remove its cached history?")) {
							void session.forget();
						}
					}}
				>
					Forget device
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
