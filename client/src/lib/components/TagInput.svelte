<script>
import { tick } from "svelte";
import { tagSuggestions } from "../ui/tag-suggestions.js";

let {
	value = "",
	suggestions = [],
	excluded = [],
	label,
	placeholder = "New tag",
	disabled = false,
	readonly = false,
	borderless = false,
	search = false,
	onchange,
	oncommit,
	onemptybackspace,
	onescape = () => {},
	onready = () => {},
} = $props();
let input = $state();
let list = $state();
let open = $state(false);
const matches = $derived(
	open && !disabled && !readonly
		? tagSuggestions(suggestions, value, excluded)
		: [],
);
$effect(() => {
	onready(input);
});
function commit(tag) {
	if (disabled || readonly) {
		return;
	}
	open = false;
	oncommit(tag);
	input?.focus();
}
function dismiss() {
	input?.focus();
	open = false;
}
function focusSuggestion(index) {
	list?.querySelectorAll("button")[index]?.focus();
}
</script>
<div
	class="tag-input"
	onfocusout={(event) => {
		if (!event.currentTarget.contains(event.relatedTarget)) {
			open = false;
		}
	}}
>
	<input
		bind:this={input}
		type={search ? "search" : "text"}
		class:borderless={borderless}
		{value}
		{disabled}
		{readonly}
		{placeholder}
		aria-label={label}
		autocomplete="off"
		onfocus={() => {
			open = true;
		}}
		oninput={(event) => {
			open = true;
			onchange(event.currentTarget.value);
		}}
		onkeydown={(event) => {
			if (event.isComposing) {
				return;
			}
			if (
				event.key === "Backspace" &&
				!event.currentTarget.value &&
				!readonly &&
				!disabled &&
				onemptybackspace
			) {
				event.preventDefault();
				onemptybackspace();
			} else if (event.key === "ArrowDown" && !readonly && !disabled) {
				event.preventDefault();
				open = true;
				void tick().then(() => focusSuggestion(0));
			} else if (event.key === "Enter") {
				event.preventDefault();
				if (value.trim()) {
					commit(value);
				}
			} else if (event.key === "Escape") {
				event.preventDefault();
				if (matches.length) {
					dismiss();
				} else {
					onescape();
				}
			}
		}}
	>
	{#if matches.length}
		<!-- Keep Tab on suggestions rather than the scrolling container. -->
		<ul bind:this={list} tabindex="-1" aria-label="Tag suggestions">
			{#each matches as tag, index}
				<li>
					<button
						type="button"
						onclick={() => commit(tag)}
						onfocus={(event) =>
							event.currentTarget.scrollIntoView({
								block: "nearest",
								inline: "nearest",
							})}
						onkeydown={(event) => {
							if (event.key === "ArrowDown") {
								event.preventDefault();
								focusSuggestion(Math.min(index + 1, matches.length - 1));
							} else if (event.key === "ArrowUp") {
								event.preventDefault();
								if (index === 0) {
									input?.focus();
								} else {
									focusSuggestion(index - 1);
								}
							} else if (event.key === "Escape") {
								event.preventDefault();
								dismiss();
							}
						}}
					>
						{tag}
					</button>
				</li>
			{/each}
		</ul>
	{/if}
</div>
<style>
.tag-input {
	position: relative;
	flex: 1 1 7rem;
	min-width: 0;
}
input {
	min-height: 3rem;
}
input.borderless {
	min-height: 2.5rem;
	border: 0;
	background: transparent;
	box-shadow: none;
}
input.borderless:focus-visible {
	outline: none;
}
input::-webkit-search-cancel-button {
	display: none;
}
ul {
	position: absolute;
	top: 100%;
	left: 0;
	min-width: 100%;
	width: max-content;
	max-width: min(24rem, 100%);
	max-height: min(15rem, 40dvh);
	overflow-y: auto;
	overscroll-behavior: contain;
	z-index: 5;
	list-style: none;
	margin: 0;
	padding: 0.25rem;
	border: 1px solid var(--line);
	border-radius: 0.25rem;
	background: var(--paper);
	box-shadow: 0 0.25rem 0.75rem #0002;
}
li button {
	display: block;
	width: 100%;
	min-height: 3rem;
	padding: 0.5rem 0.75rem;
	text-align: left;
	color: var(--accent);
	background: transparent;
	overflow-wrap: anywhere;
}
li button:hover,
li button:focus-visible {
	background: var(--soft);
	color: var(--accent);
}
@media (max-width: 32rem), (pointer: coarse) {
	input.borderless {
		min-height: 3rem;
	}
}
</style>
