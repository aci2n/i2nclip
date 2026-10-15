# Client commands use the Node version in .nvmrc, resolved from PATH.
.DEFAULT_GOAL := build
.PHONY: check-node build extension audit test lint format-check format-write test-build test-e2e test-profile

check-node:
	@test "$$(node --version)" = "v$(strip $(file <.nvmrc))" || { echo "Use Node $(strip $(file <.nvmrc)) from .nvmrc on PATH" >&2; exit 1; }

node_modules/.package-lock.json: package.json package-lock.json .nvmrc | check-node
	npm ci

build audit test lint format-check format-write test-e2e test-profile test-build: node_modules/.package-lock.json

build:
	npm run build
extension: check-node
	npm run build:extension
audit:
	npm audit
test:
	npm test
	npm run check
lint:
	npm run lint
format-check:
	npm run format:check
format-write:
	npm run format:write
test-build:
	npm run test:build
test-e2e:
	npx playwright install firefox chromium
	npm run e2e
test-profile:
	node tests/profile-postgres.js
