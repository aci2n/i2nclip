//! Append serialization and public storage/membership effects.

use serde::Serialize;
use serde_bytes::ByteBuf;
use sqlx::{Postgres, Row, Transaction};

use super::Database;
use crate::{
    chain::{self, Effects, Hash, Kind, Record, StorageEffect},
    Error,
};

#[derive(sqlx::FromRow)]
pub(super) struct Library {
    pub(super) id: Vec<u8>,
    pub(super) head_hash: Vec<u8>,
    pub(super) head_sequence: i64,
    pub(super) epoch: i64,
}

#[derive(Serialize)]
pub(crate) struct AppendReceipt(ByteBuf, u64, ByteBuf, u64);
#[derive(Serialize)]
pub(crate) struct BlockPage(ByteBuf, u64, Vec<ByteBuf>, Option<ByteBuf>);

pub(super) async fn lock_member(
    tx: &mut Transaction<'_, Postgres>,
    signer: &Hash,
) -> Result<Library, Error> {
    let library = sqlx::query_as::<_,Library>("SELECT l.id,l.head_hash,l.head_sequence,l.epoch FROM libraries l JOIN devices d ON d.library_id=l.id WHERE d.public_key=$1 FOR UPDATE OF l")
        .bind(signer.as_slice()).fetch_optional(&mut **tx).await?.ok_or(Error::Unauthorized)?;
    // A joining device row can be a pre-lock snapshot. Recheck after owning the lock.
    let active: bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM devices WHERE public_key=$1 AND library_id=$2 AND revoked_at_sequence IS NULL)")
        .bind(signer.as_slice()).bind(&library.id).fetch_one(&mut **tx).await?;
    if !active {
        return Err(Error::Unauthorized);
    }
    Ok(library)
}

impl Database {
    pub(crate) async fn append_record(
        &self,
        signer: Hash,
        bytes: &[u8],
    ) -> Result<AppendReceipt, Error> {
        let record = chain::verify_record(bytes)?;
        if signer != record.body.signer {
            return Err(Error::Unauthorized);
        }
        let mut tx = self.pool.begin().await?;
        let library = lock_member(&mut tx, &signer).await?;
        if library.id != record.body.library {
            return Err(Error::Unauthorized);
        }
        let duplicate: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM blocks WHERE library_id=$1 AND hash=$2)",
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
            || library.epoch != record.body.epoch as i64
        {
            return Err(Error::Conflict);
        }
        sqlx::query("INSERT INTO blocks(library_id,sequence,hash,previous_hash,signer_key,signed_body,signature) VALUES($1,$2,$3,$4,$5,$6,$7)")
            .bind(&library.id).bind(record.body.sequence as i64).bind(record.hash.as_slice()).bind(record.body.previous.as_slice())
            .bind(signer.as_slice()).bind(&record.signed_body).bind(&record.signature).execute(&mut *tx).await?;
        apply_effects(&mut tx, &record).await?;
        let epoch = match &record.body.effects {
            Effects::Rotation((epoch, _)) => *epoch,
            _ => record.body.epoch,
        };
        sqlx::query("UPDATE libraries SET head_hash=$2,head_sequence=$3,epoch=$4 WHERE id=$1")
            .bind(&library.id)
            .bind(record.hash.as_slice())
            .bind(record.body.sequence as i64)
            .bind(epoch as i64)
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
        let library=sqlx::query_as::<_,Library>("SELECT l.id,l.head_hash,l.head_sequence,l.epoch FROM libraries l JOIN devices d ON d.library_id=l.id WHERE d.public_key=$1 AND d.revoked_at_sequence IS NULL")
            .bind(signer.as_slice()).fetch_optional(&self.pool).await?.ok_or(Error::Unauthorized)?;
        let target = until.map_or_else(|| library.head_hash.clone(), |hash| hash.to_vec());
        let after_seq = self.anchor_sequence(&library, &after).await?;
        let target_seq = self.anchor_sequence(&library, &target).await?;
        if after_seq > target_seq || target_seq > library.head_sequence {
            return Err(Error::Conflict);
        }
        let rows=sqlx::query("SELECT sequence,hash,signed_body,signature FROM blocks WHERE library_id=$1 AND sequence>$2 AND sequence<=$3 ORDER BY sequence LIMIT $4")
            .bind(&library.id).bind(after_seq).bind(target_seq).bind(chain::MAX_PAGE_BLOCKS as i64).fetch_all(&self.pool).await?;
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
        sqlx::query_scalar("SELECT sequence FROM blocks WHERE library_id=$1 AND hash=$2")
            .bind(&library.id)
            .bind(hash)
            .fetch_optional(&self.pool)
            .await?
            .ok_or(Error::Conflict)
    }
}

