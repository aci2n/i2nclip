-- One-time upgrade from the pre-quota schema. Stop servers and back up first.
-- psql --single-transaction -v ON_ERROR_STOP=1 --file sql/002_storage_limits.sql
-- Use the same database connection configuration as the server.
SELECT pg_advisory_xact_lock(1764904547, 1);

CREATE TABLE IF NOT EXISTS key_quotas (
    public_key BYTEA PRIMARY KEY REFERENCES registered_keys (public_key),
    max_content_bytes BIGINT NOT NULL DEFAULT 536870912 CHECK (max_content_bytes >= 0),
    max_files BIGINT NOT NULL DEFAULT 10000 CHECK (max_files >= 0),
    used_content_bytes BIGINT NOT NULL DEFAULT 0 CHECK (used_content_bytes >= 0),
    file_count BIGINT NOT NULL DEFAULT 0 CHECK (file_count >= 0),
    CONSTRAINT key_quotas_content_limit CHECK (used_content_bytes <= max_content_bytes),
    CONSTRAINT key_quotas_files_limit CHECK (file_count <= max_files)
);

ALTER TABLE registration_codes
    ADD COLUMN IF NOT EXISTS max_content_bytes BIGINT NOT NULL DEFAULT 536870912 CHECK (max_content_bytes >= 0),
    ADD COLUMN IF NOT EXISTS max_files BIGINT NOT NULL DEFAULT 10000 CHECK (max_files >= 0);

ALTER TABLE files
    ADD COLUMN IF NOT EXISTS content_bytes BIGINT GENERATED ALWAYS AS (octet_length(content)) STORED;

-- Existing quota rows retain limits and counters on repeat manual execution.
-- Preserve over-default libraries by setting initial limits to at least usage.
INSERT INTO key_quotas (public_key, max_content_bytes, max_files, used_content_bytes, file_count)
SELECT k.public_key,
       GREATEST(536870912, COALESCE(SUM(f.content_bytes), 0)),
       GREATEST(10000, COUNT(f.id)),
       COALESCE(SUM(f.content_bytes), 0), COUNT(f.id)
FROM registered_keys k
LEFT JOIN files f ON f.owner = k.public_key
WHERE NOT EXISTS (SELECT 1 FROM key_quotas q WHERE q.public_key = k.public_key)
GROUP BY k.public_key
ON CONFLICT (public_key) DO NOTHING;
