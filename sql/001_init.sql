CREATE TABLE IF NOT EXISTS registered_keys (
    public_key BLOB PRIMARY KEY NOT NULL CHECK (length(public_key) = 32)
);

CREATE TABLE IF NOT EXISTS registration_codes (
    code_hash BLOB PRIMARY KEY NOT NULL,
    expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS registration_codes_expires ON registration_codes (expires_at);

CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,
    owner BLOB NOT NULL,
    meta BLOB NOT NULL,
    bytes INTEGER NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS files_owner_created_id ON files (owner, created_at DESC, id ASC);

CREATE TABLE IF NOT EXISTS tags (
    file_id TEXT NOT NULL REFERENCES files (id) ON DELETE CASCADE,
    token TEXT NOT NULL,
    PRIMARY KEY (file_id, token)
);

CREATE TABLE IF NOT EXISTS nonces (
    nonce TEXT PRIMARY KEY,
    expires INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS nonces_expires ON nonces (expires);
