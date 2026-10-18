ALTER TABLE key_quotas
    ADD COLUMN max_file_plaintext_bytes BIGINT NOT NULL DEFAULT 33554432
    CHECK (max_file_plaintext_bytes BETWEEN 0 AND 536870912);

ALTER TABLE registration_codes
    ADD COLUMN max_file_plaintext_bytes BIGINT NOT NULL DEFAULT 33554432
    CHECK (max_file_plaintext_bytes BETWEEN 0 AND 536870912);

ALTER TABLE files DROP CONSTRAINT files_content_check;
ALTER TABLE files ADD CONSTRAINT files_content_check
    CHECK (octet_length(content) BETWEEN 42 AND 536870976);
