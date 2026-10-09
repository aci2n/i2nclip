import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [svelte()],
	publicDir: false,
	server: {
		proxy: { "/api": process.env.I2N_API_TARGET || "http://127.0.0.1:8080" },
	},
	build: { outDir: "dist/web", minify: false, cssMinify: false },
});
