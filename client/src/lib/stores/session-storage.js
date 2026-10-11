// Raw identity and pending-upload storage is private to this boundary. The
// callback receives capabilities that expire when its exclusive transaction ends.
export function createSessionStorage(platform, lifetime) {
	return {
		async transaction(action, signal = lifetime) {
			const combined = AbortSignal.any([lifetime, signal]);
			const locks = globalThis.navigator?.locks;
			if (!locks)
				throw new Error("Session coordination is unavailable. Try again.");
			return locks.request(
				"i2nclip-session",
				{ signal: combined },
				async () => {
					let open = true;
					const pending = [];
					const check = () => {
						if (!open) throw new Error("Session transaction has ended.");
						combined.throwIfAborted();
					};
					const area = (storage) =>
						Object.freeze(
							Object.fromEntries(
								["get", "set", "remove", "clear"].map((method) => [
									method,
									(...args) => {
										check();
										let result;
										try {
											// Start within the capability lifetime, rather than in
											// a microtask that could outlive the callback.
											result = Promise.resolve(storage[method](...args));
										} catch (error) {
											result = Promise.reject(error);
										}
										// Track failures immediately, including writes a callback
										// did not await. The transaction still propagates them.
										result.catch(() => {});
										pending.push(result);
										return result;
									},
								]),
							),
						);
					const transaction = Object.freeze({
						local: area(platform.local),
						session: area(platform.session),
						signal: combined,
					});
					try {
						check();
						const result = await action(transaction);
						open = false;
						await Promise.all(pending);
						combined.throwIfAborted();
						return result;
					} finally {
						// Close admission before draining: chained continuations may
						// not append writes after the callback has settled. Already
						// started operations must finish before releasing the mutex.
						open = false;
						await Promise.allSettled(pending);
					}
				},
			);
		},
	};
}
