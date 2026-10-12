// Only the owner opens this database. No callbacks or transaction capabilities
// escape this module; completion means the entire IDB transaction committed.
export function createRepository(indexedDB = globalThis.indexedDB) {
	let database;
	const ready = new Promise((resolve, reject) => {
		if (!indexedDB) return reject(new Error("Local database is unavailable."));
		const request = indexedDB.open("i2nclip-service", 1);
		request.onupgradeneeded = () => {
			for (const name of ["config", "jobs", "sources"])
				request.result.createObjectStore(name);
		};
		request.onerror = () => reject(request.error);
		request.onblocked = () =>
			reject(
				new Error(
					"Local database is blocked. Close other app pages and retry.",
				),
			);
		request.onsuccess = () => {
			database = request.result;
			database.onversionchange = () => database.close();
			resolve();
		};
	});
	async function run(stores, mode, issue) {
		await ready;
		return new Promise((resolve, reject) => {
			const tx = database.transaction(stores, mode);
			let result;
			tx.oncomplete = () => resolve(result);
			tx.onabort = () =>
				reject(tx.error || new Error("Local database write failed."));
			try {
				issue(tx, (value) => {
					result = value;
				});
			} catch (error) {
				tx.abort();
				reject(error);
			}
		});
	}
	const read = (store, key) =>
		run([store], "readonly", (tx, done) => {
			const request = tx.objectStore(store).get(key);
			request.onsuccess = () => done(request.result);
		});
	return {
		ready,
		getConfig: async () => (await read("config", "identity")) || {},
		setConfig: (config, { clearUploads = false } = {}) =>
			run(
				clearUploads ? ["config", "jobs", "sources"] : ["config"],
				"readwrite",
				(tx) => {
					tx.objectStore("config").put(config, "identity");
					if (clearUploads) {
						tx.objectStore("jobs").clear();
						tx.objectStore("sources").clear();
					}
				},
			),
		jobs: () =>
			run(["jobs"], "readonly", (tx, done) => {
				const request = tx.objectStore("jobs").getAll();
				request.onsuccess = () => done(request.result);
			}),
		getSource: (id) => read("sources", id),
		putJob: (job, source) =>
			run(["jobs", "sources"], "readwrite", (tx) => {
				tx.objectStore("jobs").put(job, job.id);
				if (source !== undefined) tx.objectStore("sources").put(source, job.id);
			}),
		finishJob: (job) =>
			run(["jobs", "sources"], "readwrite", (tx) => {
				tx.objectStore("jobs").put(job, job.id);
				tx.objectStore("sources").delete(job.id);
			}),
		removeJob: (id) =>
			run(["jobs", "sources"], "readwrite", (tx) => {
				tx.objectStore("jobs").delete(id);
				tx.objectStore("sources").delete(id);
			}),
		reset: () =>
			run(["config", "jobs", "sources"], "readwrite", (tx) => {
				for (const name of ["config", "jobs", "sources"])
					tx.objectStore(name).clear();
			}),
		close: () => database?.close(),
	};
}
