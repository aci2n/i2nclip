# Included by the repository Makefile; also usable with make -C client.
CLIENT_DIR := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))
NODE22 ?= $(HOME)/.nvm/versions/node/v$(strip $(file <$(CLIENT_DIR)/.nvmrc))/bin/node

.PHONY: client client-test e2e extension

client:
	npm run build --prefix "$(CLIENT_DIR)"

client-test:
	npm run test --prefix "$(CLIENT_DIR)"
	npm run check --prefix "$(CLIENT_DIR)"

# Override NODE22 when Node 22 is installed outside the default nvm directory.
e2e: export PATH := $(dir $(NODE22)):$(PATH)
e2e:
	@test -x "$(NODE22)" || { echo "Node 22 not found at $(NODE22); run nvm install or set NODE22" >&2; exit 1; }
	PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --prefix "$(CLIENT_DIR)"
	cd "$(CLIENT_DIR)" && npx playwright install firefox
	npm run e2e --prefix "$(CLIENT_DIR)"

# Build the add-on before packing it; load dist/extension/manifest.json in Firefox.
extension:
	python3 "$(CLIENT_DIR)/../scripts/pack-extension.py"

ifeq ($(CURDIR),$(CLIENT_DIR))
.DEFAULT_GOAL := client
.PHONY: build test
build: client
test: client-test
endif
