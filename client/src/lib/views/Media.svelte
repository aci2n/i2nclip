<script lang="ts">
import MediaViewer from "../components/MediaViewer.svelte";
import { createMediaViewer } from "../stores/media-viewer.ts";
import type { LibraryContext } from "../stores/session.ts";

interface Props {
	id: string;
	context: LibraryContext;
}
let { id, context }: Props = $props();
let viewer = $state.raw<ReturnType<typeof createMediaViewer> | null>(null);
$effect(() => {
	const current = createMediaViewer(id, context);
	viewer = current;
	return () => current.dispose();
});
</script>
{#if $viewer}
	<MediaViewer
		value={$viewer}
		onretry={() => {
			void viewer?.retry();
		}}
		ondownload={() => {
			void viewer?.download();
		}}
	/>
{/if}
