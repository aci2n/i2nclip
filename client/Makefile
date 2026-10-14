# Client commands use the Node version in .nvmrc, resolved from PATH.
.DEFAULT_GOAL := build
.PHONY: check-node build web extension audit test lint format-check format-write test-packages test-e2e test-profile

check-node:
	@test "$$(node --version)" = "v$(strip $(file <.nvmrc))" || { echo "Use Node $(strip $(file <.nvmrc)) from .nvmrc on PATH" >&2; exit 1; }

node_modules/.package-lock.json: package.json package-lock.json .nvmrc | check-node
	npm ci

build web audit test lint format-check format-write test-e2e test-profile test-packages: node_modules/.package-lock.json

build:
	npm run build
extension: check-node
	npm run pack:extension
web:
	npm run pack
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
test-packages:
	npm run pack:extension
	npm run test:package
test-e2e:
	npx playwright install firefox chromium
	npm run e2e
test-profile:
	node tests/profile-postgres.js
