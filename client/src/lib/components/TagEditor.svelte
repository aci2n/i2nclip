<script>
import { onDestroy, untrack } from "svelte";
import { splitTags } from "../protocol/crypto.js";
import { focus } from "../stores/dom.js";
import { createTagEditor } from "../stores/tag-editor.js";

let { tags = [], disabled = false, name, onsave } = $props();
const editor = untrack(() => createTagEditor((next) => onsave(next)));
const locked = $derived(disabled || $editor.saving);
onDestroy(editor.dispose);
</script>

<fieldset
	class="tag-list"
	aria-label={`Tags for ${name}`}
	onfocusout={(event) => {
		if (!event.currentTarget.contains(event.relatedTarget)) editor.blur();
	}}
>
	{#each tags as tag}
		<span class="chip tag"
			><span class="tag-text">{tag}</span
			><button
				type="button"
				aria-label={`Remove tag ${tag}`}
				disabled={locked}
				onclick={() =>
					editor.remove(tags.filter((existing) => existing !== tag))}
			>
				×
			</button></span
		>
	{/each}
	{#if $editor.editing}
		<form
			class="tags"
			onsubmit={(event) => {
				event.preventDefault();
				if (!locked) editor.add(tags);
			}}
		>
			<div class="entry">
				<input
					class="chip"
					use:focus={$editor.inputFocus}
					bind:value={() => $editor.value, editor.edit}
					disabled={disabled && !$editor.saving}
					aria-label={`New tag for ${name}`}
					placeholder="New tag"
					autocomplete="on"
					onkeydown={(event) => {
						if (event.key === "Escape") {
							event.preventDefault();
							if (!locked) editor.cancel();
						}
					}}
				>
				<button
					class="chip"
					type="submit"
					aria-label="Save tag"
					disabled={locked || !splitTags($editor.value).length}
				>
					✓
				</button>
				<button
					class="chip"
					type="button"
					aria-label="Cancel adding tag"
					disabled={locked}
					onclick={editor.cancel}
				>
					×
				</button>
			</div>
		</form>
	{:else}
		<button
			use:focus={$editor.buttonFocus}
			class="chip"
			type="button"
			aria-label={`Add tag to ${name}`}
			disabled={locked}
			onclick={editor.open}
		>
			+
		</button>
	{/if}
</fieldset>

<style>
.tag-list {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 0.25rem;
	min-width: 0;
	border: 0;
	padding: 0;
	margin: 0;
	min-height: 2rem;
	font-size: 0.85rem;
}
.chip {
	display: inline-flex;
	align-items: center;
	gap: 0.25rem;
	max-width: 100%;
	padding: 0.125rem 0.375rem;
	border: 0;
	border-radius: 0.25rem;
	background: var(--soft);
	color: var(--accent);
	font-size: 0.85rem;
}
.tag-text {
	overflow-wrap: anywhere;
}
.tag button {
	padding: 0 0.125rem;
	border: 0;
	background: transparent;
	color: var(--accent);
	font-size: 0.85rem;
	flex: none;
}
.tags {
	display: grid;
	gap: 0.5rem;
	flex: 1 1 100%;
	min-width: 0;
}
.entry {
	display: flex;
	align-items: center;
	gap: 0.25rem;
}
.entry input {
	flex: 1;
	width: 0;
}
.entry button {
	flex: none;
}
</style>
