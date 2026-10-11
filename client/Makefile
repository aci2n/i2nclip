# Frontend commands. Run directly here or through the repository Makefile.
NODE ?= $(HOME)/.nvm/versions/node/v$(strip $(file <.nvmrc))/bin/node

.DEFAULT_GOAL := build
.PHONY: build test lint format-check e2e web extension cli packages dev-extension

build:
	npm run build

test:
	npm run test
	npm run check

lint:
	npm run lint

format-check:
	npm run format:check

# Override NODE when Node 22 is installed outside the default nvm directory.
e2e: export PATH := $(dir $(NODE)):$(PATH)
e2e:
	@test -x "$(NODE)" || { echo "Node 22 not found at $(NODE); run nvm install or set NODE" >&2; exit 1; }
	PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci
	npx playwright install firefox
	npm run e2e

# Build and package only the selected client target.
web extension cli:
	npm run pack:$@

packages: web extension cli

# Build once before Firefox starts, then rebuild and reload on source changes.
# npx downloads web-ext on first use. Ctrl-C also stops the build watcher.
dev-extension: export PATH := $(dir $(NODE)):$(PATH)
dev-extension:
	@node node_modules/vite/bin/vite.js build --config vite.extension.config.js --watch & \
	watcher=$$!; \
	trap 'kill "$$watcher" 2>/dev/null || true; wait "$$watcher" 2>/dev/null || true' EXIT; \
	trap 'exit 130' INT; \
	trap 'exit 143' TERM; \
	npx --yes web-ext run --source-dir dist/extension
