<script lang="ts">
import type { PairingState } from "../stores/pairing.ts";

interface Props {
	state: PairingState;
	busy: boolean;
	onsend: () => unknown;
	onapprove: () => unknown;
	onreject: () => unknown;
	oncancel: () => unknown;
}

import PairingProgress from "./PairingProgress.svelte";

let { state, busy, onsend, onapprove, onreject, oncancel }: Props = $props();
</script>
<details class="panel">
	<summary>Connect another device</summary>
	<div class="stack content">
		{#if !state.active}
			<p>
				Give another device full access to this library using a temporary code.
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
