#!/bin/sh
set -eu

# Git pathspecs inspect the index directly, including paths containing newlines.
# Documentation does not need runtime checks, even beside application sources.
if ! git diff --cached --quiet -- \
    '*.rs' Cargo.toml Cargo.lock 'sql/**' 'rust-toolchain*' \
    Makefile Containerfile 'client/tests/*vectors*.json' \
    ':(exclude)**/*.md'; then
    make format-check lint-rust
fi

if ! git diff --cached --quiet -- \
    'client/**' Makefile Containerfile ':(exclude)**/*.md'; then
    make lint-client
fi
