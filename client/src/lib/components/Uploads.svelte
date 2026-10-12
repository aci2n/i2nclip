<script>
let { library } = $props();
</script>

<details class="uploads">
	<summary>
		Uploads
		{#if $library.uploading}
			· In progress
		{/if}
		{#if $library.uploadFailures.length}
			· {$library.uploadFailures.length} failed
		{/if}
		{#if $library.uploadCompleted.length}
			· {$library.uploadCompleted.length} uploaded
		{/if}
	</summary>
	<div class="stack details">
		{#if $library.uploadStatus}
			<p role="status">{$library.uploadStatus}</p>
		{/if}
		{#if $library.visibleUploadJobs.length}
			<section class="upload-progress" aria-label="Upload progress">
				<ul class="upload-list">
					{#each $library.visibleUploadJobs as job (job.id)}
						{@const percent =
							job.status === "completed" ? 100 : job.progress || 0}
						<li>
							<span
								>{job.name || "Preparing file…"}<small
									>{job.status}</small
								></span
							><progress
								max="100"
								value={percent}
								aria-label={`${job.name || "File"} upload progress`}
							></progress><span>{percent}%</span>
						</li>
					{/each}
				</ul>
			</section>
		{/if}
		{#if $library.uploadFailures.length}
			<section class="upload-failures" aria-label="Failed uploads">
				<h2>Failed uploads</h2>
				<ul>
					{#each $library.uploadFailures as failure}
						<li><strong>{failure.file.name}</strong>: {failure.error}</li>
					{/each}
				</ul>
				<button
					type="button"
					class="secondary"
					disabled={$library.uploading}
					onclick={library.retryUploads}
				>
					Retry retained files
				</button>
				<button
					type="button"
					class="secondary"
					disabled={$library.uploading}
					onclick={library.discardUploads}
				>
					Discard retained files
				</button>
			</section>
		{/if}
		{#if $library.uploadCompleted.length}
			<p class="upload-history">
				{$library.uploadCompleted.length}
				uploaded.
				<button
					type="button"
					class="secondary"
					onclick={library.dismissCompleted}
				>
					Clear completed uploads
				</button>
			</p>
		{/if}

		{#if !$library.visibleUploadJobs.length &&
			!$library.uploadFailures.length &&
			!$library.uploadCompleted.length &&
			!$library.uploadStatus}
			<p>No recent uploads.</p>
		{/if}
	</div>
</details>

<style>
.uploads {
	margin-bottom: 1rem;
	border: 1px solid var(--line);
	border-radius: 0.4rem;
}
summary {
	padding: 0.5rem 0.75rem;
	cursor: pointer;
}
.details {
	padding: 0.75rem;
}
.upload-progress,
.upload-failures {
	margin: 1rem 0;
	overflow-wrap: anywhere;
}
.upload-history {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 0.5rem;
}
.upload-progress progress {
	width: 100%;
	accent-color: var(--accent);
}
.upload-list {
	list-style: none;
	padding: 0;
	display: grid;
	gap: 0.75rem;
}
.upload-list li {
	display: grid;
	grid-template-columns: minmax(0, 1fr) 5rem 3rem;
	gap: 0.5rem;
	align-items: center;
}
small {
	display: block;
	color: var(--muted);
}
.upload-failures ul {
	padding-inline-start: 1.5rem;
}
</style>
