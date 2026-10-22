<script lang="ts">
import type { PairingState } from "../stores/pairing.ts";
import PairingProgress from "./PairingProgress.svelte";

interface Props {
	state: PairingState;
	busy: boolean;
	onsend: () => void;
	onapprove: () => void;
	onreject: () => void;
	oncancel: () => void;
}

let { state, busy, onsend, onapprove, onreject, oncancel }: Props = $props();
</script>
<details class="panel">
	<summary>Connect another browser</summary>
	<div class="stack content">
		{#if !state.active}
			<p>
				Give another browser full access to this library using a temporary code.
			</p>
			<button type="button" disabled={busy} onclick={onsend}>
				Create pairing code
			</button>
		{/if}
		<PairingProgress {state} {onapprove} {onreject} {oncancel} />
	</div>
</details>
<style>
.content {
	margin-top: 1rem;
}
</style>
