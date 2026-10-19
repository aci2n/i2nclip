import { fileURLToPath } from "node:url";
import { build } from "vite";

// A separate single-entry IIFE keeps imports/exports out of the worker, including
// when the application and worker share constants. The Firefox suite exercises it.
export async function buildStreamingWorker(outDir?: string) {
	return build({
		configFile: false,
		publicDir: false,
		logLevel: "error",
		build: {
			outDir,
			write: outDir !== undefined,
			emptyOutDir: false,
			minify: false,
			sourcemap: outDir !== undefined ? "inline" : false,
			lib: {
				entry: fileURLToPath(
					new URL("./src/lib/streaming/worker.ts", import.meta.url),
				),
				formats: ["iife"],
				name: "I2nclipStreaming",
				fileName: () => "streaming-worker.js",
			},
		},
	});
}
