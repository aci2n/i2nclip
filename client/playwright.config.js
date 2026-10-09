import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "e2e",
	timeout: 180_000,
	expect: { timeout: 20_000 },
	use: {
		browserName: "firefox",
		viewport: { width: 1100, height: 800 },
		launchOptions: {
			firefoxUserPrefs: { "security.sandbox.content.level": 0 },
			env: { ...process.env, MOZ_DISABLE_CONTENT_SANDBOX: "1" },
		},
	},
});
