import { readFile } from "node:fs/promises";
import { list, updateMetadata } from "../src/lib/api.js";
import { openRecovery } from "../src/lib/protocol/recovery.js";
import {
	createLibrary,
	expect,
	imageFixture,
	PASSWORD,
	recovery,
	test,
} from "./fixtures.js";

test("generic encrypted metadata updates rename downloads and preserve file content", async ({
	page,
	app,
}) => {
	await createLibrary(page, app);
	const manifest = await recovery(page);
	const { identity, key } = await openRecovery(manifest.toString(), PASSWORD);
	const credentials = { serverUrl: identity.serverUrl, key };
	await page.getByRole("link", { name: "Library", exact: true }).click();
	const image = await imageFixture(page, "Original panorama.png", 1920, 320);
	await page.getByLabel("Upload", { exact: true }).setInputFiles(image);
	await expect(page.getByRole("article")).toHaveCount(1);
	const original = (await list(credentials)).items[0];
	const metadata = { ...original.metadata, name: "Renamed panorama.png" };
	const saved = await updateMetadata({
		...credentials,
		id: original.id,
		metadata,
		thumb: original.thumb,
		prevMetaHash: original.metaHash,
	});
	expect(saved.conflict).toBe(false);
	const current = (await list(credentials)).items.find(
		(item) => item.id === original.id,
	);
	expect(current.metadata).toEqual(metadata);
	expect(current.thumb).toEqual(original.thumb);
	expect(current.id).toBe(original.id);
	expect(current.metaHash).not.toBe(original.metaHash);
	await page.getByRole("button", { name: "Search", exact: true }).click();
	const card = page.getByRole("article");
	await expect(
		card.getByText(metadata.name, { exact: true }).first(),
	).toBeVisible();
	const downloading = page.waitForEvent("download");
	await card.getByRole("button", { name: "Download", exact: true }).click();
	const download = await downloading;
	expect(download.suggestedFilename()).toBe(metadata.name);
	expect(await readFile(await download.path())).toEqual(image.buffer);

	const conflict = await updateMetadata({
		...credentials,
		id: original.id,
		metadata: { ...metadata, name: "Stale.png" },
		thumb: original.thumb,
		prevMetaHash: original.metaHash,
	});
	expect(conflict.conflict).toBe(true);
	expect(conflict.item.metadata.name).toBe(metadata.name);
	const combined = {
		...metadata,
		name: "Final panorama.png",
		tags: ["Vacation"],
	};
	expect(
		(
			await updateMetadata({
				...credentials,
				id: original.id,
				metadata: combined,
				thumb: current.thumb,
				prevMetaHash: current.metaHash,
			})
		).conflict,
	).toBe(false);
	const filtered = await list({ ...credentials, tags: "Vacation" });
	expect(filtered.items).toHaveLength(1);
	expect(filtered.items[0].id).toBe(original.id);
	expect(filtered.items[0].metadata).toEqual(combined);
});
