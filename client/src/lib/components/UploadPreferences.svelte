<script lang="ts">
import type { UploadOptions } from "../media/options.ts";
import ImageOptions from "./ImageOptions.svelte";
import VideoOptions from "./VideoOptions.svelte";

interface Props {
	options: UploadOptions;
	error: string;
	onchange: (value: UploadOptions) => void;
}
let { options, error, onchange }: Props = $props();
</script>
<details class="panel">
	<summary>Upload options</summary>
	<div class="stack content">
		<p>Defaults for newly selected files, saved only on this device.</p>
		<h3>Images</h3>
		<ImageOptions
			value={options.image}
			onchange={(image) => onchange({ ...options, image })}
		/>
		<h3>Videos</h3>
		<VideoOptions
			value={options.video}
			onchange={(video) => onchange({ ...options, video })}
		/>
		{#if error}
			<p class="error" role="alert">{error}</p>
		{/if}
	</div>
</details>
<style>
.content {
	margin-top: 1rem;
}
</style>
