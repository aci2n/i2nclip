//! Ciphertext staging and cleanup, serialized with the same library lock as appends.

use sqlx::Row;

use super::{chain::lock_library, Database};
use crate::{
    chain::{self, Hash},
    Error,
};

const STAGING_SECS: i64 = 24 * 60 * 60;

impl Database {
    pub(crate) async fn stage_blob(
        &self,
        signer: Hash,
        file: Hash,
        ciphertext: &[u8],
    ) -> Result<Hash, Error> {
        if !(16..=chain::MAX_BLOB_BYTES).contains(&ciphertext.len()) {
            return Err(Error::BadRequest("invalid ciphertext length".into()));
        }
        let hash = chain::digest(ciphertext);
        let mut tx = self.pool.begin().await?;
        let library = lock_library(&mut tx, &signer).await?;
        let now = crate::crypto::now_secs() as i64;
        let file_row: Option<(String, Option<i64>)> = sqlx::query_as(
            "SELECT status, staging_expires_at FROM files WHERE library_id = $1 AND file_id = $2",
        )
        .bind(&library.id)
        .bind(file.as_slice())
        .fetch_optional(&mut *tx)
        .await?;
        let status = file_row.as_ref().map(|row| row.0.as_str());
        if status == Some("purged")
            || file_row
                .as_ref()
                .is_some_and(|row| row.0 == "staging" && row.1.is_none_or(|expires| expires <= now))
        {
            return Err(Error::Conflict);
        }
        let identical: Option<bool> = sqlx::query_scalar(
            r#"
            SELECT ciphertext = $4
                AND (committed_at_sequence IS NOT NULL OR $5 OR staging_expires_at > $6)
            FROM blobs
            WHERE library_id = $1 AND file_id = $2 AND hash = $3
            "#,
        )
        .bind(&library.id)
        .bind(file.as_slice())
        .bind(hash.as_slice())
        .bind(ciphertext)
        .bind(status == Some("staging"))
        .bind(now)
        .fetch_optional(&mut *tx)
        .await?;
        if let Some(identical) = identical {
            return if identical {
                Ok(hash)
            } else {
                Err(Error::Conflict)
            };
        }
        let new_file = i64::from(status.is_none());
        let reserved = sqlx::query(
            r#"
            UPDATE libraries
            SET used_blob_bytes = used_blob_bytes+$2, retained_files = retained_files+$3
            WHERE id = $1
            AND used_blob_bytes <= max_blob_bytes-$2
            AND retained_files <= max_files-$3
            "#,
        )
        .bind(&library.id)
        .bind(ciphertext.len() as i64)
        .bind(new_file)
        .execute(&mut *tx)
        .await?;
        if reserved.rows_affected() != 1 {
            return Err(Error::StorageLimit);
        }
        let expires = now.saturating_add(STAGING_SECS);
        if new_file == 1 {
            sqlx::query(
                r#"
                INSERT INTO files(library_id, file_id, status, staging_expires_at)
                VALUES ($1, $2, 'staging', $3)
                "#,
            )
            .bind(&library.id)
            .bind(file.as_slice())
            .bind(expires)
            .execute(&mut *tx)
            .await?;
        } else if status == Some("staging") {
            sqlx::query(
                "UPDATE files SET staging_expires_at = $3 WHERE library_id = $1 AND file_id = $2",
            )
            .bind(&library.id)
            .bind(file.as_slice())
            .bind(expires)
            .execute(&mut *tx)
            .await?;
        }
        sqlx::query(
            r#"
            INSERT INTO blobs(library_id, file_id, hash, ciphertext, staging_expires_at)
            VALUES ($1, $2, $3, $4, $5)
            "#,
        )
        .bind(&library.id)
        .bind(file.as_slice())
        .bind(hash.as_slice())
        .bind(ciphertext)
        .bind(expires)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(hash)
    }

