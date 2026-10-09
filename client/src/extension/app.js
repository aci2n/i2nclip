import { mount } from "svelte";
import App from "../App.svelte";
import { platform } from "./platform.js";

mount(App, {
	target: document.getElementById("app"),
	props: { platform, page: document.body.dataset.page },
});
