import { createSessionContext } from "../src/lib/stores/session-context.js";
export function deferred() {
	let resolve, reject;
	const promise = new Promise((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}
export const tick = () => new Promise((resolve) => setImmediate(resolve));

export function installSessionLocks(t) {
	const previous = Object.getOwnPropertyDescriptor(navigator, "locks");
	let tail = Promise.resolve();
	Object.defineProperty(navigator, "locks", {
		configurable: true,
		value: {
			request(name, options, action) {
				if (name !== "i2nclip-session" || !options.signal)
					throw new Error("Expected the session mutation lock.");
				const next = tail.then(() => {
					options.signal.throwIfAborted();
					return action();
				});
				tail = next.catch(() => {});
				return next;
			},
		},
	});
	t.after(() => {
		if (previous) Object.defineProperty(navigator, "locks", previous);
		else delete navigator.locks;
	});
}

export function installUploadLocks(t) {
	const previous = Object.getOwnPropertyDescriptor(navigator, "locks");
	const held = new Set();
	let sessionTail = Promise.resolve();
	Object.defineProperty(navigator, "locks", {
		configurable: true,
		value: {
			async request(name, options, action) {
				if (name === "i2nclip-session") {
					const next = sessionTail.then(() => {
						options.signal.throwIfAborted();
						return action();
					});
					sessionTail = next.catch(() => {});
					return next;
				}
				if (!options.ifAvailable || options.signal)
					throw new Error("Expected a nonwaiting lock without a signal.");
				if (held.has(name)) return action(null);
				held.add(name);
				try {
					return await action({ name });
				} finally {
					held.delete(name);
				}
			},
		},
	});
	t.after(() => {
		if (previous) Object.defineProperty(navigator, "locks", previous);
		else delete navigator.locks;
	});
}

// Workflow tests inject a lightweight session; real storage/mutex behavior is
// exercised separately by session and session-storage regressions.
export function workflowSession(store, platform = {}) {
	const context = createSessionContext(store);
	return {
		...store,
		operation: context.operation,
		observeIdentity: context.observe,
		async withIdentity(operation, action) {
			operation.signal.throwIfAborted();
			return action(context.expected(operation));
		},
		pending: {
			async get(id) {
				return (await platform.session.get(`upload:${id}`))[`upload:${id}`];
			},
			put: (id, value) => platform.session.set({ [`upload:${id}`]: value }),
			remove: (id) => platform.session.remove(`upload:${id}`),
			async fail(id, error) {
				const key = `upload:${id}`;
				const value = (await platform.session.get(key))[key];
				if (!value) return false;
				await platform.session.set({ [key]: { ...value, error } });
				return true;
			},
		},
	};
}
