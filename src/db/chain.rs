//! Append serialization and public storage effects.

use serde::Serialize;
use serde_bytes::ByteBuf;
use sqlx::{PgExecutor, Postgres, Row, Transaction};

use super::Database;
use crate::{
    chain::{self, Hash, Record, StorageEffect},
    Error,
};

#[derive(sqlx::FromRow)]
pub(super) struct Library {
    pub(super) id: Vec<u8>,
    pub(super) head_hash: Vec<u8>,
    pub(super) head_sequence: i64,
    signing_public_key: Vec<u8>,
    genesis: Vec<u8>,
}
impl Library {
    fn validate_authority(&self) -> Result<Hash, Error> {
        let public = chain::parse_genesis(&self.genesis)?;
        if public.as_slice() != self.signing_public_key {
            return Err(Error::Crypto);
        }
        Ok(public)
    }
}

#[derive(Serialize)]
pub(crate) struct AppendReceipt(ByteBuf, u64, ByteBuf, u64);
#[derive(Serialize)]
pub(crate) struct BlockPage(ByteBuf, u64, Vec<ByteBuf>, Option<ByteBuf>);

const LIBRARY_BY_KEY: &str = r#"
SELECT id, head_hash, head_sequence, signing_public_key, genesis
FROM libraries
WHERE signing_public_key = $1
"#;

pub(super) async fn lock_library(
    tx: &mut Transaction<'_, Postgres>,
    signer: &Hash,
) -> Result<Library, Error> {
    find_library(&mut **tx, &format!("{LIBRARY_BY_KEY} FOR UPDATE"), signer).await
}

/// The library registered to this key, with its stored genesis revalidated.
async fn find_library<'e>(
    executor: impl PgExecutor<'e>,
    query: &str,
    signer: &Hash,
) -> Result<Library, Error> {
    let library = sqlx::query_as::<_, Library>(query)
        .bind(signer.as_slice())
        .fetch_optional(executor)
        .await?
        .ok_or(Error::Unauthorized)?;
    library.validate_authority()?;
    Ok(library)
}

impl Database {
    pub(crate) async fn append_record(
        &self,
        signer: Hash,
        bytes: &[u8],
    ) -> Result<AppendReceipt, Error> {
        let record = chain::verify_record(bytes, &signer)?;
        let mut tx = self.pool.begin().await?;
        let library = lock_library(&mut tx, &signer).await?;
        if library.id != record.body.library {
            return Err(Error::Unauthorized);
        }
        let duplicate: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM blocks WHERE library_id = $1 AND hash = $2)",
        )
        .bind(&library.id)
        .bind(record.hash.as_slice())
        .fetch_one(&mut *tx)
        .await?;
        if duplicate {
            return Ok(AppendReceipt(
                ByteBuf::from(record.hash.to_vec()),
                record.body.sequence,
                ByteBuf::from(library.head_hash),
                library.head_sequence as u64,
            ));
        }
        if library.head_hash != record.body.previous
            || library.head_sequence + 1 != record.body.sequence as i64
        {
            return Err(Error::Conflict);
        }
        sqlx::query(
            r#"
            INSERT INTO blocks
                (library_id, sequence, hash, previous_hash, signed_body, signature)
            VALUES ($1, $2, $3, $4, $5, $6)
            "#,
        )
        .bind(&library.id)
        .bind(record.body.sequence as i64)
        .bind(record.hash.as_slice())
        .bind(record.body.previous.as_slice())
        .bind(&record.signed_body)
        .bind(&record.signature)
        .execute(&mut *tx)
        .await?;
        for effect in &record.body.effects {
            storage_effect(&mut tx, &record, effect).await?;
        }
        sqlx::query("UPDATE libraries SET head_hash = $2, head_sequence = $3 WHERE id = $1")
            .bind(&library.id)
            .bind(record.hash.as_slice())
            .bind(record.body.sequence as i64)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(AppendReceipt(
            ByteBuf::from(record.hash.to_vec()),
            record.body.sequence,
            ByteBuf::from(record.hash.to_vec()),
            record.body.sequence,
        ))
    }

    pub(crate) async fn block_page(
        &self,
        signer: Hash,
        after: Hash,
        until: Option<Hash>,
    ) -> Result<BlockPage, Error> {
        let library = find_library(&self.pool, LIBRARY_BY_KEY, &signer).await?;
        let target = until.map_or_else(|| library.head_hash.clone(), |hash| hash.to_vec());
        let after_seq = self.anchor_sequence(&library, &after).await?;
        let target_seq = self.anchor_sequence(&library, &target).await?;
        if after_seq > target_seq || target_seq > library.head_sequence {
            return Err(Error::Conflict);
        }
        let rows = sqlx::query(
            r#"
            SELECT sequence, hash, signed_body, signature
            FROM blocks
            WHERE library_id = $1
            AND sequence > $2
            AND sequence <= $3
            ORDER BY sequence
            LIMIT $4
            "#,
        )
        .bind(&library.id)
        .bind(after_seq)
        .bind(target_seq)
        .bind(chain::MAX_PAGE_BLOCKS as i64)
        .fetch_all(&self.pool)
        .await?;
        let mut records = Vec::new();
        let mut used = 256;
        let mut last_seq = after_seq;
        let mut last_hash = after.to_vec();
        for row in rows {
            let signed: Vec<u8> = row.try_get("signed_body")?;
            let signature: Vec<u8> = row.try_get("signature")?;
            let encoded = rmp_serde::to_vec(&(ByteBuf::from(signed), ByteBuf::from(signature)))
                .map_err(|_| Error::Crypto)?;
            if used + encoded.len() + 5 > chain::MAX_PAGE_BYTES {
                break;
            }
            used += encoded.len() + 5;
            last_seq = row.try_get("sequence")?;
            last_hash = row.try_get("hash")?;
            records.push(ByteBuf::from(encoded));
        }
        if last_seq == after_seq && after_seq < target_seq {
            return Err(Error::Conflict);
        }
        Ok(BlockPage(
            ByteBuf::from(target),
            target_seq as u64,
            records,
            if last_seq < target_seq {
                Some(ByteBuf::from(last_hash))
            } else {
                None
            },
        ))
    }

    async fn anchor_sequence(&self, library: &Library, hash: &[u8]) -> Result<i64, Error> {
        if hash == library.id {
            return Ok(0);
        }
        sqlx::query_scalar("SELECT sequence FROM blocks WHERE library_id = $1 AND hash = $2")
            .bind(&library.id)
            .bind(hash)
            .fetch_optional(&self.pool)
            .await?
            .ok_or(Error::Conflict)
    }
}

