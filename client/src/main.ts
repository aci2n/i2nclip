import { mount } from "svelte";
import App from "./App.svelte";
import { requireValue } from "./lib/required.ts";

mount(App, { target: requireValue(document.querySelector("[data-app]")) });
