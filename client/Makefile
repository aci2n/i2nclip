# Web client commands, delegated from the repository Makefile.
NODE ?= $(HOME)/.nvm/versions/node/v$(strip $(file <.nvmrc))/bin/node
.DEFAULT_GOAL := build
.PHONY: build web packages audit test lint format-check format-write test-packages test-e2e test-profile
build:
	npm run build
web:
	npm run pack:web
packages: web
audit:
	npm audit
test:
	npm run test
	npm run check
lint:
	npm run lint
format-check:
	npm run format:check
format-write:
	npm run format:write
test-packages: web
	npm run test:packages
test-e2e: export PATH := $(dir $(NODE)):$(PATH)
test-e2e:
	PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci
	npx playwright install firefox chromium
	npm run e2e
test-profile:
	"$(NODE)" tests/profile-postgres.js