async fn apply_effects(tx: &mut Transaction<'_, Postgres>, record: &Record) -> Result<(), Error> {
    let library = &record.body.library;
    let sequence = record.body.sequence as i64;
    match (&record.body.kind, &record.body.effects) {
        (Kind::Data, Effects::Storage(effects)) => {
            for effect in effects {
                storage_effect(tx, record, effect).await?;
            }
        }
        (Kind::Enroll, Effects::Device((key,))) => {
            enroll(tx, library, key, sequence).await?;
        }
        (Kind::Revoke, Effects::Device((key,))) => {
            let count: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM devices WHERE library_id=$1 AND revoked_at_sequence IS NULL",
            )
            .bind(library.as_slice())
            .fetch_one(&mut **tx)
            .await?;
            if count <= 1 {
                return Err(Error::Conflict);
            }
            let revoked=sqlx::query("UPDATE devices SET revoked_at_sequence=$3 WHERE library_id=$1 AND public_key=$2 AND revoked_at_sequence IS NULL")
                .bind(library.as_slice()).bind(key.as_ref()).bind(sequence).execute(&mut **tx).await?;
            if revoked.rows_affected() != 1 {
                return Err(Error::Conflict);
            }
        }
        (Kind::Rotate, Effects::Rotation((next, key))) => {
            if *next != record.body.epoch + 1 {
                return Err(Error::Conflict);
            }
            sqlx::query("UPDATE devices SET revoked_at_sequence=$2 WHERE library_id=$1 AND revoked_at_sequence IS NULL")
                .bind(library.as_slice()).bind(sequence).execute(&mut **tx).await?;
            enroll(tx, library, key, sequence).await?;
        }
        _ => return Err(Error::BadRequest("invalid public effects".into())),
    }
    Ok(())
}

async fn enroll(
    tx: &mut Transaction<'_, Postgres>,
    library: &Hash,
    key: &[u8],
    sequence: i64,
) -> Result<(), Error> {
    let inserted=sqlx::query("INSERT INTO devices(public_key,library_id,authorized_at_sequence) VALUES($1,$2,$3) ON CONFLICT DO NOTHING")
        .bind(key).bind(library.as_slice()).bind(sequence).execute(&mut **tx).await?;
    if inserted.rows_affected() != 1 {
        return Err(Error::Conflict);
    }
    Ok(())
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
            let status: Option<String> =
                sqlx::query_scalar("SELECT status FROM files WHERE library_id=$1 AND file_id=$2")
                    .bind(library.as_slice())
                    .bind(file.as_slice())
                    .fetch_optional(&mut **tx)
                    .await?;
            if status.as_deref() != Some("staging") {
                return Err(Error::Conflict);
            }
            let rows=sqlx::query("SELECT hash,octet_length(ciphertext)::bigint AS size FROM blobs WHERE library_id=$1 AND file_id=$2 AND committed_at_sequence IS NULL")
                .bind(library.as_slice()).bind(file.as_slice()).fetch_all(&mut **tx).await?;
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
            sqlx::query("UPDATE blobs SET committed_at_sequence=$3,staging_expires_at=NULL WHERE library_id=$1 AND file_id=$2 AND committed_at_sequence IS NULL")
                .bind(library.as_slice()).bind(file.as_slice()).bind(sequence).execute(&mut **tx).await?;
            sqlx::query("UPDATE files SET status='retained',staging_expires_at=NULL WHERE library_id=$1 AND file_id=$2")
                .bind(library.as_slice()).bind(file.as_slice()).execute(&mut **tx).await?;
        }
        StorageEffect::Commit { file, hashes } => {
            let status: Option<String> =
                sqlx::query_scalar("SELECT status FROM files WHERE library_id=$1 AND file_id=$2")
                    .bind(library.as_slice())
                    .bind(file.as_slice())
                    .fetch_optional(&mut **tx)
                    .await?;
            if status.as_deref() != Some("retained") {
                return Err(Error::Conflict);
            }
            for hash in hashes {
                let updated=sqlx::query("UPDATE blobs SET committed_at_sequence=$4,staging_expires_at=NULL WHERE library_id=$1 AND file_id=$2 AND hash=$3 AND committed_at_sequence IS NULL")
                    .bind(library.as_slice()).bind(file.as_slice()).bind(hash.as_slice()).bind(sequence).execute(&mut **tx).await?;
                if updated.rows_affected() != 1 {
                    return Err(Error::Conflict);
                }
            }
        }
        StorageEffect::Purge { files } => {
            for file in files {
                let updated=sqlx::query("UPDATE files SET status='purged' WHERE library_id=$1 AND file_id=$2 AND status='retained'")
                    .bind(library.as_slice()).bind(file.as_slice()).execute(&mut **tx).await?;
                if updated.rows_affected() != 1 {
                    return Err(Error::Conflict);
                }
                let bytes:i64=sqlx::query_scalar("SELECT COALESCE(sum(octet_length(ciphertext)),0)::bigint FROM blobs WHERE library_id=$1 AND file_id=$2")
                    .bind(library.as_slice()).bind(file.as_slice()).fetch_one(&mut **tx).await?;
                sqlx::query("DELETE FROM blobs WHERE library_id=$1 AND file_id=$2")
                    .bind(library.as_slice())
                    .bind(file.as_slice())
                    .execute(&mut **tx)
                    .await?;
                sqlx::query("UPDATE libraries SET used_blob_bytes=used_blob_bytes-$2,retained_files=retained_files-1 WHERE id=$1")
                    .bind(library.as_slice()).bind(bytes).execute(&mut **tx).await?;
            }
        }
    }
    Ok(())
}
