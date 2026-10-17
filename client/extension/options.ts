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
	output.textContent = error instanceof Error ? error.message : String(error);
}
form.addEventListener("submit", async (event) => {
	event.preventDefault();
	try {
		const appUrl = checkAppUrl(input.value);
		await browser.storage.local.set({ appUrl });
		input.value = appUrl;
		output.textContent = "URL saved.";
	} catch (error) {
		output.textContent = error instanceof Error ? error.message : String(error);
	}
});
