import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

export default defineConfig({
	publicDir: false,
	plugins: [
		svelte(),
		{
			name: "watch-extension-assets",
			async buildStart() {
				for (const file of [
					"manifest.json",
					"library.html",
					"options.html",
					"upload.html",
					"unlock.html",
					"icon.svg",
				]) {
					const path = fileURLToPath(
						new URL(`./public/${file}`, import.meta.url),
					);
					this.addWatchFile(path);
					this.emitFile({
						type: "asset",
						fileName: file,
						source: await readFile(path),
					});
				}
			},
		},
	],
	build: {
		outDir: "dist/extension",
		minify: false,
		cssMinify: false,
		target: "firefox157",
		rolldownOptions: {
			input: {
				app: fileURLToPath(new URL("./src/extension/app.js", import.meta.url)),
				background: fileURLToPath(
					new URL("./src/extension/background.js", import.meta.url),
				),
			},
			output: {
				entryFileNames: "[name].js",
				chunkFileNames: "chunks/[name]-[hash].js",
				assetFileNames: "[name][extname]",
			},
		},
	},
});
