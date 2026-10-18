<script lang="ts">
import type { UploadOptions } from "../media/options.ts";
import ImageOptions from "./ImageOptions.svelte";

interface Props {
	options: UploadOptions;
	error: string;
	onchange: (value: UploadOptions) => void;
}
let { options, error, onchange }: Props = $props();
</script>
<section class="panel stack">
	<h2>Upload options</h2>
	<p>Defaults for newly selected files, saved only on this device.</p>
	<h3>Images</h3>
	<ImageOptions
		value={options.image}
		onchange={(image) => onchange({ ...options, image })}
	/>
	{#if error}
		<p class="error" role="alert">{error}</p>
	{/if}
</section>
