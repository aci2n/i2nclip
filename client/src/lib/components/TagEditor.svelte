<script>
import { tick } from "svelte";
import { splitTags } from "../protocol/tags.js";
import TagInput from "./TagInput.svelte";

let { tags = [], suggestions = [], disabled = false, name, onsave } = $props();
let editing = $state(false);
let expanded = $state(false);
let draft = $state("");
let saving = $state(false);
let input = $state();
let button = $state();
const locked = $derived(disabled || saving);
async function open() {
	editing = true;
	await tick();
	input?.focus();
}
async function cancel() {
	if (locked) {
		return;
	}
	editing = false;
	draft = "";
	await tick();
	button?.focus();
}
async function persist(next, clear = false) {
	if (locked) {
		return;
	}
	const submitted = draft;
	saving = true;
	try {
		if ((await onsave(next)) && clear && draft === submitted) {
			draft = "";
		}
	} finally {
		saving = false;
		await tick();
		input?.focus();
	}
}
</script>

<fieldset class="tag-list" aria-label={`Tags for ${name}`}>
	{#each expanded ? tags : tags.slice(0, 6) as tag}
		<span class="chip tag"
			><span class="tag-text">{tag}</span
			><button
				type="button"
				aria-label={`Remove tag ${tag}`}
				disabled={locked}
				onclick={() => persist(tags.filter((existing) => existing !== tag))}
			>
				<svg
					viewBox="0 0 24 24"
					aria-hidden="true"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"
					stroke-linejoin="round"
				>
					<path d="M6 6l12 12M18 6L6 18" />
				</svg>
			</button></span
		>
	{/each}
	{#if tags.length > 6}
		<button
			type="button"
			class="chip"
			aria-expanded={expanded}
			onclick={() => (expanded = !expanded)}
		>
			{expanded ? "Show fewer tags" : "Show all tags"}
		</button>
	{/if}
	{#if editing}
		<form
			class="tags"
			onsubmit={(event) => {
				event.preventDefault();
				if (!locked) {
					persist([...tags, draft], true);
				}
			}}
		>
			<div class="entry">
				<TagInput
					value={draft}
					{suggestions}
					excluded={tags}
					label={`New tag for ${name}`}
					disabled={disabled && !saving}
					readonly={locked}
					onchange={(value) => {
						draft = value;
					}}
					oncommit={(value) => {
						draft = value;
						void persist([...tags, value], true);
					}}
					onescape={cancel}
					onready={(node) => {
						input = node;
					}}
				/>
				<button
					class="chip"
					type="submit"
					aria-label="Save tag"
					disabled={locked || !splitTags(draft).length}
				>
					<svg
						viewBox="0 0 24 24"
						aria-hidden="true"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
						stroke-linejoin="round"
					>
						<path d="M5 13l4 4L19 7" />
					</svg>
				</button>
				<button
					class="chip"
					type="button"
					aria-label="Cancel adding tag"
					disabled={locked}
					onclick={cancel}
				>
					<svg
						viewBox="0 0 24 24"
						aria-hidden="true"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
						stroke-linejoin="round"
					>
						<path d="M6 6l12 12M18 6L6 18" />
					</svg>
				</button>
			</div>
		</form>
	{:else}
		<button
			bind:this={button}
			class="chip"
			type="button"
			aria-label={`Add tag to ${name}`}
			disabled={locked}
			onclick={open}
		>
			<svg
				viewBox="0 0 24 24"
				aria-hidden="true"
				fill="none"
				stroke="currentColor"
				stroke-width="2"
				stroke-linecap="round"
				stroke-linejoin="round"
			>
				<path d="M12 5v14M5 12h14" />
			</svg>
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
	min-height: 2rem;
	line-height: 1.5;
	padding: 0.125rem 0.375rem;
	border: 0;
	border-radius: 0.25rem;
	background: var(--soft);
	color: var(--accent);
	font-size: 0.85rem;
}
.tag-list button {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	line-height: inherit;
}
.tag-list button svg {
	width: 1rem;
	height: 1rem;
	flex: none;
}
.tag-text {
	min-width: 0;
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
.entry button {
	flex: none;
}
@media (max-width: 32rem), (pointer: coarse) {
	.tag-list {
		gap: 0.5rem;
	}
	.chip {
		min-height: 3rem;
		font-size: 1rem;
	}
	.tag {
		padding-block: 0;
	}
	.tag button {
		min-width: 3rem;
		min-height: 3rem;
		font-size: 1rem;
	}
	.tag-list > button,
	.entry button {
		min-width: 3rem;
	}
	.entry {
		gap: 0.5rem;
	}
}
</style>
