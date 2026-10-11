<script>
import Unlock from "./Unlock.svelte";

let { session, pairing, server } = $props();
let code = $state("");
let password = $state("");
let open = $state(false);
const configured = $derived(Boolean($session.wrappedKey));
const disabled = $derived(
	$pairing.active || $session.busy || Boolean($session.pendingRegistration),
);
async function connect(event) {
	event.preventDefault();
	const secret = password;
	const entered = code;
	password = "";
	code = "";
	await pairing.receive(entered, secret, server.trim());
}
</script>

<svelte:element
	this={configured ? "details" : "section"}
	class="panel"
	id="pairing-settings"
>
	{#if configured}
		<summary>Connect another device</summary>
	{:else}
		<h2>Connect existing library</h2>
	{/if}
	<div class="pairing">
		{#if !$pairing.active}
			{#if configured}
				{#if !$session.privateKey}
					<p>Unlock this browser before connecting another device.</p>
					<Unlock
						{session}
						id="pairing-unlock"
						statusId="pairing-unlock-status"
					/>
				{:else}
					<p>
						Give another device full access to this library using a temporary
						code.
					</p>
					<button
						type="button"
						id="pairing-start"
						{disabled}
						onclick={pairing.send}
					>
						Create pairing code
					</button>
				{/if}
			{:else}
				<p>
					Use a code from an unlocked device. Both devices must use the same
					server.
				</p>
				{#if !open}
					<button
						type="button"
						class="secondary"
						{disabled}
						onclick={() => (open = true)}
					>
						Connect existing library
					</button>
				{:else}
					<form id="pairing-receive" onsubmit={connect}>
						<label for="pairing-input">Pairing code</label>
						<input
							id="pairing-input"
							required
							maxlength="32"
							autocomplete="off"
							autocapitalize="characters"
							spellcheck="false"
							placeholder="K7MP-W4TX-N9RC"
							bind:value={code}
							{disabled}
						>
						<label for="pairing-password">Password for this device</label>
						<input
							id="pairing-password"
							type="password"
							required
							minlength="8"
							autocomplete="new-password"
							bind:value={password}
							{disabled}
						>
						<p>
							Use at least 8 characters. This password protects the key saved in
							this browser.
						</p>
						<button type="submit" {disabled}>Connect library</button>
					</form>
				{/if}
			{/if}
		{:else}
			{#if $pairing.code}
				<output id="pairing-code" class="code">{$pairing.code}</output>
			{/if}
			{#if $pairing.verificationCode}
				<div class="verification">
					<label for="pairing-verification-code">Verification code</label>
					<output id="pairing-verification-code" class="code"
						>{$pairing.verificationCode}</output
					>
				</div>
			{/if}
			<p class="address">Server: {$pairing.server}</p>
			<p>Expires in {$pairing.remaining} seconds.</p>
			<div class="actions">
				{#if $pairing.approval && $pairing.verificationCode}
					<button type="button" id="pairing-approve" onclick={pairing.approve}>
						Codes match — send library
					</button>
				{/if}
				{#if $pairing.verificationCode}
					<button
						type="button"
						id="pairing-mismatch"
						class="secondary"
						onclick={pairing.rejectVerification}
					>
						Codes don’t match
					</button>
				{/if}
				<button type="button" class="secondary" onclick={pairing.cancel}>
					Cancel pairing
				</button>
			</div>
		{/if}
		{#if $pairing.status}
			<p
				id="pairing-status"
				class="feedback"
				class:error={$pairing.error}
				role={$pairing.error ? "alert" : "status"}
			>
				{$pairing.status}
			</p>
		{/if}
	</div>
</svelte:element>

<style>
.pairing {
	display: grid;
	gap: 0.75rem;
	margin-top: 0.75rem;
}
.pairing > button {
	justify-self: start;
}
.pairing p {
	margin: 0;
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
