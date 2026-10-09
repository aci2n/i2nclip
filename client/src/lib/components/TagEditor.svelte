<script>
import { tick } from "svelte";
import { splitTags } from "../crypto.js";

let { tags = [], disabled = false, name, onsave } = $props();
let editing = $state(false);
let value = $state("");
let saving = $state(false);
let input = $state();
let addButton = $state();
let blurWhileSaving = false;
const locked = $derived(disabled || saving);

async function open() {
	editing = true;
	await tick();
	input?.focus();
}
async function cancel() {
	if (locked) return;
	editing = false;
	value = "";
	await tick();
	addButton?.focus();
}
function focusOut(event) {
	if (!editing || event.currentTarget.contains(event.relatedTarget)) return;
	if (saving) {
		blurWhileSaving = true;
	} else {
		editing = false;
		value = "";
	}
}
async function persist(next, clearDraft = false) {
	if (locked) return;
	const submitted = value;
	blurWhileSaving = false;
	if (editing) input?.focus();
	saving = true;
	try {
		if ((await onsave(next)) && clearDraft && value === submitted) value = "";
	} finally {
		saving = false;
		if (blurWhileSaving) {
			editing = false;
			value = "";
		}
		await tick();
		if (editing) input?.focus();
	}
}
function save(event) {
	event.preventDefault();
	if (splitTags(value).length) persist([...tags, value], true);
}
</script>

<fieldset
	class="tag-list"
	aria-label={`Tags for ${name}`}
	onfocusout={focusOut}
>
	{#each tags as tag}
		<span class="chip tag"
			><span class="tag-text">{tag}</span
			><button
				type="button"
				aria-label={`Remove tag ${tag}`}
				disabled={locked}
				onclick={() => persist(tags.filter((existing) => existing !== tag))}
			>
				×
			</button></span
		>
	{/each}
	{#if editing}
		<form class="tags" onsubmit={save}>
			<div class="entry">
				<input
					class="chip"
					bind:this={input}
					bind:value
					disabled={disabled && !saving}
					aria-label={`New tag for ${name}`}
					placeholder="New tag"
					autocomplete="on"
					onkeydown={(event) => {
						if (event.key === "Escape") {
							event.preventDefault();
							cancel();
						}
					}}
				>
				<button
					class="chip"
					type="submit"
					aria-label="Save tag"
					disabled={locked || !splitTags(value).length}
				>
					✓
				</button>
				<button
					class="chip"
					type="button"
					aria-label="Cancel adding tag"
					disabled={locked}
					onclick={cancel}
				>
					×
				</button>
			</div>
		</form>
	{:else}
		<button
			bind:this={addButton}
			class="chip"
			type="button"
			aria-label={`Add tag to ${name}`}
			disabled={locked}
			onclick={open}
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
}
.tag-list {
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
