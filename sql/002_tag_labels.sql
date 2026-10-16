ALTER TABLE tags ADD COLUMN label BYTEA NOT NULL DEFAULT ''::bytea
    CHECK (octet_length(label) = 0 OR
           (octet_length(label) BETWEEN 30 AND 285 AND get_byte(label, 0) = 1));