    pub(crate) async fn read_blob(
        &self,
        signer: Hash,
        file: Hash,
        hash: Hash,
    ) -> Result<Vec<u8>, Error> {
        sqlx::query_scalar(
            r#"
            SELECT b.ciphertext
            FROM blobs b
            JOIN libraries d ON d.id = b.library_id
            JOIN files f ON f.library_id = b.library_id
            AND f.file_id = b.file_id
            WHERE d.signing_public_key = $1
            AND b.file_id = $2
            AND b.hash = $3
            AND b.committed_at_sequence IS NOT NULL
            AND f.status = 'retained'
            "#,
        )
        .bind(signer.as_slice())
        .bind(file.as_slice())
        .bind(hash.as_slice())
        .fetch_optional(&self.pool)
        .await?
        .ok_or(Error::NotFound)
    }

    pub(crate) async fn maintain(&self, now: i64) -> Result<(u64, u64, u64, i64), Error> {
        let mut tx = self.pool.begin().await?;
        let nonces = sqlx::query("DELETE FROM nonces WHERE expires < $1")
            .bind(now)
            .execute(&mut *tx)
            .await?
            .rows_affected();
        let codes = sqlx::query("DELETE FROM registration_codes WHERE expires_at <= $1")
            .bind(now)
            .execute(&mut *tx)
            .await?
            .rows_affected();
        tx.commit().await?;
        let candidates: Vec<Vec<u8>> = sqlx::query_scalar(
            r#"
            SELECT DISTINCT f.library_id
            FROM files f
            WHERE (f.status = 'staging'
            AND f.staging_expires_at <= $1) OR (f.status = 'retained'
            AND EXISTS(SELECT 1
            FROM blobs b
            WHERE b.library_id = f.library_id
            AND b.file_id = f.file_id
            AND b.committed_at_sequence IS NULL
            AND b.staging_expires_at <= $1))
            "#,
        )
        .bind(now)
        .fetch_all(&self.pool)
        .await?;
        let mut expired_files = 0;
        let mut reclaimed = 0;
        for library in candidates {
            let mut tx = self.pool.begin().await?;
            let owned: Option<Vec<u8>> =
                sqlx::query_scalar("SELECT id FROM libraries WHERE id = $1 FOR UPDATE SKIP LOCKED")
                    .bind(&library)
                    .fetch_optional(&mut *tx)
                    .await?;
            if owned.is_none() {
                continue;
            }
            // A staging file's newest genuine byte progress protects all its chunks.
            let sizes: Vec<i64> = sqlx::query_scalar(
                r#"
                DELETE
                FROM blobs b
                USING files f
                WHERE b.library_id = $1
                AND f.library_id = b.library_id
                AND f.file_id = b.file_id
                AND b.committed_at_sequence IS NULL
                AND ((f.status = 'staging'
                AND f.staging_expires_at <= $2) OR (f.status = 'retained'
                AND b.staging_expires_at <= $2))
                RETURNING octet_length(b.ciphertext)::bigint
                "#,
            )
            .bind(&library)
            .bind(now)
            .fetch_all(&mut *tx)
            .await?;
            let files = sqlx::query(
                r#"
                DELETE
                FROM files
                WHERE library_id = $1
                AND status = 'staging'
                AND staging_expires_at <= $2
                "#,
            )
            .bind(&library)
            .bind(now)
            .execute(&mut *tx)
            .await?
            .rows_affected();
            let bytes: i64 = sizes.into_iter().sum();
            sqlx::query(
                r#"
                UPDATE libraries
                SET used_blob_bytes = used_blob_bytes-$2, retained_files = retained_files-$3
                WHERE id = $1
                "#,
            )
            .bind(&library)
            .bind(bytes)
            .bind(files as i64)
            .execute(&mut *tx)
            .await?;
            tx.commit().await?;
            expired_files += files;
            reclaimed += bytes;
        }
        Ok((nonces, codes, expired_files, reclaimed))
    }

    pub(crate) async fn log_bytes(&self, signer: Hash) -> Result<i64, Error> {
        let row = sqlx::query(
            r#"
            SELECT COALESCE((SELECT sum(octet_length(b.signed_body)+octet_length(b.signature))
            FROM blocks b
            WHERE b.library_id = d.id), 0)::bigint AS bytes
            FROM libraries d
            WHERE d.signing_public_key = $1
            "#,
        )
        .bind(signer.as_slice())
        .fetch_optional(&self.pool)
        .await?
        .ok_or(Error::Unauthorized)?;
        Ok(row.try_get("bytes")?)
    }
}
