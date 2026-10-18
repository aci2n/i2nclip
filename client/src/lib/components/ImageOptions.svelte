<script lang="ts">
import type { ImageOptions } from "../media/options.ts";

interface Props {
	value: ImageOptions;
	onchange: (value: ImageOptions) => void;
	disabled?: boolean;
	compact?: boolean;
}
let { value, onchange, disabled = false, compact = false }: Props = $props();
let error = $state("");
$effect(() => {
	void value;
	error = "";
});
function number(
	event: Event & { currentTarget: HTMLInputElement },
	field: "quality" | "maxWidth" | "maxHeight",
) {
	const input = event.currentTarget;
	if (!input.validity.valid) {
		error = input.validationMessage;
		return;
	}
	error = "";
	onchange({
		...value,
		[field]: input.value === "" ? null : input.valueAsNumber,
	});
}
</script>
<div class="stack" class:compact>
	<label class="toggle">
		<input
			type="checkbox"
			{disabled}
			checked={value.enabled}
			onchange={(event) =>
				onchange({ ...value, enabled: event.currentTarget.checked })}
		>
		Convert image
	</label>
	<fieldset disabled={disabled || !value.enabled}>
		<label
			>Output format
			<select
				value={value.format}
				onchange={(event) =>
					onchange({
						...value,
						format: event.currentTarget.value as ImageOptions["format"],
					})}
			>
				<option value="webp">WebP</option>
				<option value="jpeg">JPEG</option>
				<option value="png">PNG</option>
			</select>
		</label>
		{#if value.format !== "png"}
			<label
				>Quality (0–100)
				<input
					type="number"
					min="0"
					max="100"
					step="any"
					required
					value={value.quality}
					onchange={(event) => number(event, "quality")}
				>
			</label>
		{/if}
		<label
			>Maximum width (px)
			<input
				type="number"
				min="1"
				step="1"
				placeholder="Unrestricted"
				value={value.maxWidth ?? ""}
				onchange={(event) => number(event, "maxWidth")}
			>
		</label>
		<label
			>Maximum height (px)
			<input
				type="number"
				min="1"
				step="1"
				placeholder="Unrestricted"
				value={value.maxHeight ?? ""}
				onchange={(event) => number(event, "maxHeight")}
			>
		</label>
	</fieldset>
	{#if error}
		<p class="error" role="alert">{error}</p>
	{/if}
	{#if !compact}
		<p class="hint">
			Keeps aspect ratio without enlarging. Uses the original if conversion
			fails or is not smaller.
		</p>
	{/if}
	{#if value.format === "jpeg"}
		<p class="hint">Transparency becomes white in JPEG.</p>
	{/if}
</div>
<style>
fieldset {
	border: 0;
	padding: 0;
	margin: 0;
	min-width: 0;
	display: grid;
	grid-template-columns: repeat(auto-fit, minmax(min(12rem, 100%), 1fr));
	gap: 1rem;
}
label {
	display: flex;
	flex-direction: column;
	gap: 0.5rem;
	min-width: 0;
}
.toggle {
	flex-direction: row;
	align-items: center;
}
.toggle input {
	width: auto;
	flex: none;
}
@media (max-width: 32rem), (pointer: coarse) {
	.toggle {
		min-height: 3rem;
	}
}
.hint {
	color: var(--muted);
	font-size: 0.9rem;
}
.compact {
	gap: 0.5rem;
}
.compact fieldset {
	align-items: end;
	gap: 0.5rem;
	grid-template-columns: repeat(auto-fit, minmax(min(10rem, 100%), 1fr));
}
</style>
