<script lang="ts">
import {
	type VideoOptions,
	videoCodecs,
	videoQualities,
} from "../media/options.ts";

interface Props {
	value: VideoOptions;
	disabled?: boolean;
	onchange: (value: VideoOptions) => void;
}
let { value, disabled = false, onchange }: Props = $props();
const names = {
	avc: "H.264",
	hevc: "H.265",
	vp8: "VP8",
	vp9: "VP9",
	av1: "AV1",
};
let error = $state("");
$effect(() => {
	void value;
	error = "";
});
function number(
	event: Event & { currentTarget: HTMLInputElement },
	field: "maxWidth" | "maxHeight" | "maxFrameRate",
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
<div class="stack">
	<label class="toggle"
		><input
			type="checkbox"
			{disabled}
			checked={value.enabled}
			onchange={(event) =>
				onchange({ ...value, enabled: event.currentTarget.checked })}
		>Convert video</label
	>
	<fieldset disabled={disabled || !value.enabled}>
		<label
			>Video container
			<select
				value={value.format}
				onchange={(event) => {
					const format = event.currentTarget.value as VideoOptions["format"];
					onchange({
						...value,
						format,
						codec: format === "mp4" ? "avc" : "vp9",
					});
				}}
			>
				<option value="mp4">MP4</option>
				<option value="webm">WebM</option>
			</select>
		</label>
		<label
			>Video codec
			<select
				value={value.codec}
				onchange={(event) =>
					onchange({
						...value,
						codec: event.currentTarget.value as VideoOptions["codec"],
					})}
			>
				{#each videoCodecs[value.format] as codec}
					<option value={codec}>{names[codec]}</option>
				{/each}
			</select>
		</label>
		<label
			>Video quality
			<select
				value={value.quality}
				onchange={(event) =>
					onchange({
						...value,
						quality: event.currentTarget.value as VideoOptions["quality"],
					})}
			>
				{#each videoQualities as quality}
					<option value={quality}>
						{quality
							.replace("very-", "Very ")
							.replace(/^./, (text) => text.toUpperCase())}
					</option>
				{/each}
			</select>
		</label>
		<label
			>Maximum video width (px)<input
				type="number"
				min="1"
				step="1"
				placeholder="Unrestricted"
				value={value.maxWidth ?? ""}
				onchange={(event) => number(event, "maxWidth")}
			></label
		>
		<label
			>Maximum video height (px)<input
				type="number"
				min="1"
				step="1"
				placeholder="Unrestricted"
				value={value.maxHeight ?? ""}
				onchange={(event) => number(event, "maxHeight")}
			></label
		>
		<label
			>Maximum frame rate (fps)<input
				type="number"
				min="0"
				step="any"
				placeholder="Unrestricted"
				value={value.maxFrameRate ?? ""}
				oninput={(event) =>
					event.currentTarget.setCustomValidity(
						event.currentTarget.value !== "" &&
							event.currentTarget.valueAsNumber <= 0
							? "Frame rate must be greater than zero."
							: "",
					)}
				onchange={(event) => number(event, "maxFrameRate")}
			></label
		>
	</fieldset>
	{#if error}
		<p class="error" role="alert">{error}</p>
	{/if}
	<p class="hint">
		Keeps aspect ratio without enlarging and retains audio. Browser support is
		checked during upload. Uses the original if conversion fails, loses tracks,
		or is not smaller.
	</p>
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
.hint {
	color: var(--muted);
	font-size: 0.9rem;
}
@media (max-width: 32rem), (pointer: coarse) {
	.toggle {
		min-height: 3rem;
	}
}
</style>
