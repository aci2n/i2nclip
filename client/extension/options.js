import { checkAppUrl } from "./capture.js";

const form = document.querySelector("form");
const input = form.elements.namedItem("appUrl");
const output = document.querySelector("output");
try {
	input.value = (await browser.storage.local.get("appUrl")).appUrl || "";
} catch (error) {
	output.textContent = error.message;
}
form.addEventListener("submit", async (event) => {
	event.preventDefault();
	try {
		const appUrl = checkAppUrl(input.value);
		await browser.storage.local.set({ appUrl });
		input.value = appUrl;
		output.textContent = "Saved.";
	} catch (error) {
		output.textContent = error.message;
	}
});
