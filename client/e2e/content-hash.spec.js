import { createLibrary, expect, test } from "./fixtures.js";

test("content hashes keep immutable downloads correct across deletion and new uploads", async ({
	page,
	app,
}) => {
	await createLibrary(page, app);
	const result = await page.evaluate(async (serverUrl) => {
		const api = await import("/client/src/lib/api.js");
		const { privateKey } = await browser.storage.session.get("privateKey");
		const credentials = { serverUrl, privateKey };
		const bytes = new TextEncoder().encode("same media, fresh encryption");
		const options = { ...credentials, bytes, name: "file.txt", tags: [] };
		const first = await api.upload(options);
		const opened = await api.getContent({ ...credentials, id: first.id });
		await api.updateMetadata({
			...credentials,
			id: first.id,
			metadata: { ...first.metadata, name: "renamed.txt" },
		});
		const listed = await api.list(credentials);
		await api.remove({ ...credentials, id: first.id });
		const second = await api.upload(options);
		const replacement = await api.getContent({ ...credentials, id: second.id });
		return {
			first: first.id,
			second: second.id,
			opened: Array.from(opened),
			replacement: Array.from(replacement),
			expected: Array.from(bytes),
			name: listed.items[0].metadata.name,
			listedId: listed.items[0].id,
		};
	}, app.origin);
	expect(result.first).toMatch(/^[0-9a-f]{64}$/);
	expect(result.second).toMatch(/^[0-9a-f]{64}$/);
	expect(result.first).not.toBe(result.second);
	expect(result.opened).toEqual(result.expected);
	expect(result.replacement).toEqual(result.expected);
	expect(result.listedId).toBe(result.first);
	expect(result.name).toBe("renamed.txt");
});
