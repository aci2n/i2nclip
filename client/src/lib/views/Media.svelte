<script lang="ts">
import type { Snippet } from "svelte";
import { onDestroy } from "svelte";
import MediaViewer from "../components/MediaViewer.svelte";
import type { Library } from "../stores/library.ts";

interface Props {
	id: string;
	library: Library;
	actions?: Snippet;
}
let { id, library, actions }: Props = $props();
$effect(() => {
	void library.reveal(id);
});
onDestroy(() => library.closePreview());
</script>
<MediaViewer
	value={{
		media: $library.preview,
		loading:
			(!$library.preview && !$library.status) ||
			Boolean($library.preview?.busy),
		error: $library.preview?.error ? $library.preview.message : $library.status,
	}}
	onretry={() => library.reveal(id)}
	ondownload={() => library.download(id)}
	{actions}
/>
