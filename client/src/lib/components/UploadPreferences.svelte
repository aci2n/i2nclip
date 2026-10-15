<script>
let { compressImages, error, onchange } = $props();
</script>
<section class="panel stack">
	<h2>Uploads</h2>
	<label>
		<input
			type="checkbox"
			checked={compressImages}
			onchange={(event) => onchange(event.currentTarget.checked)}
		>
		Compress images to WebP
	</label>
	<p>
		Replaces JPEG, PNG, and BMP originals when WebP is smaller. Keeps their
		dimensions. This setting applies only to this device.
	</p>
	{#if error}
		<p class="error" role="alert">{error}</p>
	{/if}
</section>
<style>
label {
	display: flex;
	align-items: center;
	gap: 0.5rem;
}
input {
	width: auto;
	flex: none;
}
</style>
