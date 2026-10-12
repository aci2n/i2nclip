import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
export default defineConfig({
	base: "./",
	publicDir: false,
	worker: { format: "es", rolldownOptions: { output: { minify: false } } },
	build: {
		outDir: "dist/e2e",
		minify: false,
		target: "firefox157",
		rolldownOptions: {
			input: fileURLToPath(new URL("./e2e/background.js", import.meta.url)),
			output: {
				entryFileNames: "background.js",
				chunkFileNames: "[name]-[hash].js",
			},
		},
	},
});
