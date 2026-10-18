import { checkAppUrl } from "./capture.ts";

const form = document.querySelector("form");
if (!form) {
	throw new Error("Missing options form.");
}
const input = form.elements.namedItem("appUrl");
if (!(input instanceof HTMLInputElement)) {
	throw new Error("Missing URL input.");
}
const output = document.querySelector("output");
if (!output) {
	throw new Error("Missing options output.");
}
try {
	const saved = (await browser.storage.local.get("appUrl")).appUrl;
	input.value = typeof saved === "string" ? saved : "";
} catch (error) {
	console.warn("[i2nclip] extension-options.read-failed", {
		reason: "storage",
	});
	output.textContent = error instanceof Error ? error.message : String(error);
}
form.addEventListener("submit", async (event) => {
	event.preventDefault();
	try {
		const appUrl = checkAppUrl(input.value);
		await browser.storage.local.set({ appUrl });
		input.value = appUrl;
		console.info("[i2nclip] extension-options.saved", {});
		output.textContent = "URL saved.";
	} catch (error) {
		console.warn("[i2nclip] extension-options.save-failed", {
			reason: "validation-or-storage",
		});
		output.textContent = error instanceof Error ? error.message : String(error);
	}
});
