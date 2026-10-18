import { fileURLToPath } from "node:url";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";
import { buildStreamingWorker } from "./streaming.config.ts";

export default defineConfig({
	plugins: [
		svelte({ configFile: false }),
		{
			name: "streaming-worker",
			apply: "build",
			async closeBundle() {
				await buildStreamingWorker(
					fileURLToPath(new URL("./dist/web", import.meta.url)),
				);
			},
		},
	],
	server: {
		proxy: { "/api": process.env.I2N_API_TARGET || "http://127.0.0.1:8080" },
	},
	build: {
		outDir: "dist/web",
		minify: false,
		cssMinify: false,
		sourcemap: true,
	},
});
