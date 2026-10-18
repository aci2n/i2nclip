CREATE TABLE registered_keys (
    public_key BYTEA PRIMARY KEY CHECK (octet_length(public_key) = 32)
);

CREATE TABLE key_quotas (
    public_key BYTEA PRIMARY KEY REFERENCES registered_keys (public_key),
    max_content_bytes BIGINT NOT NULL DEFAULT 536870912 CHECK (max_content_bytes BETWEEN 0 AND 9007199254740991),
    max_files BIGINT NOT NULL DEFAULT 10000 CHECK (max_files BETWEEN 0 AND 9007199254740991),
    used_content_bytes BIGINT NOT NULL DEFAULT 0 CHECK (used_content_bytes >= 0),
    file_count BIGINT NOT NULL DEFAULT 0 CHECK (file_count >= 0),
    CONSTRAINT key_quotas_content_limit CHECK (used_content_bytes <= max_content_bytes),
    CONSTRAINT key_quotas_files_limit CHECK (file_count <= max_files)
);

CREATE TABLE registration_codes (
    code_hash BYTEA PRIMARY KEY CHECK (octet_length(code_hash) = 32),
    expires_at BIGINT NOT NULL,
    max_content_bytes BIGINT NOT NULL DEFAULT 536870912 CHECK (max_content_bytes BETWEEN 0 AND 9007199254740991),
    max_files BIGINT NOT NULL DEFAULT 10000 CHECK (max_files BETWEEN 0 AND 9007199254740991)
);

CREATE INDEX registration_codes_expires ON registration_codes (expires_at);

CREATE TABLE files (
    id TEXT PRIMARY KEY CHECK (id ~ '^[0-9a-f]{64}$'),
    owner BYTEA NOT NULL REFERENCES registered_keys (public_key),
    meta BYTEA NOT NULL CHECK (octet_length(meta) BETWEEN 42 AND 65536),
    descriptor BYTEA NOT NULL CHECK (octet_length(descriptor) BETWEEN 42 AND 1024),
    plaintext_bytes BIGINT NOT NULL CHECK (plaintext_bytes >= 0),
    expected_chunk_count BIGINT GENERATED ALWAYS AS (GREATEST(1, (plaintext_bytes + 4194303) / 4194304)) STORED,
    current_chunk_count BIGINT NOT NULL DEFAULT 0,
    content_bytes BIGINT GENERATED ALWAYS AS (plaintext_bytes + 16 * GREATEST(1, (plaintext_bytes + 4194303) / 4194304)) STORED,
    created_at BIGINT NOT NULL,
    last_progress_at BIGINT NOT NULL,
    CHECK (plaintext_bytes <= 9007199254740991),
    CHECK (current_chunk_count BETWEEN 0 AND expected_chunk_count),
    CHECK (content_bytes <= 9007199254740991)
);

CREATE INDEX files_owner_created_id ON files (owner, created_at DESC, id ASC)
    WHERE current_chunk_count = expected_chunk_count;
CREATE INDEX files_pending_progress ON files (last_progress_at, id)
    WHERE current_chunk_count < expected_chunk_count;

CREATE TABLE chunks (
    file_id TEXT NOT NULL REFERENCES files (id) ON DELETE CASCADE,
    index BIGINT NOT NULL CHECK (index >= 0),
    ciphertext BYTEA STORAGE EXTERNAL NOT NULL CHECK (octet_length(ciphertext) BETWEEN 16 AND 4194320),
    PRIMARY KEY (file_id, index)
);

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
    IF (NEW.id, NEW.owner, NEW.descriptor, NEW.plaintext_bytes, NEW.created_at)
       IS DISTINCT FROM (OLD.id, OLD.owner, OLD.descriptor, OLD.plaintext_bytes, OLD.created_at) THEN
        RAISE EXCEPTION 'content is immutable' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER files_immutable_content BEFORE UPDATE ON files
    FOR EACH ROW EXECUTE FUNCTION preserve_content();

CREATE FUNCTION preserve_chunk() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'chunks are immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER chunks_immutable BEFORE UPDATE ON chunks
    FOR EACH ROW EXECUTE FUNCTION preserve_chunk();
