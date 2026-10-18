<script lang="ts">
import { fileSize } from "../media/format.ts";
import {
	canConvertImage,
	canConvertVideo,
	type UploadOptions,
} from "../media/options.ts";
import type { PendingUpload } from "../stores/uploads.ts";
import ImageOptions from "./ImageOptions.svelte";
import VideoOptions from "./VideoOptions.svelte";

interface Props {
	pending: PendingUpload[];
	busy: boolean;
	onchange: (key: number, options: UploadOptions) => void;
	ondefaults: (key: number) => void;
	onremove: (key: number) => void;
	onstart: () => unknown;
	oncancel: () => void;
}
let {
	pending,
	busy,
	onchange,
	ondefaults,
	onremove,
	onstart,
	oncancel,
}: Props = $props();
</script>
{#if pending.length}
	<section class="panel review" aria-label="Review uploads">
		<form
			class="stack"
			oninvalidcapture={(event) => {
				const target = event.target;
				if (target instanceof HTMLElement) {
					const details = target.closest("details");
					if (details) {
						details.open = true;
					}
				}
			}}
			onsubmit={(event) => {
				event.preventDefault();
				onstart();
			}}
		>
			<h2>Ready to upload ({pending.length})</h2>
			{#each pending as entry (entry.key)}
				<article>
					{#if canConvertImage(entry.file) || canConvertVideo(entry.file)}
						<details>
							<summary>
								<span class="name"
									>{entry.file.name}
									<span class="size">{fileSize(entry.file.size)}</span></span
								>
								<span class="options-label">Upload options</span>
							</summary>
							<div class="stack options">
								{#if canConvertImage(entry.file)}
									<ImageOptions
										compact
										value={entry.options.image}
										disabled={busy}
										onchange={(image) =>
											onchange(entry.key, { ...entry.options, image })}
									/>
								{:else}
									<VideoOptions
										compact
										value={entry.options.video}
										disabled={busy}
										onchange={(video) =>
											onchange(entry.key, { ...entry.options, video })}
									/>
								{/if}
								<button
									type="button"
									class="secondary defaults"
									disabled={busy}
									onclick={() => ondefaults(entry.key)}
								>
									Use defaults
								</button>
							</div>
						</details>
					{:else}
						<p class="name">
							{entry.file.name}
							<span class="size">{fileSize(entry.file.size)}</span>
						</p>
					{/if}
					<button
						type="button"
						class="secondary remove"
						disabled={busy}
						onclick={() => onremove(entry.key)}
						aria-label={`Remove ${entry.file.name}`}
					>
						×
					</button>
				</article>
			{/each}
			<div class="actions">
				<button type="submit" disabled={busy}>Start upload</button>
				<button
					type="button"
					class="secondary"
					disabled={busy}
					onclick={oncancel}
				>
					Cancel
				</button>
			</div>
		</form>
	</section>
{/if}
<style>
.review {
	margin-bottom: 1rem;
}
article {
	display: grid;
	grid-template-columns: minmax(0, 1fr) auto;
	align-items: start;
	column-gap: 0.5rem;
}
article + article {
	border-top: 1px solid var(--line);
	padding-top: 0.5rem;
}
details,
p.name {
	grid-column: 1 / -1;
	grid-row: 1;
}
summary {
	padding-right: 3.5rem;
	min-height: 3rem;
	padding-block: 0.5rem;
}
.name {
	min-width: 0;
	overflow-wrap: anywhere;
}
p.name {
	padding-right: 3.5rem;
	padding-block: 0.75rem;
}
.size,
.options-label {
	color: var(--muted);
	font-size: 0.875rem;
}
.size {
	white-space: nowrap;
	margin-left: 0.5rem;
}
.options-label {
	margin-left: 0.75rem;
	white-space: nowrap;
}
.options {
	margin-block: 0.5rem;
	gap: 0.5rem;
}
.defaults {
	align-self: start;
}
.remove {
	grid-column: 2;
	grid-row: 1;
	width: 3rem;
	height: 3rem;
	padding: 0.5rem;
	font-size: 1.25rem;
}
.actions {
	display: flex;
	flex-wrap: wrap;
	gap: 0.5rem;
}
@media (max-width: 32rem) {
	.options-label {
		display: block;
		margin-left: 1rem;
		margin-top: 0.25rem;
	}
}
</style>
