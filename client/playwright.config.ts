import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "e2e",
	outputDir: "e2e/shots",
	workers: 2,
	timeout: 180_000,
	expect: { timeout: 20_000 },
	use: {
		actionTimeout: 20_000,
		viewport: { width: 1100, height: 800 },
	},
	projects: [
		{
			name: "firefox",
			use: {
				browserName: "firefox",
				launchOptions: {
					firefoxUserPrefs: { "security.sandbox.content.level": 0 },
					env: { ...process.env, MOZ_DISABLE_CONTENT_SANDBOX: "1" },
				},
			},
		},
		{ name: "chromium", use: { browserName: "chromium" } },
	],
});