async fn storage_effect(
    tx: &mut Transaction<'_, Postgres>,
    record: &Record,
    effect: &StorageEffect,
) -> Result<(), Error> {
    let library = &record.body.library;
    let sequence = record.body.sequence as i64;
    match effect {
        StorageEffect::Publish { file, inventory } => {
            let status: Option<String> = sqlx::query_scalar(
                r#"
                SELECT status
                FROM files
                WHERE library_id = $1
                AND file_id = $2
                AND staging_expires_at > $3
                "#,
            )
            .bind(library.as_slice())
            .bind(file.as_slice())
            .bind(crate::crypto::now_secs() as i64)
            .fetch_optional(&mut **tx)
            .await?;
            if status.as_deref() != Some("staging") {
                return Err(Error::Conflict);
            }
            let rows = sqlx::query(
                r#"
                SELECT hash, octet_length(ciphertext)::bigint AS size
                FROM blobs
                WHERE library_id = $1
                AND file_id = $2
                AND committed_at_sequence IS NULL
                "#,
            )
            .bind(library.as_slice())
            .bind(file.as_slice())
            .fetch_all(&mut **tx)
            .await?;
            let mut entries = Vec::new();
            for row in rows {
                let hash: Vec<u8> = row.try_get("hash")?;
                entries.push((
                    hash.try_into().map_err(|_| Error::Crypto)?,
                    row.try_get::<i64, _>("size")? as u64,
                ));
            }
            if entries.is_empty() || chain::inventory_digest(library, file, &entries)? != *inventory
            {
                return Err(Error::Conflict);
            }
            sqlx::query(
                r#"
                UPDATE blobs
                SET committed_at_sequence = $3, staging_expires_at = NULL
                WHERE library_id = $1
                AND file_id = $2
                AND committed_at_sequence IS NULL
                "#,
            )
            .bind(library.as_slice())
            .bind(file.as_slice())
            .bind(sequence)
            .execute(&mut **tx)
            .await?;
            sqlx::query(
                r#"
                UPDATE files
                SET status = 'retained', staging_expires_at = NULL
                WHERE library_id = $1
                AND file_id = $2
                "#,
            )
            .bind(library.as_slice())
            .bind(file.as_slice())
            .execute(&mut **tx)
            .await?;
        }
        StorageEffect::Commit { file, hashes } => {
            let status: Option<String> = sqlx::query_scalar(
                "SELECT status FROM files WHERE library_id = $1 AND file_id = $2",
            )
            .bind(library.as_slice())
            .bind(file.as_slice())
            .fetch_optional(&mut **tx)
            .await?;
            if status.as_deref() != Some("retained") {
                return Err(Error::Conflict);
            }
            for hash in hashes {
                let updated = sqlx::query(
                    r#"
                    UPDATE blobs
                    SET committed_at_sequence = $4, staging_expires_at = NULL
                    WHERE library_id = $1
                    AND file_id = $2
                    AND hash = $3
                    AND committed_at_sequence IS NULL
                    AND staging_expires_at > $5
                    "#,
                )
                .bind(library.as_slice())
                .bind(file.as_slice())
                .bind(hash.as_slice())
                .bind(sequence)
                .bind(crate::crypto::now_secs() as i64)
                .execute(&mut **tx)
                .await?;
                if updated.rows_affected() != 1 {
                    return Err(Error::Conflict);
                }
            }
        }
        StorageEffect::Purge { file } => {
            let updated = sqlx::query(
                r#"
                UPDATE files
                SET status = 'purged'
                WHERE library_id = $1
                AND file_id = $2
                AND status = 'retained'
                "#,
            )
            .bind(library.as_slice())
            .bind(file.as_slice())
            .execute(&mut **tx)
            .await?;
            if updated.rows_affected() != 1 {
                return Err(Error::Conflict);
            }
            let bytes: i64 = sqlx::query_scalar(
                r#"
                SELECT COALESCE(sum(octet_length(ciphertext)), 0)::bigint
                FROM blobs
                WHERE library_id = $1
                AND file_id = $2
                "#,
            )
            .bind(library.as_slice())
            .bind(file.as_slice())
            .fetch_one(&mut **tx)
            .await?;
            sqlx::query("DELETE FROM blobs WHERE library_id = $1 AND file_id = $2")
                .bind(library.as_slice())
                .bind(file.as_slice())
                .execute(&mut **tx)
                .await?;
            sqlx::query(
                r#"
                UPDATE libraries
                SET used_blob_bytes = used_blob_bytes-$2, retained_files = retained_files-1
                WHERE id = $1
                "#,
            )
            .bind(library.as_slice())
            .bind(bytes)
            .execute(&mut **tx)
            .await?;
        }
    }
    Ok(())
}
