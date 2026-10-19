import { fileURLToPath } from "node:url";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";
import { buildStreamingWorker } from "./streaming.config.ts";

export default defineConfig({
	plugins: [
		svelte({ configFile: false }),
		{
			name: "streaming-worker",
			configureServer(server) {
				let pending: ReturnType<typeof buildStreamingWorker> | undefined;
				server.middlewares.use(async (request, response, next) => {
					if (request.url?.split("?")[0] !== "/streaming-worker.js") {
						next();
						return;
					}
					response.setHeader("Cache-Control", "no-cache");
					pending ??= buildStreamingWorker();
					const building = pending;
					try {
						const result = await building;
						const bundle = Array.isArray(result) ? result[0] : result;
						if (!("output" in bundle)) {
							throw new Error("Worker build did not produce a bundle.");
						}
						const worker = bundle.output.find(
							(output) => output.type === "chunk",
						);
						if (worker?.type !== "chunk") {
							throw new Error("Worker build did not produce JavaScript.");
						}
						response.setHeader("Content-Type", "text/javascript");
						response.end(request.method === "HEAD" ? undefined : worker.code);
					} catch (error) {
						server.config.logger.error(String(error));
						response.statusCode = 500;
						response.end("Streaming worker build failed.");
					} finally {
						if (pending === building) {
							pending = undefined;
						}
					}
				});
			},
			async closeBundle() {
				if (this.environment.mode === "dev") {
					return;
				}
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
