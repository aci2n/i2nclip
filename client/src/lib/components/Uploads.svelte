<script>
let {
	uploading,
	progress,
	failures = [],
	completed = [],
	status,
	onretry,
	ondiscard,
	ondismiss,
} = $props();
</script>
{#if uploading || failures.length || completed.length || status}
	<section class="panel stack" aria-label="Uploads">
		<h2>Uploads</h2>
		{#if progress}
			<p role="status">
				{progress.name}
				· {progress.index}/{progress.total}
				· {progress.percent}%
			</p>
			<progress
				max="100"
				value={progress.percent}
				aria-label="Upload progress"
			></progress>
		{/if}
		{#if completed.length}
			<ul>
				{#each completed as item (item.id)}
					<li>{item.name} — uploaded</li>
				{/each}
			</ul>
			<button type="button" class="secondary" onclick={ondismiss}>
				Dismiss completed uploads
			</button>
		{/if}
		{#if failures.length}
			<ul>
				{#each failures as failure}
					<li class="error">{failure.name}: {failure.error}</li>
				{/each}
			</ul>
			<div class="bar">
				<button type="button" disabled={uploading} onclick={onretry}>
					Retry failed files
				</button><button
					type="button"
					class="secondary"
					disabled={uploading}
					onclick={ondiscard}
				>
					Discard failed files
				</button>
			</div>
		{/if}
		{#if status}
			<p role="status">{status}</p>
		{/if}
	</section>
{/if}
<style>
section {
	margin-bottom: 1.5rem;
}
ul {
	padding-left: 1.5rem;
	overflow-wrap: anywhere;
}
progress {
	width: 100%;
}
</style>
