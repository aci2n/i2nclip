CREATE TABLE registered_keys (
    public_key BYTEA PRIMARY KEY CHECK (octet_length(public_key) = 32)
);

CREATE TABLE key_quotas (
    public_key BYTEA PRIMARY KEY REFERENCES registered_keys (public_key),
    max_content_bytes BIGINT NOT NULL DEFAULT 536870912 CHECK (max_content_bytes >= 0),
    max_files BIGINT NOT NULL DEFAULT 10000 CHECK (max_files >= 0),
    used_content_bytes BIGINT NOT NULL DEFAULT 0 CHECK (used_content_bytes >= 0),
    file_count BIGINT NOT NULL DEFAULT 0 CHECK (file_count >= 0),
    CONSTRAINT key_quotas_content_limit CHECK (used_content_bytes <= max_content_bytes),
    CONSTRAINT key_quotas_files_limit CHECK (file_count <= max_files)
);

CREATE TABLE registration_codes (
    code_hash BYTEA PRIMARY KEY CHECK (octet_length(code_hash) = 32),
    expires_at BIGINT NOT NULL,
    max_content_bytes BIGINT NOT NULL DEFAULT 536870912 CHECK (max_content_bytes >= 0),
    max_files BIGINT NOT NULL DEFAULT 10000 CHECK (max_files >= 0)
);

CREATE INDEX registration_codes_expires ON registration_codes (expires_at);

CREATE TABLE files (
    id TEXT PRIMARY KEY CHECK (id ~ '^[0-9a-f]{64}$'),
    owner BYTEA NOT NULL CHECK (octet_length(owner) = 32),
    meta BYTEA NOT NULL CHECK (octet_length(meta) BETWEEN 42 AND 65536),
    content BYTEA NOT NULL CHECK (octet_length(content) BETWEEN 42 AND 33554496),
    content_bytes BIGINT GENERATED ALWAYS AS (octet_length(content)) STORED,
    created_at BIGINT NOT NULL
);

ALTER TABLE files ALTER COLUMN content SET STORAGE EXTERNAL;

CREATE INDEX files_owner_created_id ON files (owner, created_at DESC, id ASC);

CREATE TABLE tags (
    file_id TEXT NOT NULL REFERENCES files (id) ON DELETE CASCADE,
    token TEXT NOT NULL,
    label BYTEA NOT NULL CHECK (octet_length(label) BETWEEN 43 AND 1024),
    PRIMARY KEY (file_id, token)
);

CREATE TABLE nonces (
    nonce TEXT PRIMARY KEY,
    expires BIGINT NOT NULL
);

CREATE INDEX nonces_expires ON nonces (expires);

CREATE FUNCTION preserve_content() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.content IS DISTINCT FROM OLD.content THEN
        RAISE EXCEPTION 'content is immutable' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER files_immutable_content
    BEFORE UPDATE OF content ON files
    FOR EACH ROW EXECUTE FUNCTION preserve_content();
