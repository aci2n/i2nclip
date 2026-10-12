<script>
import PairingProgress from "./PairingProgress.svelte";

let { state: pairingState, busy, onreceive, onreject, oncancel } = $props();
let code = $state("");
</script>
<div class="stack">
	{#if !pairingState.active}
		<p>
			Use a code from an unlocked device. Both devices must use the same server.
		</p>
		<form
			class="stack"
			onsubmit={(event) => {
				event.preventDefault();
				onreceive(code);
			}}
		>
			<label class="field"
				>Pairing code<input
					required
					maxlength="32"
					autocomplete="off"
					autocapitalize="characters"
					spellcheck="false"
					placeholder="K7MP-W4TX-N9RC"
					bind:value={code}
					disabled={busy}
				></label
			>
			<button type="submit" disabled={busy}>Connect library</button>
		</form>
	{/if}
	<PairingProgress state={pairingState} {onreject} {oncancel} />
</div>
