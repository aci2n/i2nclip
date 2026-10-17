import { mount } from "svelte";
import App from "./App.svelte";

const target = document.querySelector("[data-app]");
if (!target) {
	throw new Error("Missing application mount element.");
}
mount(App, { target });
