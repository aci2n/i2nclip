import { chmod } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
	publicDir: false,
	plugins: [
		{
			name: "executable-cli",
			async closeBundle() {
				await chmod(new URL("./dist/cli/i2nclip.mjs", import.meta.url), 0o755);
			},
		},
	],
	build: {
		ssr: fileURLToPath(new URL("./cli/index.js", import.meta.url)),
		outDir: "dist/cli",
		emptyOutDir: true,
		target: "node22",
		minify: false,
		rolldownOptions: {
			external: /^node:/,
			output: {
				format: "es",
				entryFileNames: "i2nclip.mjs",
				codeSplitting: false,
			},
		},
	},
});
