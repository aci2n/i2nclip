import { readFile } from "node:fs/promises";
import { getTags, list, updateMetadata, upload } from "../src/lib/api.ts";
import { openRecovery } from "../src/lib/protocol/recovery.ts";
import { assertPresent } from "../tests/assert.ts";
import {
	createLibrary,
	expect,
	imageFixture,
	PASSWORD,
	recovery,
	test,
} from "./fixtures.ts";

test("decomposed Unicode tag spellings survive upload, metadata updates and catalog decryption", async ({
	page,
	app,
}) => {
	await createLibrary(page, app);
	const manifest = await recovery(page);
	const { identity, key } = await openRecovery(manifest, PASSWORD);
	const credentials = { serverUrl: identity.server_url, key };
	const tag = "가".normalize("NFD").repeat(64);
	const saved = await upload({
		...credentials,
		bytes: new TextEncoder().encode("Unicode tag regression"),
		name: "Unicode.txt",
		contentType: "text/plain",
		tags: [tag],
	});
	const original = (
		await list({ ...credentials, tags: [tag.normalize("NFC")] })
	).items[0];
	expect(original.id).toBe(saved.id);
	expect(assertPresent(original.metadata).tags).toContain(tag);
	expect((await getTags(credentials)).tags).toContain(tag);
	const updatedTag = "나".normalize("NFD").repeat(64);
	const metadata = { ...original.metadata, tags: [updatedTag] };
	const updated = await updateMetadata({
		...credentials,
		id: original.id,
		metadata,
		thumb: original.thumb,
		prevMetaHash: original.metaHash,
	});
	expect(updated.conflict).toBe(false);
	const current = await list({
		...credentials,
		tags: [updatedTag.normalize("NFC")],
	});
	expect(current.items).toHaveLength(1);
	expect(assertPresent(current.items[0].metadata).tags).toEqual([updatedTag]);
	expect((await getTags(credentials)).tags).toEqual([updatedTag]);
	expect((await list({ ...credentials, tags: [tag] })).items).toHaveLength(0);
});
test("generic encrypted metadata updates rename downloads and preserve file content", async ({
	page,
	app,
}) => {
	await createLibrary(page, app);
	await page
		.getByRole("checkbox", { name: "Compress images to WebP" })
		.uncheck();
	const manifest = await recovery(page);
	const { identity, key } = await openRecovery(manifest, PASSWORD);
	const credentials = { serverUrl: identity.server_url, key };
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
	expect(assertPresent(current).metadata).toEqual(metadata);
	expect(assertPresent(current).thumb).toEqual(original.thumb);
	expect(assertPresent(current).id).toBe(original.id);
	expect(assertPresent(current).metaHash).not.toBe(original.metaHash);
	await page
		.getByRole("searchbox", { name: "Search tags", exact: true })
		.fill("original");
	await page
		.getByRole("searchbox", { name: "Search tags", exact: true })
		.press("Enter");
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
	if (!conflict.conflict) {
		throw new Error("Expected metadata conflict");
	}
	expect(assertPresent(conflict.item.metadata).name).toBe(metadata.name);
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
				thumb: assertPresent(current).thumb,
				prevMetaHash: assertPresent(current).metaHash,
			})
		).conflict,
	).toBe(false);
	const filtered = await list({ ...credentials, tags: "Vacation" });
	expect(filtered.items).toHaveLength(1);
	expect(filtered.items[0].id).toBe(original.id);
	expect(filtered.items[0].metadata).toEqual(combined);
});
