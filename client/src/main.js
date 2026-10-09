import { mount } from "svelte";
import App from "./App.svelte";
import { webPlatform } from "./lib/web-platform.js";

mount(App, {
	target: document.getElementById("app"),
	props: { platform: webPlatform },
});
