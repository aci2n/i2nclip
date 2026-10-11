import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
	chooseRestore,
	expect,
	issueOtc,
	PASSWORD,
	png,
	test,
} from "./fixtures.js";

const execute = promisify(execFile);
const executable = fileURLToPath(new URL("../cli/index.js", import.meta.url));

test("CLI and extension share a recovery identity and edit the same library", async ({
	page,
	app,
}) => {
	const dir = await mkdtemp(join(tmpdir(), "i2nclip-cli-e2e-"));
	try {
		const passwordFile = join(dir, "password");
		await writeFile(passwordFile, `${PASSWORD}\n`, { mode: 0o600 });
		const env = { ...process.env, XDG_CONFIG_HOME: dir };
		delete env.FORCE_COLOR;
		const cli = async (...args) => {
			const result = await execute(
				process.execPath,
				[executable, ...args, "--password-file", passwordFile],
				{ env },
			);
			expect(result.stderr).toBe("");
			return JSON.parse(result.stdout);
		};
		const created = await cli(
			"create",
			"--server",
			app.origin,
			"--otc",
			await issueOtc(app.data),
		);
		expect(created.registered).toBe(true);
		await cli("register", "--otc", "already-consumed-code");
		const source = join(dir, "photo.png");
		await writeFile(source, png);
		const saved = await cli("upload", source, "--tags", "Original,Keep");
		const edited = await cli(
			"tags",
			saved.id,
			"--remove",
			"ORIGINAL",
			"--add",
			"New,KEEP",
		);
		expect(edited.tags).toEqual(["Keep", "New"]);
		const listed = await cli("list", "--tags", "new,keep");
		expect(listed.items).toHaveLength(1);
		expect(listed.items[0].metadata.name).toBe("photo.png");
		expect(listed.items[0].metadata.content_type).toBe("image/png");
		expect(listed.items[0]).not.toHaveProperty("thumb");
		const target = join(dir, "download.png");
		await cli("download", saved.id, "--output", target);
		expect(await readFile(target)).toEqual(png);

		await page.goto(`${app.web.origin}/client/dist/extension/options.html`);
		await chooseRestore(page);
		await page.locator("#file").setInputFiles(created.recovery);
		await page.locator("#restore-pass").fill(PASSWORD);
		await page.locator("#restore-pass").press("Enter");
		await expect(page.locator("#status")).toHaveText(
			"Library restored and unlocked.",
		);
		await page.getByRole("link", { name: "Library" }).click();
		const card = page.locator(".card");
		await expect(card.locator(".card-title")).toHaveText("photo.png");
		await expect(card.locator(".tag-text")).toHaveText(["Keep", "New"]);
		await card.getByRole("button", { name: "Remove tag New" }).click();
		await expect(card.locator(".tag-text")).toHaveText(["Keep"]);
		expect((await cli("list")).items[0].metadata.tags).toEqual(["Keep"]);
		await cli("delete", saved.id);
		expect((await cli("list")).items).toEqual([]);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
