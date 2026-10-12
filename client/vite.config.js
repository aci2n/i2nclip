import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [
		svelte(),
		{
			name: "web-favicon",
			configureServer(server) {
				server.middlewares.use(
					"/favicon.ico",
					async (_request, response, next) => {
						try {
							response.setHeader("Content-Type", "image/x-icon");
							response.end(
								await readFile(
									new URL("./public/favicon.ico", import.meta.url),
								),
							);
						} catch (error) {
							next(error);
						}
					},
				);
			},
			async buildStart() {
				const path = fileURLToPath(
					new URL("./public/favicon.ico", import.meta.url),
				);
				this.addWatchFile(path);
				this.emitFile({
					type: "asset",
					fileName: "favicon.ico",
					source: await readFile(path),
				});
			},
		},
	],
	publicDir: false,
	server: {
		proxy: { "/api": process.env.I2N_API_TARGET || "http://127.0.0.1:8080" },
	},
	build: { outDir: "dist/web", minify: false, cssMinify: false },
	worker: {
		format: "es",
		plugins: () => [],
		rolldownOptions: {
			output: { minify: false, entryFileNames: "assets/[name].js" },
		},
	},
});

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
