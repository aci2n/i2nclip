<script lang="ts">
interface Props {
	compressImages: boolean;
	error: string;
	busy: boolean;
	onchange: (value: boolean) => void;
}
let { compressImages, error, busy, onchange }: Props = $props();
</script>
<details class="panel">
	<summary>Uploads</summary>
	<div class="stack">
		<label>
			<input
				type="checkbox"
				disabled={busy}
				checked={compressImages}
				onchange={(event) => onchange(event.currentTarget.checked)}
			>
			Compress images to WebP
		</label>
		<p>
			Replaces JPEG, PNG, and BMP originals when WebP is smaller. Keeps their
			dimensions. This setting applies only to this device.
		</p>
		{#if busy}
			<p role="status">Saving upload preference…</p>
		{/if}
		{#if error}
			<p class="error" role="alert">{error}</p>
		{/if}
	</div>
</details>
<style>
label {
	display: flex;
	align-items: center;
	min-height: var(--target);
	gap: var(--space-2);
}
input {
	width: auto;
	flex: none;
}
</style>
