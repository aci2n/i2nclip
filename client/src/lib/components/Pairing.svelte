<script>
let {
	state: pairingState,
	server,
	configured = false,
	busy = false,
	embedded = false,
	onSend,
	onReceive,
	onApprove,
	onRejectVerification,
	onCancel,
} = $props();
let code = $state("");
let open = $state(false);
const disabled = $derived(pairingState.active || busy);
async function connect(event) {
	event.preventDefault();
	const entered = code;
	code = "";
	await onReceive(entered, server.trim());
}
</script>

<svelte:element
	this={configured ? "details" : "section"}
	class={embedded ? "embedded" : "panel"}
	aria-label={configured ? "Connect another device" : "Pair library"}
>
	{#if configured}
		<summary>Connect another device</summary>
	{:else if !embedded}
		<h2>Connect existing library</h2>
	{/if}
	<div class="pairing" class:embedded>
		{#if !pairingState.active}
			{#if configured}
				<p>
					Give another device full access to this library using a temporary
					code.
				</p>
				<button type="button" {disabled} onclick={onSend}>
					Create pairing code
				</button>
			{:else}
				<p>
					Use a code from an unlocked device. Both devices must use the same
					server.
				</p>
				{#if !open && !embedded}
					<button
						type="button"
						class="secondary"
						{disabled}
						onclick={() => (open = true)}
					>
						Connect existing library
					</button>
				{:else}
					<form class="stack" onsubmit={connect}>
						<label class="field">
							<span>Pairing code</span>
							<input
								required
								maxlength="32"
								autocomplete="off"
								autocapitalize="characters"
								spellcheck="false"
								placeholder="K7MP-W4TX-N9RC"
								bind:value={code}
								{disabled}
							>
						</label>
						<button type="submit" {disabled}>Connect library</button>
					</form>
				{/if}
			{/if}
		{:else}
			{#if pairingState.code}
				<output class="code" aria-label="Pairing code"
					>{pairingState.code}</output
				>
			{/if}
			{#if pairingState.verificationCode}
				<label class="verification">
					<span>Verification code</span>
					<output class="code">{pairingState.verificationCode}</output>
				</label>
			{/if}
			<p class="address">Server: {pairingState.server}</p>
			<p>Expires in {pairingState.remaining} seconds.</p>
			<div class="actions">
				{#if pairingState.approval && pairingState.verificationCode}
					<button type="button" onclick={onApprove}>
						Codes match — send library
					</button>
				{/if}
				{#if pairingState.verificationCode}
					<button
						type="button"
						class="secondary"
						onclick={onRejectVerification}
					>
						Codes don’t match
					</button>
				{/if}
				<button type="button" class="secondary" onclick={onCancel}>
					Cancel pairing
				</button>
			</div>
		{/if}
		{#if pairingState.status}
			<p
				class="feedback pairing-status"
				class:error={pairingState.error}
				role={pairingState.error ? "alert" : "status"}
			>
				{pairingState.status}
			</p>
		{/if}
	</div>
</svelte:element>

<style>
.pairing {
	display: grid;
	gap: 1rem;
	&:not(.embedded) {
		margin-top: 1rem;
	}
	> button {
		justify-self: start;
	}
}
.verification {
	display: flex;
	flex-direction: column;
	gap: 0.5rem;
}
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
