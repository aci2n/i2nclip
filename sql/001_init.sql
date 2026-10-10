CREATE TABLE IF NOT EXISTS registered_keys (
    public_key BYTEA PRIMARY KEY CHECK (octet_length(public_key) = 32)
);

CREATE TABLE IF NOT EXISTS registration_codes (
    code_hash BYTEA PRIMARY KEY CHECK (octet_length(code_hash) = 32),
    expires_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS registration_codes_expires ON registration_codes (expires_at);

CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY CHECK (id ~ '^[0-9a-f]{64}$'),
    owner BYTEA NOT NULL CHECK (octet_length(owner) = 32),
    meta BYTEA NOT NULL CHECK (octet_length(meta) BETWEEN 29 AND 65536),
    content BYTEA NOT NULL CHECK (octet_length(content) BETWEEN 29 AND 33554496),
    created_at BIGINT NOT NULL
);

ALTER TABLE files ALTER COLUMN content SET STORAGE EXTERNAL;

CREATE INDEX IF NOT EXISTS files_owner_created_id ON files (owner, created_at DESC, id ASC);

CREATE TABLE IF NOT EXISTS tags (
    file_id TEXT NOT NULL REFERENCES files (id) ON DELETE CASCADE,
    token TEXT NOT NULL,
    PRIMARY KEY (file_id, token)
);

CREATE TABLE IF NOT EXISTS nonces (
    nonce TEXT PRIMARY KEY,
    expires BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS nonces_expires ON nonces (expires);

CREATE OR REPLACE FUNCTION preserve_content() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.content IS DISTINCT FROM OLD.content THEN
        RAISE EXCEPTION 'content is immutable' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER files_immutable_content
    BEFORE UPDATE OF content ON files
    FOR EACH ROW EXECUTE FUNCTION preserve_content();
