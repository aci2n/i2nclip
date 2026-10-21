CREATE TABLE libraries (
    id BYTEA PRIMARY KEY CHECK (octet_length(id) = 32),
    recovery_public_key BYTEA NOT NULL UNIQUE CHECK (octet_length(recovery_public_key) = 32),
    epoch_1_salt BYTEA NOT NULL CHECK (octet_length(epoch_1_salt) = 32),
    genesis_device_key BYTEA NOT NULL UNIQUE CHECK (octet_length(genesis_device_key) = 32),
    head_hash BYTEA NOT NULL CHECK (octet_length(head_hash) = 32),
    head_sequence BIGINT NOT NULL DEFAULT 0 CHECK (head_sequence BETWEEN 0 AND 9007199254740991),
    epoch BIGINT NOT NULL DEFAULT 1 CHECK (epoch BETWEEN 1 AND 9007199254740991),
    max_blob_bytes BIGINT NOT NULL DEFAULT 536870912 CHECK (max_blob_bytes BETWEEN 0 AND 9007199254740991),
    used_blob_bytes BIGINT NOT NULL DEFAULT 0 CHECK (used_blob_bytes BETWEEN 0 AND max_blob_bytes),
    max_files BIGINT NOT NULL DEFAULT 10000 CHECK (max_files BETWEEN 0 AND 9007199254740991),
    retained_files BIGINT NOT NULL DEFAULT 0 CHECK (retained_files BETWEEN 0 AND max_files),
    CHECK (head_sequence <> 0 OR (head_hash = id AND epoch = 1))
);

CREATE TABLE library_keys (
    public_key BYTEA PRIMARY KEY CHECK (octet_length(public_key) = 32),
    library_id BYTEA NOT NULL REFERENCES libraries(id),
    kind TEXT NOT NULL DEFAULT 'device' CHECK (kind IN ('device', 'recovery')),
    CHECK (kind <> 'recovery' OR (authorized_at_sequence = 0 AND revoked_at_sequence IS NULL)),
    authorized_at_sequence BIGINT NOT NULL CHECK (authorized_at_sequence BETWEEN 0 AND 9007199254740991),
    revoked_at_sequence BIGINT CHECK (revoked_at_sequence BETWEEN authorized_at_sequence AND 9007199254740991)
);
CREATE INDEX devices_active_library ON library_keys(library_id) WHERE kind = 'device' AND revoked_at_sequence IS NULL;

CREATE TABLE blocks (
    library_id BYTEA NOT NULL REFERENCES libraries(id),
    sequence BIGINT NOT NULL CHECK (sequence BETWEEN 1 AND 9007199254740991),
    hash BYTEA NOT NULL CHECK (octet_length(hash) = 32),
    previous_hash BYTEA NOT NULL CHECK (octet_length(previous_hash) = 32),
    signer_key BYTEA NOT NULL REFERENCES library_keys(public_key),
    signed_body BYTEA NOT NULL CHECK (octet_length(signed_body) BETWEEN 1 AND 65536),
    signature BYTEA NOT NULL CHECK (octet_length(signature) = 64),
    PRIMARY KEY (library_id, sequence),
    UNIQUE (library_id, hash),
    UNIQUE (library_id, previous_hash)
);

CREATE TABLE files (
    library_id BYTEA NOT NULL REFERENCES libraries(id),
    file_id BYTEA NOT NULL CHECK (octet_length(file_id) = 32),
    status TEXT NOT NULL CHECK (status IN ('staging', 'retained', 'purged')),
    staging_expires_at BIGINT,
    PRIMARY KEY (library_id, file_id),
    CHECK ((status = 'staging' AND staging_expires_at IS NOT NULL AND staging_expires_at >= 0)
        OR (status <> 'staging' AND staging_expires_at IS NULL))
);
CREATE INDEX files_staging_expiry ON files(staging_expires_at) WHERE status = 'staging';

