<script>
let { name, canUpload, onupload, oncancel } = $props();
</script>

<section class="panel stack pending" aria-label="File from extension">
	<strong>File from extension</strong>
	<p class="filename">{name}</p>
	<p>
		{canUpload
			? "Ready to upload. Cancel to discard this file."
			: "Unlock your library to upload this file. Cancel to discard it."}
	</p>
	<div class="bar">
		<button type="button" disabled={!canUpload} onclick={onupload}>
			Upload file
		</button>
		<button type="button" class="secondary" onclick={oncancel}>Cancel</button>
	</div>
</section>

<style>
.pending {
	margin-bottom: 1rem;
}
.filename {
	overflow-wrap: anywhere;
}
p {
	margin: 0;
}
</style>
