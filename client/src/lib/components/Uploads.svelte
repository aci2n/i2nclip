<script lang="ts">
import type { UploadState } from "../stores/uploads.ts";

interface Props {
	uploading: boolean;
	progress: UploadState["progress"];
	failures?: UploadState["failures"];
	completed?: UploadState["completed"];
	status: string;
	ondismiss: () => unknown;
}
let {
	uploading,
	progress,
	failures = [],
	completed = [],
	status,
	ondismiss,
}: Props = $props();
</script>
{#if uploading || failures.length || completed.length || status}
	<section aria-label="Uploads">
		<div class="summary">
			{#if uploading}
				<p role="status">
					{#if progress}
						Uploading {progress.index} of {progress.total}<span class="percent"
							>{progress.percent}%</span
						>
					{:else}
						Preparing uploads…
					{/if}
				</p>
			{:else if completed.length}
				<details>
					<summary>
						<span role="status"
							>{completed.length}
							{completed.length === 1 ? "file" : "files"}
							uploaded</span
						>
					</summary>
					<ul>
						{#each completed as item (item.id)}
							<li>{item.name}</li>
						{/each}
					</ul>
				</details>
			{:else}
				<p role="status">{status}</p>
			{/if}
			{#if completed.length && !uploading}
				<button
					type="button"
					aria-label="Dismiss completed uploads"
					title="Dismiss completed uploads"
					onclick={ondismiss}
				>
					<svg
						viewBox="0 0 24 24"
						aria-hidden="true"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
					>
						<path d="M6 6l12 12M18 6L6 18" />
					</svg>
				</button>
			{/if}
		</div>
		{#if progress}
			<p class="filename" title={progress.name}>{progress.name}</p>
			<progress
				max="100"
				value={progress.percent}
				aria-label="Upload progress"
			></progress>
		{/if}
		{#if failures.length}
			<ul class="error" role="alert">
				{#each failures as failure}
					<li>{failure.name}: {failure.error}</li>
				{/each}
			</ul>
			{#if completed.length && status}
				<p>{status}</p>
			{/if}
		{/if}
	</section>
{/if}
<style>
section {
	display: flex;
	flex-direction: column;
	gap: 0.5rem;
	margin-bottom: 1rem;
	padding: 0.5rem 0.75rem;
	border: 1px solid var(--line);
	border-radius: 0.4rem;
	background: var(--paper);
	font-size: 0.9rem;
}
.summary {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 0.5rem;
	min-width: 0;
}
.summary > p,
details {
	flex: 1;
	min-width: 0;
}
summary {
	min-height: 3rem;
	padding-block: 0.75rem;
}
.percent {
	margin-left: 0.75rem;
	font-variant-numeric: tabular-nums;
	color: var(--accent);
}
.filename {
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
ul {
	padding-left: 1.5rem;
	overflow-wrap: anywhere;
}
button {
	display: grid;
	place-items: center;
	align-self: flex-start;
	flex: none;
	width: 3rem;
	height: 3rem;
	padding: 0.5rem;
	background: transparent;
	color: var(--muted);
}
button:hover {
	color: var(--accent);
}
svg {
	width: 1rem;
	height: 1rem;
}
progress {
	width: 100%;
	height: 0.5rem;
	accent-color: var(--accent);
}
</style>
