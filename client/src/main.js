import { mount } from "svelte";
import App from "./App.svelte";
import { webPlatform } from "./lib/platform/web.js";

mount(App, {
	target: document.getElementById("app"),
	props: { platform: webPlatform },
});
