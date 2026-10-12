// Only the owner opens this database. No callbacks or transaction capabilities
// escape this module; completion means the entire IDB transaction committed.
export function createRepository(indexedDB = globalThis.indexedDB) {
	let database;
	const ready = new Promise((resolve, reject) => {
		if (!indexedDB) return reject(new Error("Local database is unavailable."));
		const request = indexedDB.open("i2nclip-libraries", 1);
		request.onupgradeneeded = () => {
			for (const name of ["libraries", "jobs", "sources"])
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
				reject(
					tx.failure || tx.error || new Error("Local database write failed."),
				);
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
	const all = (store) =>
		run([store], "readonly", (tx, done) => {
			const request = tx.objectStore(store).getAll();
			request.onsuccess = () => done(request.result);
		});
	const clearJobs = (tx, libraryId) => {
		const request = tx.objectStore("jobs").getAll();
		request.onsuccess = () => {
			for (const job of request.result)
				if (job.libraryId === libraryId) {
					tx.objectStore("jobs").delete(job.id);
					tx.objectStore("sources").delete(job.id);
				}
		};
	};
	const scope = (libraryId) => ({
		getConfig: async () => (await read("libraries", libraryId))?.identity || {},
		setConfig: (identity, { clearUploads = false } = {}) =>
			run(["libraries", "jobs", "sources"], "readwrite", (tx) => {
				const request = tx.objectStore("libraries").getAll();
				request.onsuccess = () => {
					const rows = request.result;
					const row = rows.find((item) => item.id === libraryId);
					if (!row) {
						tx.abort();
						return;
					}
					if (
						identity.publicKey &&
						rows.some(
							(item) =>
								item.id !== libraryId &&
								item.identity?.publicKey === identity.publicKey &&
								new URL(item.identity.serverUrl).origin ===
									new URL(identity.serverUrl).origin,
						)
					) {
						tx.failure = new Error(
							"This library is already saved. Select its existing entry.",
						);
						tx.abort();
						return;
					}
					tx.objectStore("libraries").put({ ...row, identity }, libraryId);
					if (clearUploads) clearJobs(tx, libraryId);
				};
			}),
		jobs: async () =>
			(await all("jobs")).filter((job) => job.libraryId === libraryId),
		getSource: async (id) => {
			const job = await read("jobs", id);
			return job?.libraryId === libraryId ? read("sources", id) : undefined;
		},
		putJob: (job, source) =>
			run(["jobs", "sources"], "readwrite", (tx) => {
				tx.objectStore("jobs").put({ ...job, libraryId }, job.id);
				if (source !== undefined) tx.objectStore("sources").put(source, job.id);
			}),
		finishJob: (job) =>
			run(["jobs", "sources"], "readwrite", (tx) => {
				tx.objectStore("jobs").put({ ...job, libraryId }, job.id);
				tx.objectStore("sources").delete(job.id);
			}),
		removeJob: (id) =>
			run(["jobs", "sources"], "readwrite", (tx) => {
				const request = tx.objectStore("jobs").get(id);
				request.onsuccess = () => {
					if (request.result?.libraryId !== libraryId) return;
					tx.objectStore("jobs").delete(id);
					tx.objectStore("sources").delete(id);
				};
			}),
		reset: () => scope(libraryId).setConfig({}, { clearUploads: true }),
		close() {},
	});

	return {
		ready,
		libraries: () => all("libraries"),
		putLibrary: (row) =>
			run(["libraries"], "readwrite", (tx) =>
				tx.objectStore("libraries").put(row, row.id),
			),
		renameLibrary: (id, name) =>
			run(["libraries"], "readwrite", (tx) => {
				const request = tx.objectStore("libraries").get(id);
				request.onsuccess = () => {
					if (!request.result) {
						tx.abort();
						return;
					}
					tx.objectStore("libraries").put({ ...request.result, name }, id);
				};
			}),
		deleteLibraries: (ids, replacement, onlySetups = false) =>
			run(["libraries", "jobs", "sources"], "readwrite", (tx) => {
				const remove = () => {
					for (const id of ids) {
						tx.objectStore("libraries").delete(id);
						clearJobs(tx, id);
					}
					if (replacement)
						tx.objectStore("libraries").put(replacement, replacement.id);
				};
				if (!onlySetups) return remove();
				const request = tx.objectStore("libraries").getAll();
				request.onsuccess = () => {
					if (
						request.result.some(
							(row) => ids.includes(row.id) && row.identity?.wrappedKey,
						)
					) {
						tx.failure = new Error(
							"Setup completed. Keep the saved library and its recovery file.",
						);
						tx.abort();
						return;
					}
					remove();
				};
			}),
		scope,
		jobs: () =>
			run(["jobs"], "readonly", (tx, done) => {
				const request = tx.objectStore("jobs").getAll();
				request.onsuccess = () => done(request.result);
			}),
		close: () => database?.close(),
	};
}
