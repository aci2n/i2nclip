<script lang="ts">
import { tick } from "svelte";
import { splitTags } from "../protocol/tags.ts";
import TagChip from "./TagChip.svelte";
import TagInput from "./TagInput.svelte";

interface Props {
	tags?: string[];
	suggestions?: string[];
	disabled?: boolean;
	name: string;
	revision: string;
	onsearch: (tag: string) => void;
	onsave: (tags: string[], revision: string) => Promise<boolean>;
}

let {
	tags = [],
	suggestions = [],
	disabled = false,
	name,
	revision,
	onsearch,
	onsave,
}: Props = $props();
let editing = $state(false);
let sourceRevision = $state("");
let expanded = $state(false);
let draft = $state("");
let saving = $state(false);
let input = $state<HTMLInputElement>();
let button = $state<HTMLButtonElement>();
const locked = $derived(disabled || saving);
async function open() {
	editing = true;
	sourceRevision = revision;
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
async function persist(next: string[], clear = false) {
	if (locked) {
		return;
	}
	const submitted = draft;
	saving = true;
	try {
		if (
			(await onsave(next, editing ? sourceRevision : revision)) &&
			clear &&
			draft === submitted
		) {
			draft = "";
		}
	} finally {
		sourceRevision = revision;
		saving = false;
		await tick();
		input?.focus();
	}
}
</script>

<fieldset class="tag-list" aria-label={`Tags for ${name}`}>
	{#each expanded ? tags : tags.slice(0, 6) as tag}
		<TagChip
			text={tag}
			removeLabel={`Remove tag ${tag}`}
			disabled={locked}
			onselect={() => onsearch(tag)}
			onremove={() => persist(tags.filter((existing) => existing !== tag))}
		/>
	{/each}
	<span class="tag-actions">
		{#if !editing}
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
		{#if tags.length > 6}
			<button
				type="button"
				class="chip disclosure"
				aria-label={expanded ? "Show fewer tags" : "Show all tags"}
				aria-expanded={expanded}
				onclick={() => (expanded = !expanded)}
			>
				{expanded ? "Fewer tags" : `+${tags.length - 6} more`}
			</button>
		{/if}
	</span>
	{#if editing}
		<form
			class="tags"
			onsubmit={(event) => {
				event.preventDefault();
				persist([...tags, draft], true);
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
	{/if}
</fieldset>

<style>
.tag-list {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--space-2);
	min-height: var(--target);
	font-size: var(--text-sm);
}
.tag-actions {
	display: inline-flex;
	align-items: center;
	gap: var(--space-2);
}
.disclosure {
	background: transparent;
	color: var(--muted);
}
.tag-list button {
	justify-content: center;
	min-width: var(--target);
}
.tag-list button svg {
	width: 1rem;
	height: 1rem;
	flex: none;
}
.tags {
	display: grid;
	gap: var(--space-2);
	flex: 1 1 100%;
	min-width: 0;
}
.entry {
	display: flex;
	align-items: center;
	gap: var(--space-2);
}
.entry button {
	flex: none;
}
</style>
