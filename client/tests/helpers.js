export function deferred() {
	let resolve, reject;
	const promise = new Promise((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}
export const tick = () => new Promise((resolve) => setImmediate(resolve));

export function installUploadLocks(t) {
	const previous = Object.getOwnPropertyDescriptor(navigator, "locks");
	const held = new Set();
	Object.defineProperty(navigator, "locks", {
		configurable: true,
		value: {
			async request(name, options, action) {
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
