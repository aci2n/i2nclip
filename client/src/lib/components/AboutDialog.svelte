<script>
import { repository, version } from "../../../package.json";
import { modal } from "../ui/dom.js";

let { open, onclose } = $props();
</script>

<dialog
	use:modal={open}
	aria-label="About i2nclip"
	onclick={(event) => {
		if (event.target === event.currentTarget) {
			onclose();
		}
	}}
	onkeydown={(event) => {
		if (event.key === "Escape") {
			event.preventDefault();
			onclose();
		}
	}}
	oncancel={(event) => {
		event.preventDefault();
		onclose();
	}}
>
	<section class="stack">
		<h2>About i2nclip</h2>
		<p>Version {version}</p>
		<p>
			i2nclip is an encrypted media library. Your files, filenames, tags, and
			previews are encrypted on your device before upload and decrypted on your
			device when you view them. The server stores encrypted data and cannot
			read your media or its details.
		</p>
		<p>
			<a href={repository.url} target="_blank" rel="noopener noreferrer"
				>{repository.url}</a
			>
		</p>
		<button type="button" onclick={onclose}>Close</button>
	</section>
</dialog>

<style>
dialog {
	width: 32rem;
	max-width: calc(100% - 2rem);
	max-height: calc(100% - 2rem);
	padding: 1.5rem;
	border: 1px solid var(--line);
	border-radius: 0.6rem;
	background: var(--paper);
	color: inherit;
}
dialog::backdrop {
	background: #000b;
}
a {
	overflow-wrap: anywhere;
}
</style>
