<script lang="ts">
import { bytesToHex } from "../protocol/bytes.ts";
import type { Bytes } from "../protocol/chain.ts";
import type { DevicesState } from "../stores/devices.ts";
import RecoveryImport from "./RecoveryImport.svelte";

interface Props {
	state: DevicesState;
	current: string;
	busy: boolean;
	onrevoke: (key: Bytes) => void;
	onprepare: (file: File, password: string) => void;
	onsubmit: () => void;
	onreconcile: () => void;
}
let {
	state,
	current,
	busy,
	onrevoke,
	onprepare,
	onsubmit,
	onreconcile,
}: Props = $props();
const active = $derived(
	state.members.filter((member) => member.revokedAt === null).length,
);
const revoked = $derived(
	state.members.some(
		(member) =>
			bytesToHex(member.publicKey) === current && member.revokedAt !== null,
	),
);
</script>
<details class="panel" open>
	<summary><h2>Devices and epoch reset</h2></summary>
	<div class="stack content">
		<p>
			Every authorized device has full file access. Only the offline recovery
			key can reset the encryption epoch.
		</p>
		{#if revoked}
			<p class="error" role="alert">
				This device is revoked. Pair it again, or restore with the recovery
				file.
			</p>
		{/if}
		<ul class="devices">
			{#each state.members as member (bytesToHex(member.publicKey))}
				<li>
					<div class="stack identity">
						<code>{bytesToHex(member.publicKey).slice(0, 16)}…</code
						><span
							>{bytesToHex(member.publicKey) === current
								? "This device · "
								: ""}{member.revokedAt === null
								? `Authorized at block ${member.authorizedAt}`
								: `Revoked at block ${member.revokedAt}`}</span
						>
						<details>
							<summary>Full public key</summary>
							<code>{bytesToHex(member.publicKey)}</code>
						</details>
					</div>
					{#if member.revokedAt === null}
						<button
							type="button"
							class="secondary danger"
							aria-label={`Revoke device ${bytesToHex(member.publicKey).slice(0, 16)}`}
							disabled={busy ||
								state.busy ||
								state.rotationPrepared ||
								active <= 1 ||
								revoked}
							onclick={() => onrevoke(member.publicKey)}
						>
							Revoke
						</button>
					{/if}
				</li>
			{/each}
		</ul>
		<p>
			Revocation blocks server access but cannot erase copied keys. Reset the
			epoch to exclude every old device from future encryption keys; then pair
			the devices you keep.
		</p>
		{#if state.rotationPrepared}
			<p>
				A recovery-approved reset is saved locally. Submission revokes every old
				device and makes this client's fresh replacement key the initial device.
			</p>
			<div class="actions">
				<button type="button" disabled={busy || state.busy} onclick={onsubmit}>
					Submit epoch reset
				</button><button
					type="button"
					class="secondary"
					disabled={busy || state.busy}
					onclick={onreconcile}
				>
					Check reset outcome
				</button>
			</div>
		{/if}
		<RecoveryImport
			busy={busy || state.busy}
			error=""
			label="Prepare epoch reset"
			description="Unlock the recovery file to prepare a reset against the current head. The recovery key is used temporarily and is not saved on this device."
			onrestore={onprepare}
		/>
		{#if state.error}
			<p class="error" role="alert">{state.error}</p>
		{/if}
		{#if state.status}
			<p role="status">{state.status}</p>
		{/if}
	</div>
</details>
<style>
summary h2 {
	display: inline;
}
.content {
	margin-top: 1rem;
}
.devices {
	padding: 0;
	list-style: none;
	display: grid;
	gap: 1rem;
}
li {
	display: flex;
	align-items: start;
	gap: 0.75rem;
	justify-content: space-between;
}
.identity {
	min-width: 0;
	gap: 0.25rem;
	overflow-wrap: anywhere;
}
code {
	font-size: 0.875rem;
}
.actions {
	display: flex;
	gap: 0.5rem;
	flex-wrap: wrap;
}
@media (max-width: 24rem) {
	li {
		flex-direction: column;
	}
}
</style>
