ALTER TABLE tags DROP CONSTRAINT tags_label_check;
ALTER TABLE tags ADD CONSTRAINT tags_label_check
    CHECK (octet_length(label) = 0 OR octet_length(label) BETWEEN 30 AND 1024);
