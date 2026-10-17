<script lang="ts">
import type { PairingState } from "../stores/pairing.ts";

interface Props {
	state: PairingState;
	onapprove?: () => unknown;
	onreject: () => unknown;
	oncancel: () => unknown;
}
let { state, onapprove, onreject, oncancel }: Props = $props();
</script>
{#if state.active}
	<div class="stack">
		{#if state.code}
			<output class="code" aria-label="Pairing code">{state.code}</output>
		{/if}
		{#if state.verificationCode}
			<label class="field"
				><span>Verification code</span
				><output class="code" aria-label="Verification code"
					>{state.verificationCode}</output
				></label
			>
		{/if}
		<p class="address">Server: {state.server}</p>
		<p>Expires in {state.remaining} seconds.</p>
		<div class="actions">
			{#if state.approval && state.verificationCode}
				<button type="button" onclick={onapprove}>
					Codes match — send library
				</button>
			{/if}
			{#if state.verificationCode}
				<button type="button" class="secondary" onclick={onreject}>
					Codes don’t match
				</button>
			{/if}
			<button type="button" class="secondary" onclick={oncancel}>
				Cancel pairing
			</button>
		</div>
	</div>
{/if}
{#if state.status}
	<p
		class="feedback"
		class:error={state.error}
		role={state.error ? "alert" : "status"}
	>
		{state.status}
	</p>
{/if}
<style>
.code {
	font-family: monospace;
	font-size: 1.25rem;
	letter-spacing: 0.05em;
	overflow-wrap: anywhere;
	user-select: all;
}
.address {
	overflow-wrap: anywhere;
}
.actions {
	display: flex;
	flex-wrap: wrap;
	gap: 0.75rem;
}
</style>
