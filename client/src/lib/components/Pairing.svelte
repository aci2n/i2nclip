<script>
let {
	state,
	server,
	configured = false,
	busy = false,
	idPrefix,
	embedded = false,
	onSend,
	onReceive,
	onApprove,
	onRejectVerification,
	onCancel,
} = $props();
const id = (suffix) => `${idPrefix}-${suffix}`;
let code = $state("");
let open = $state(false);
const disabled = $derived(state.active || busy);
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
	id={id("settings")}
>
	{#if configured}
		<summary>Connect another device</summary>
	{:else if !embedded}
		<h2>Connect existing library</h2>
	{/if}
	<div class="pairing" class:embedded>
		{#if !state.active}
			{#if configured}
				<p>
					Give another device full access to this library using a temporary
					code.
				</p>
				<button type="button" id={id("start")} {disabled} onclick={onSend}>
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
					<form class="stack" id={id("receive")} onsubmit={connect}>
						<div class="field">
							<label for={id("input")}>Pairing code</label>
							<input
								id={id("input")}
								required
								maxlength="32"
								autocomplete="off"
								autocapitalize="characters"
								spellcheck="false"
								placeholder="K7MP-W4TX-N9RC"
								bind:value={code}
								{disabled}
							>
						</div>
						<button type="submit" {disabled}>Connect library</button>
					</form>
				{/if}
			{/if}
		{:else}
			{#if state.code}
				<output id={id("code")} class="code">{state.code}</output>
			{/if}
			{#if state.verificationCode}
				<div class="verification">
					<label for={id("verification-code")}>Verification code</label>
					<output id={id("verification-code")} class="code"
						>{state.verificationCode}</output
					>
				</div>
			{/if}
			<p class="address">Server: {state.server}</p>
			<p>Expires in {state.remaining} seconds.</p>
			<div class="actions">
				{#if state.approval && state.verificationCode}
					<button type="button" id={id("approve")} onclick={onApprove}>
						Codes match — send library
					</button>
				{/if}
				{#if state.verificationCode}
					<button
						type="button"
						id={id("mismatch")}
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
		{#if state.status}
			<p
				id={id("status")}
				class="feedback"
				class:error={state.error}
				role={state.error ? "alert" : "status"}
			>
				{state.status}
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
