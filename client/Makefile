# Frontend commands. Run directly here or through the repository Makefile.
NODE22 ?= $(HOME)/.nvm/versions/node/v$(strip $(file <.nvmrc))/bin/node

.PHONY: build test e2e extension dev-extension

build:
	npm run build

test:
	npm run test
	npm run check

# Override NODE22 when Node 22 is installed outside the default nvm directory.
e2e: export PATH := $(dir $(NODE22)):$(PATH)
e2e:
	@test -x "$(NODE22)" || { echo "Node 22 not found at $(NODE22); run nvm install or set NODE22" >&2; exit 1; }
	PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci
	npx playwright install firefox
	npm run e2e

# Build the add-on before packing it; load dist/extension/manifest.json in Firefox.
extension:
	npm run pack:extension

# Build once before Firefox starts, then rebuild and reload on source changes.
# npx downloads web-ext on first use. Ctrl-C also stops the build watcher.
dev-extension: export PATH := $(dir $(NODE22)):$(PATH)
dev-extension:
	npm run build:extension
	@node node_modules/vite/bin/vite.js build --config vite.extension.config.js --watch & \
	watcher=$$!; \
	trap 'kill "$$watcher" 2>/dev/null || true; wait "$$watcher" 2>/dev/null || true' EXIT; \
	trap 'exit 130' INT; \
	trap 'exit 143' TERM; \
	npx --yes web-ext run --source-dir dist/extension
