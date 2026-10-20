#!/bin/sh
set -eu

check_script=$(cd "$(dirname "$0")/.." && pwd)/check-staged.sh
fixture=$(mktemp -d)
trap 'rm -rf "$fixture"' EXIT HUP INT TERM
mkdir "$fixture/bin" "$fixture/repo"
cat > "$fixture/bin/make" <<'MOCK'
#!/bin/sh
printf '%s\n' "$*" >> "$HOOK_TEST_LOG"
MOCK
chmod +x "$fixture/bin/make"
export PATH="$fixture/bin:$PATH"
export HOOK_TEST_LOG="$fixture/checks"
cd "$fixture/repo"
git init --quiet

check_paths() {
    expected=$1
    shift
    git rm -r --cached --ignore-unmatch . >/dev/null
    for path do
        mkdir -p "$(dirname "$path")"
        printf '' > "$path"
        git add -- "$path"
    done
    : > "$HOOK_TEST_LOG"
    sh "$check_script"
    actual=$(cat "$HOOK_TEST_LOG")
    if [ "$actual" != "$expected" ]; then
        printf 'Unexpected checks for %s: %s\n' "$*" "$actual" >&2
        exit 1
    fi
}

rust_checks='format-check lint-rust'
client_checks='lint-client'
both_checks="$rust_checks
$client_checks"
check_paths '' AGENTS.md doc/spec.md client/README.md
check_paths "$rust_checks" src/lib.rs tests/protocol.rs
check_paths "$rust_checks" sql/002_chain.sql
check_paths "$client_checks" 'client/src/name with spaces.ts'
check_paths "$client_checks" client/package-lock.json
check_paths "$both_checks" client/tests/test-vectors.json
check_paths "$both_checks" client/tests/chain-vectors.json
check_paths "$both_checks" Makefile
check_paths "$both_checks" src/lib.rs client/src/lib/api.ts
check_paths '' .githooks/check-staged.sh
# Unstaged backend files from earlier cases must not affect a docs-only commit.
check_paths '' doc/final.md
printf 'Staged verification dispatch checks passed.\n'
