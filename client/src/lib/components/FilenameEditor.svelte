<script>
import { tick } from "svelte";

let { name, disabled = false, onsave } = $props();
let editing = $state(false);
let draft = $state(null);
let saving = $state(false);
let input = $state();
let button = $state();

async function open() {
	draft = name;
	editing = true;
	await tick();
	input?.focus();
	input?.select();
}
async function cancel() {
	if (saving) {
		return;
	}
	draft = null;
	editing = false;
	await tick();
	button?.focus();
}
async function submit(event) {
	event.preventDefault();
	if (disabled || saving) {
		return;
	}
	const submitted = draft.trim();
	saving = true;
	try {
		if (submitted === name || (await onsave(submitted))) {
			const restoreFocus = editing && document.activeElement === input;
			draft = null;
			editing = false;
			saving = false;
			await tick();
			if (restoreFocus) {
				button?.focus();
			}
		}
	} finally {
		saving = false;
	}
}
</script>

{#if editing}
	<form onsubmit={submit}>
		<input
			bind:this={input}
			bind:value={draft}
			aria-label={`Filename for ${name}`}
			required
			pattern=".*\S.*"
			maxlength="255"
			readonly={saving}
			disabled={disabled && !saving}
			onblur={() => {
				draft = null;
				editing = false;
			}}
			onkeydown={(event) => {
				if (event.key === "Escape") {
					event.preventDefault();
					cancel();
				}
			}}
		>
		<button type="submit" hidden>Save filename</button>
	</form>
{:else}
	<button
		bind:this={button}
		type="button"
		class="filename"
		title={name}
		aria-label={`Edit filename ${name}`}
		disabled={disabled || saving}
		onclick={open}
	>
		{name}
	</button>
{/if}

<style>
form,
.filename {
	margin-top: 0.25rem;
	min-height: 2.8em;
}
.filename {
	display: -webkit-box;
	-webkit-line-clamp: 2;
	line-clamp: 2;
	-webkit-box-orient: vertical;
	overflow: hidden;
	overflow-wrap: anywhere;
	line-height: 1.4;
	font-weight: 700;
	text-align: left;
	padding: 0.25rem;
	border: 1px solid transparent;
	border-radius: 0.25rem;
	background: transparent;
	color: inherit;
}
.filename:hover:not(:disabled) {
	border-color: var(--line);
}
input {
	font-weight: 700;
	padding: 0.25rem;
	border-radius: 0.25rem;
}
</style>
