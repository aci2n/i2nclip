const listeners = new Set();
const storage = (area) => ({
	async get(keys) {
		const all = JSON.parse(area.getItem("i2nclip") || "{}");
		if (keys == null) return all;
		return Object.fromEntries(
			(Array.isArray(keys) ? keys : [keys])
				.filter((key) => key in all)
				.map((key) => [key, all[key]]),
		);
	},
	async set(values) {
		area.setItem(
			"i2nclip",
			JSON.stringify({ ...(await this.get(null)), ...values }),
		);
		listeners.forEach((fn) => {
			fn();
		});
	},
	async remove(key) {
		const values = await this.get(null);
		delete values[key];
		area.setItem("i2nclip", JSON.stringify(values));
		listeners.forEach((fn) => {
			fn();
		});
	},
	async clear() {
		area.removeItem("i2nclip");
		listeners.forEach((fn) => {
			fn();
		});
	},
});

window.addEventListener("storage", () =>
	listeners.forEach((fn) => {
		fn();
	}),
);
export const webPlatform = {
	local: storage(localStorage),
	session: storage(sessionStorage),
	subscribe(fn) {
		listeners.add(fn);
		return () => listeners.delete(fn);
	},
	async download(url, filename) {
		const anchor = document.createElement("a");
		anchor.href = url;
		anchor.download = filename;
		anchor.click();
	},
	fetchMedia: ({ srcUrl }, signal) => fetch(srcUrl, { signal }),
	notify: () => {},
	close: () => {},
};
