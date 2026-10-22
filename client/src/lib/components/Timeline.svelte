<script lang="ts">
import type { TimelineItem } from "../stores/history.ts";

interface Props {
	items: readonly TimelineItem[];
	more: boolean;
	viewing: number | null;
	undoing: number | null;
	busy: boolean;
	onview: (sequence: number) => void;
	onundo: (sequence: number) => void;
	onmore: () => void;
}
let { items, more, viewing, undoing, busy, onview, onundo, onmore }: Props =
	$props();
const ACTIONS: Record<TimelineItem["action"], string> = {
	AddFile: "Added",
	ReplaceMetadata: "Edited details of",
	DeleteFile: "Deleted",
	RestoreFile: "Restored",
	PurgeFile: "Permanently deleted",
};
function when(time: number) {
	return new Date(time).toLocaleString(undefined, {
		dateStyle: "medium",
		timeStyle: "short",
	});
}
</script>
<ol class="timeline">
	{#each items as item, index (item.sequence)}
		<li class:viewing={viewing === item.sequence}>
			<div class="summary">
				<p class="action">
					{ACTIONS[item.action]} <span class="name">{item.name}</span>
				</p>
				<p class="meta">
					Version {item.sequence} ·
					<time datetime={new Date(item.time).toISOString()}
						>{when(item.time)}</time
					>{index === 0 ? " · Current" : ""}
				</p>
				{#if undoing === item.sequence}
					<p role="status">Undoing…</p>
				{:else if item.error}
					<p class="error" role="alert">{item.error}</p>
				{/if}
			</div>
			<div class="cluster">
				<button
					type="button"
					class="secondary"
					disabled={busy || viewing === item.sequence}
					onclick={() => onview(item.sequence)}
				>
					View
				</button>
				{#if item.undoable}
					<button
						type="button"
						class="secondary"
						onclick={() => onundo(item.sequence)}
					>
						Undo
					</button>
				{/if}
			</div>
		</li>
	{/each}
	{#if !more}
		<li class:viewing={viewing === 0}>
			<div class="summary">
				<p class="action">Library created</p>
				<p class="meta">Version 0</p>
			</div>
			<div class="cluster">
				<button
					type="button"
					class="secondary"
					disabled={busy || viewing === 0}
					onclick={() => onview(0)}
				>
					View
				</button>
			</div>
		</li>
	{/if}
</ol>
{#if more}
	<button type="button" class="secondary more" onclick={onmore}>
		Show older
	</button>
{/if}
<style>
.timeline {
	margin: 0;
	padding: 0;
	list-style: none;
}
li {
	display: flex;
	align-items: center;
	justify-content: space-between;
	flex-wrap: wrap;
	gap: var(--space-2) var(--space-4);
	padding: var(--space-3) 0 var(--space-3) var(--space-4);
	border-left: 2px solid var(--line);
	position: relative;
}
li::before {
	content: "";
	position: absolute;
	left: calc(-0.375rem - 1px);
	top: calc(var(--space-3) + 0.375rem);
	width: 0.75rem;
	height: 0.75rem;
	border-radius: 50%;
	background: var(--paper);
	border: 2px solid var(--muted);
	box-sizing: border-box;
}
li.viewing::before {
	background: var(--accent);
	border-color: var(--accent);
}
.summary {
	flex: 1 1 14rem;
	min-width: 0;
}
.action {
	margin: 0;
	overflow-wrap: anywhere;
}
.name {
	font-weight: 600;
}
.meta {
	margin: 0;
	color: var(--muted);
	font-size: var(--text-sm);
}
.error {
	margin: var(--space-1) 0 0;
}
.more {
	display: block;
	margin: var(--space-4) auto 0;
}
</style>
