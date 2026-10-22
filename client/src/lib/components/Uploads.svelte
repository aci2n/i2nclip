<script lang="ts">
import type { UploadState } from "../media/upload-state.ts";

interface Props {
	uploading: boolean;
	progress: UploadState["progress"];
	failures?: UploadState["failures"];
	completed?: UploadState["completed"];
	notices?: UploadState["notices"];
	status: string;
	ondismiss: () => void;
}
let {
	uploading,
	progress,
	failures = [],
	completed = [],
	notices = [],
	status,
	ondismiss,
}: Props = $props();
</script>
{#if uploading ||
	failures.length ||
	completed.length ||
	notices.length ||
	status}
	<section aria-label="Uploads">
		<div class="summary">
			{#if uploading}
				<p role="status">
					{#if progress}
						{progress.phase === "preparing" ? "Preparing" : "Uploading"}
						{progress.index}
						of {progress.total}<span class="percent">{progress.percent}%</span>
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
			{#if (completed.length || notices.length) && !uploading}
				<button
					class="icon"
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
		{#if notices.length}
			<ul>
				{#each notices as notice}
					<li>{notice.name}: {notice.message}</li>
				{/each}
			</ul>
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
	gap: var(--space-2);
	margin-bottom: var(--space-4);
	padding: var(--space-2) var(--space-3);
	border: 1px solid var(--line);
	border-radius: var(--radius);
	background: var(--paper);
	font-size: var(--text-sm);
}
.summary {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: var(--space-2);
	min-width: 0;
}
.summary > p,
details {
	flex: 1;
	min-width: 0;
}
summary {
	min-height: var(--touch);
	padding-block: var(--space-3);
}
.percent {
	margin-left: var(--space-3);
	font-variant-numeric: tabular-nums;
	color: var(--accent);
}
.filename {
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
ul {
	padding-left: var(--space-6);
	overflow-wrap: anywhere;
}
button.icon {
	align-self: flex-start;
	color: var(--muted);
}
button.icon:hover {
	color: var(--accent);
}
progress {
	width: 100%;
	height: 0.5rem;
	accent-color: var(--accent);
}
</style>
