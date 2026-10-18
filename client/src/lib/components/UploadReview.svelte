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
				<article class="stack">
					<div class="file">
						<p class="name">
							{entry.file.name} <span>({fileSize(entry.file.size)})</span>
						</p>
						<button
							type="button"
							class="secondary"
							disabled={busy}
							onclick={() => onremove(entry.key)}
							aria-label={`Remove ${entry.file.name}`}
						>
							Remove
						</button>
					</div>
					{#if canConvertImage(entry.file) || canConvertVideo(entry.file)}
						<details>
							<summary>Upload options</summary>
							<div class="stack options">
								{#if canConvertImage(entry.file)}
									<ImageOptions
										value={entry.options.image}
										disabled={busy}
										onchange={(image) =>
											onchange(entry.key, { ...entry.options, image })}
									/>
								{:else}
									<VideoOptions
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
						<p>Uploads unchanged.</p>
					{/if}
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
article + article {
	border-top: 1px solid var(--line);
	padding-top: 1rem;
}
.file {
	display: flex;
	align-items: start;
	justify-content: space-between;
	gap: 1rem;
}
.name {
	min-width: 0;
	overflow-wrap: anywhere;
}
.name span {
	color: var(--muted);
}
.options {
	margin-top: 1rem;
}
.defaults {
	align-self: start;
}
.actions {
	display: flex;
	flex-wrap: wrap;
	gap: 0.5rem;
}
</style>