CREATE TABLE blobs (
    library_id BYTEA NOT NULL,
    file_id BYTEA NOT NULL,
    hash BYTEA NOT NULL CHECK (octet_length(hash) = 32),
    ciphertext BYTEA STORAGE EXTERNAL NOT NULL CHECK (octet_length(ciphertext) BETWEEN 16 AND 4194368),
    committed_at_sequence BIGINT,
    staging_expires_at BIGINT,
    PRIMARY KEY (library_id, file_id, hash),
    FOREIGN KEY (library_id, file_id) REFERENCES files(library_id, file_id),
    FOREIGN KEY (library_id, committed_at_sequence) REFERENCES blocks(library_id, sequence),
    CHECK (hash = sha256(ciphertext)),
    CHECK ((committed_at_sequence IS NULL AND staging_expires_at IS NOT NULL AND staging_expires_at >= 0)
        OR (committed_at_sequence IS NOT NULL AND staging_expires_at IS NULL))
);
CREATE INDEX blobs_staging_expiry ON blobs(staging_expires_at) WHERE committed_at_sequence IS NULL;

CREATE TABLE registration_codes (
    code_hash BYTEA PRIMARY KEY CHECK (octet_length(code_hash) = 32),
    expires_at BIGINT NOT NULL,
    max_content_bytes BIGINT NOT NULL DEFAULT 536870912 CHECK (max_content_bytes BETWEEN 0 AND 9007199254740991),
    max_files BIGINT NOT NULL DEFAULT 10000 CHECK (max_files BETWEEN 0 AND 9007199254740991)
);
CREATE INDEX registration_codes_expires ON registration_codes(expires_at);

CREATE TABLE nonces (
    nonce TEXT PRIMARY KEY,
    expires BIGINT NOT NULL
);
CREATE INDEX nonces_expires ON nonces(expires);

CREATE FUNCTION preserve_block() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'chain records are immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER blocks_immutable BEFORE UPDATE OR DELETE ON blocks
    FOR EACH ROW EXECUTE FUNCTION preserve_block();

CREATE FUNCTION preserve_device() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'device history is permanent' USING ERRCODE = '23514';
    END IF;
    IF (NEW.public_key, NEW.library_id, NEW.kind, NEW.authorized_at_sequence)
       IS DISTINCT FROM (OLD.public_key, OLD.library_id, OLD.kind, OLD.authorized_at_sequence)
       OR (OLD.revoked_at_sequence IS NOT NULL AND NEW.revoked_at_sequence IS DISTINCT FROM OLD.revoked_at_sequence) THEN
        RAISE EXCEPTION 'device identity and revocation are immutable' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER devices_immutable_identity BEFORE UPDATE OR DELETE ON library_keys
    FOR EACH ROW EXECUTE FUNCTION preserve_device();

CREATE FUNCTION preserve_file() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.status <> 'staging' THEN
            RAISE EXCEPTION 'published file identities are permanent' USING ERRCODE = '23514';
        END IF;
        RETURN OLD;
    END IF;
    IF (NEW.library_id, NEW.file_id) IS DISTINCT FROM (OLD.library_id, OLD.file_id)
       OR (OLD.status = 'staging' AND NEW.status NOT IN ('staging', 'retained'))
       OR (OLD.status = 'retained' AND NEW.status NOT IN ('retained', 'purged'))
       OR (OLD.status = 'purged' AND NEW.status <> 'purged') THEN
        RAISE EXCEPTION 'file identity and purge are immutable' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER files_immutable_identity BEFORE UPDATE OR DELETE ON files
    FOR EACH ROW EXECUTE FUNCTION preserve_file();

CREATE FUNCTION preserve_blob() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.committed_at_sequence IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM files WHERE library_id = OLD.library_id
                AND file_id = OLD.file_id AND status = 'purged'
        ) THEN
            RAISE EXCEPTION 'committed blobs require explicit file purge' USING ERRCODE = '23514';
        END IF;
        RETURN OLD;
    END IF;
    IF (NEW.library_id, NEW.file_id, NEW.hash, NEW.ciphertext)
       IS DISTINCT FROM (OLD.library_id, OLD.file_id, OLD.hash, OLD.ciphertext)
       OR (OLD.committed_at_sequence IS NOT NULL AND NEW IS DISTINCT FROM OLD) THEN
        RAISE EXCEPTION 'blob bytes and commitment are immutable' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER blobs_immutable BEFORE UPDATE OR DELETE ON blobs
    FOR EACH ROW EXECUTE FUNCTION preserve_blob();
