<script lang="ts" module>
export type SetupChoice = "create" | "restore" | "connect";
</script>
<script lang="ts">
interface Props {
	busy: boolean;
	onchoose: (choice: SetupChoice) => void;
}
let { busy, onchoose }: Props = $props();
const choices: { choice: SetupChoice; title: string; detail: string }[] = [
	{
		choice: "create",
		title: "Create a new library",
		detail: "Start fresh. You’ll need an invitation code.",
	},
	{
		choice: "restore",
		title: "Restore from a backup",
		detail: "Use a backup file and its password.",
	},
	{
		choice: "connect",
		title: "Connect from another device",
		detail: "Copy access from a browser that already has your library.",
	},
];
</script>
<div class="stack">
	<div class="choices">
		{#each choices as { choice, title, detail }}
			<button
				type="button"
				class="secondary"
				disabled={busy}
				onclick={() => onchoose(choice)}
			>
				<span class="title">{title}</span>
				<span class="detail">{detail}</span>
			</button>
		{/each}
	</div>
	<p>
		Files are encrypted in this browser before upload. Every connected browser
		has full access.
	</p>
</div>
<style>
.choices {
	display: flex;
	flex-direction: column;
	gap: var(--space-3);
}
button {
	display: flex;
	flex-direction: column;
	align-items: flex-start;
	gap: var(--space-1);
	padding: var(--space-3) var(--space-4);
	text-align: left;
}
.title {
	font-weight: 600;
}
.detail {
	color: var(--muted);
	font-size: var(--text-sm);
}
</style>
