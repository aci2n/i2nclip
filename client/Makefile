# Client commands use the Node version in .nvmrc, resolved from PATH.
.DEFAULT_GOAL := build
.PHONY: check-node build extension audit test check fix test-build test-e2e test-profile

check-node:
	@test "$$(node --version)" = "v$(strip $(file <.nvmrc))" || { echo "Use Node $(strip $(file <.nvmrc)) from .nvmrc on PATH" >&2; exit 1; }

node_modules/.package-lock.json: package.json package-lock.json .nvmrc | check-node
	npm ci

build audit test check fix test-e2e test-profile test-build: node_modules/.package-lock.json

build:
	npm run build
extension: check-node
	npm run build:extension
audit:
	npm audit
test:
	npm test
	npm run check
check:
	npm run check
fix:
	npm run fix
test-build:
	npm run test:build
test-e2e:
	npx playwright install firefox chromium
	npm run e2e
test-profile:
	node tests/profile-postgres.js
