<script lang="ts">
interface Props {
	password: string;
	busy: boolean;
	downloaded: boolean;
	onprepare: () => void;
	ondownload: () => void;
	oncopy: () => void;
}
let { password, busy, downloaded, onprepare, ondownload, oncopy }: Props =
	$props();
</script>
<div class="stack">
	<p>
		The backup contains your library credentials, not your files. Anyone with
		the file and its password has full access. Store both securely and
		separately.
	</p>
	{#if password}
		<label class="field"
			>Backup password<input
				type="text"
				readonly
				value={password}
				autocomplete="off"
				spellcheck="false"
			></label
		>
		<div class="actions">
			<button type="button" class="secondary" disabled={busy} onclick={oncopy}>
				Copy password
			</button>
			<button type="button" disabled={busy} onclick={ondownload}>
				Download backup
			</button>
		</div>
	{:else}
		<button type="button" disabled={busy} onclick={onprepare}>
			Prepare backup
		</button>
	{/if}
	{#if downloaded}
		<p role="status">Backup downloaded. Store its password securely.</p>
	{/if}
</div>
<style>
.actions {
	display: flex;
	flex-wrap: wrap;
	gap: 0.5rem;
}
input {
	font-family: monospace;
}
</style>
