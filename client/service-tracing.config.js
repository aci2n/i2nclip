// Release builds replace tracing before bundling, including unminified workers.
export function serviceTracingPlugin(enabled) {
	const disabled = "\0i2nclip-service-tracing-disabled";
	return {
		name: "service-message-tracing",
		enforce: "pre",
		resolveId(source, importer) {
			if (
				!enabled &&
				source === "./trace.js" &&
				importer?.endsWith("/service/engine.js")
			)
				return disabled;
		},
		load(id) {
			if (id === disabled)
				return "export const serviceTracing = false; export function traceMessage() {}";
		},
	};
}
