<script lang="ts">
import { passwordStrength } from "../ui/password-strength.ts";

interface Props {
	password: string;
}

let { password }: Props = $props();
const messages = {
	weak: "Weak. Someone who copies this browser's data could guess it. Use 12 or more characters, such as a few unrelated words.",
	fair: "Fair. A longer passphrase is stronger.",
	good: "Strong.",
};
const strength = $derived(passwordStrength(password));
</script>

{#if password}
	<p class="strength" class:weak={strength === "weak"}>{messages[strength]}</p>
{/if}

<style>
.strength {
	margin: 0;
	font-size: var(--text-sm);
}
.weak {
	color: var(--error);
}
</style>
