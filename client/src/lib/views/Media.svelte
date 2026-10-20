<script lang="ts">
import MediaViewer from "../components/MediaViewer.svelte";
import type { ContentStreams } from "../stores/content-streams.ts";
import { createMediaViewer } from "../stores/media-viewer.ts";
import type { LibraryContext } from "../stores/session.ts";

interface Props {
	id: string;
	context: LibraryContext;
	streams: ContentStreams;
}
let { id, context, streams }: Props = $props();
let viewer = $state.raw<ReturnType<typeof createMediaViewer> | null>(null);
$effect(() => {
	const current = createMediaViewer(id, context, { streams });
	viewer = current;
	void current.retry();
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
