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

CREATE INDEX IF NOT EXISTS files_owner ON files (owner, created_at DESC);

-- Remove receipts from existing databases; duplicate uploads now conflict.
DROP TABLE IF EXISTS upload_receipts;

CREATE TABLE IF NOT EXISTS tags (
    file_id TEXT NOT NULL REFERENCES files (id) ON DELETE CASCADE,
    token TEXT NOT NULL,
    PRIMARY KEY (file_id, token)
);

CREATE INDEX IF NOT EXISTS tags_token ON tags (token, file_id);

CREATE TABLE IF NOT EXISTS nonces (
    nonce TEXT PRIMARY KEY,
    expires INTEGER NOT NULL
);
