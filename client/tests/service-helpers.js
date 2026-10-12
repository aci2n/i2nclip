import { createServiceClient } from "../src/lib/service/client.js";

export function memoryRepository(initial = {}) {
	let config = structuredClone(initial);
	const jobs = new Map(),
		sources = new Map();
	return {
		getConfig: async () => structuredClone(config),
		setConfig: async (value, { clearUploads = false } = {}) => {
			config = structuredClone(value);
			if (clearUploads) {
				jobs.clear();
				sources.clear();
			}
		},
		jobs: async () => structuredClone([...jobs.values()]),
		getSource: async (id) => structuredClone(sources.get(id)),
		putJob: async (job, source) => {
			jobs.set(job.id, structuredClone(job));
			if (source !== undefined) sources.set(job.id, structuredClone(source));
		},
		finishJob: async (job) => {
			jobs.set(job.id, structuredClone(job));
			sources.delete(job.id);
		},
		removeJob: async (id) => {
			jobs.delete(id);
			sources.delete(id);
		},
		clearUploads: async () => {
			jobs.clear();
			sources.clear();
		},
		reset: async () => {
			config = {};
			jobs.clear();
			sources.clear();
		},
		close() {},
	};
}

export function engineClient(engine, options = {}) {
	let connection;
	const client = createServiceClient(
		() => {
			let listener;
			connection = engine.connect((message) =>
				queueMicrotask(() => listener?.(structuredClone(message))),
			);
			return {
				send: (message) => {
					void connection.receive(structuredClone(message));
				},
				listen(fn) {
					listener = fn;
					return () => {
						listener = null;
					};
				},
				disconnect: connection.disconnect,
			};
		},
		{ browser: null, ...options },
	);
	return client;
}

export async function until(check, message = "Condition did not settle") {
	const deadline = Date.now() + 5000;
	while (!check()) {
		if (Date.now() > deadline) throw new Error(message);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

export async function serviceFixture(t, options = {}) {
	const { generatePrivateKey } = await import(
		"../src/lib/protocol/identity.js"
	);
	const { createLibraryRuntime } = await import(
		"../src/lib/service/runtime.js"
	);
	const key = await generatePrivateKey();
	const repository = memoryRepository({
		serverUrl: "https://clip.example",
		publicKey: key.publicKey,
		privateKey: key.privateKey,
		identityGeneration: "identity",
	});
	const engine = createLibraryRuntime({
		repository,
		defaultServerUrl: "https://clip.example",
		api: { list: async () => ({ items: [], next: null }) },
		...options,
	});
	t.after(engine.dispose);
	const client = engineClient(engine);
	t.after(client.dispose);
	await client.ready;
	return { engine, repository, client, key };
}
