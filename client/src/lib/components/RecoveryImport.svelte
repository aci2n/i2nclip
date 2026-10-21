<script lang="ts">
interface Props {
	busy: boolean;
	error: string;
	onrestore: (file: File, password: string, revokePublicKey?: string) => void;
	allowRevocation?: boolean;
	label?: string;
	description?: string;
}
let {
	busy,
	error,
	onrestore,
	allowRevocation = false,
	label = "Restore library",
	description = "Restore your library from its encrypted recovery file.",
}: Props = $props();
let file = $state<File | null>(null);
let password = $state("");
let revokePublicKey = $state("");
</script>
<form
	class="stack"
	onsubmit={(event) => {
		event.preventDefault();
		if (file) {
			file &&
				onrestore(
					file,
					password,
					allowRevocation ? revokePublicKey.trim() : "",
				);
		}
	}}
>
	<p>{description}</p>
	<label class="field"
		>Recovery file<input
			type="file"
			accept=".msgpack,application/msgpack"
			required
			disabled={busy}
			onchange={(event) => (file = event.currentTarget.files?.[0] || null)}
		></label
	>
	<label class="field"
		>Recovery password<input
			type="password"
			required
			autocomplete="off"
			bind:value={password}
			disabled={busy}
		></label
	>
	{#if allowRevocation}
		<details>
			<summary>Revoke a device before enrollment</summary>
			<p>
				Optional: enter the full signing public key of one device to revoke.
				Leave blank to preserve all devices. Rotate keys afterward to protect
				future data.
			</p>
			<label class="field"
				>Device signing public key<input
					type="text"
					bind:value={revokePublicKey}
					disabled={busy}
					pattern="[0-9a-fA-F]{64}"
				></label
			>
		</details>
	{/if}
	<button type="submit" disabled={busy || !file}>
		{allowRevocation && revokePublicKey.trim()
			? "Revoke device and prepare enrollment"
			: label}
	</button>
	{#if error}
		<p class="error" role="alert">{error}</p>
	{/if}
</form>
