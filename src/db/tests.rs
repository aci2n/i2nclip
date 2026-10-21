use super::*;
use crate::codec;

// Own the temporary database even if a test assertion or initialization panics.
struct FixtureDatabase {
    name: String,
    admin_url: String,
    removed: bool,
}

impl Drop for FixtureDatabase {
    fn drop(&mut self) {
        if self.removed {
            return;
        }
        let name = self.name.clone();
        let admin_url = self.admin_url.clone();
        std::thread::spawn(move || {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap()
                .block_on(async move {
                    let admin = PgPool::connect(&admin_url).await.unwrap();
                    sqlx::query(&format!("DROP DATABASE {name} WITH (FORCE)"))
                        .execute(&admin)
                        .await
                        .unwrap();
                    admin.close().await;
                });
        })
        .join()
        .unwrap();
    }
}

async fn fixture() -> (Database, PgPool, FixtureDatabase) {
    let (db, admin, name) = empty_fixture().await;
    db.initialize().await.unwrap();
    (db, admin, name)
}

async fn empty_fixture() -> (Database, PgPool, FixtureDatabase) {
    let base = std::env::var("I2N_TEST_DATABASE_URL")
        .expect("set I2N_TEST_DATABASE_URL; real PostgreSQL is required");
    let admin = PgPool::connect(&base)
        .await
        .expect("test PostgreSQL unavailable");
    let name = format!(
        "i2nclip_db_{}_{}",
        std::process::id(),
        URL_SAFE_NO_PAD.encode(crypto::body_hash_bytes(
            crate::reference_crypto::fresh_nonce().as_bytes()
        ))
    )
    .to_lowercase()
    .replace('-', "_");
    sqlx::query(&format!("CREATE DATABASE {name}"))
        .execute(&admin)
        .await
        .unwrap();
    let mut url = url::Url::parse(&base).unwrap();
    url.set_path(&name);
    let guard = FixtureDatabase {
        name,
        admin_url: base,
        removed: false,
    };
    let db = Database::connect(url.as_str()).await.unwrap();
    (db, admin, guard)
}

async fn dispose(db: Database, admin: PgPool, mut fixture: FixtureDatabase) {
    db.close().await;
    sqlx::query(&format!("DROP DATABASE {} WITH (FORCE)", fixture.name))
        .execute(&admin)
        .await
        .unwrap();
    fixture.removed = true;
    admin.close().await;
}

async fn register(
    db: &Database,
    identity: &crate::reference_crypto::Identity,
    code: &str,
) -> Result<(), Error> {
    db.consume_code(
        code,
        &identity.public,
        &crate::chain::genesis_bytes(&identity.public)?,
        &crate::reference_crypto::fresh_nonce(),
        crypto::now_secs(),
    )
    .await
}
async fn chain_fixture() -> (
    Database,
    PgPool,
    FixtureDatabase,
    crate::reference_crypto::Identity,
    crate::chain::Hash,
) {
    let (db, admin, guard) = fixture().await;
    let identity = crate::reference_crypto::from_seed([7; 32]);
    let code = db.issue_code(3600, StorageLimits::default()).await.unwrap();
    register(&db, &identity, &code).await.unwrap();
    let library = crate::chain::genesis(&identity.public).unwrap();
    (db, admin, guard, identity, library)
}
fn signed_chain(
    body: &crate::chain::Body,
    identity: &crate::reference_crypto::Identity,
) -> Vec<u8> {
    use serde_bytes::ByteBuf;
    let signed = body.encode().unwrap();
    let signature = crate::reference_crypto::sign(
        &identity.seed,
        &[crate::chain::SIGN_DOMAIN, signed.as_slice()].concat(),
    );
    codec::encode(&(ByteBuf::from(signed), ByteBuf::from(signature.to_vec()))).unwrap()
}
fn block(
    identity: &crate::reference_crypto::Identity,
    library: crate::chain::Hash,
    sequence: u64,
    previous: crate::chain::Hash,
    effects: Vec<crate::chain::StorageEffect>,
) -> Vec<u8> {
    use serde_bytes::ByteBuf;
    signed_chain(
        &crate::chain::Body {
            version: 1,
            library,
            sequence,
            previous,
            effects,
            salt: ByteBuf::from(vec![1; 32]),
            nonce: ByteBuf::from(vec![2; 12]),
            encrypted: ByteBuf::from(vec![3; 16]),
        },
        identity,
    )
}
fn storage_record(
    identity: &crate::reference_crypto::Identity,
    library: crate::chain::Hash,
    sequence: u64,
    previous: crate::chain::Hash,
    effect: crate::chain::StorageEffect,
) -> Vec<u8> {
    block(identity, library, sequence, previous, vec![effect])
}

#[tokio::test]
async fn registration_is_atomic_idempotent_and_authority_is_immutable() {
    let (db, admin, guard) = fixture().await;
    let key = crate::reference_crypto::from_seed([7; 32]);
    let genesis = crate::chain::genesis_bytes(&key.public).unwrap();
    let nonce = "invalid-invitation";
    assert!(db
        .consume_code("invalid", &key.public, &genesis, nonce, crypto::now_secs())
        .await
        .is_err());
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM nonces")
            .fetch_one(&db.pool)
            .await
            .unwrap(),
        0
    );
    let code = db.issue_code(3600, StorageLimits::default()).await.unwrap();
    db.consume_code(&code, &key.public, &genesis, nonce, crypto::now_secs())
        .await
        .unwrap();
    assert!(matches!(
        db.consume_code(&code, &key.public, &genesis, nonce, crypto::now_secs())
            .await,
        Err(Error::Unauthorized)
    ));
    register(&db, &key, "already consumed").await.unwrap();
    db.initialize().await.unwrap();
    assert!(db.allowed(&key.public).await.unwrap());
    let row: (Vec<u8>, i64) = sqlx::query_as("SELECT head_hash,head_sequence FROM libraries")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(
        row,
        (crate::chain::genesis(&key.public).unwrap().to_vec(), 0)
    );
    assert!(sqlx::query("UPDATE libraries SET signing_public_key=$1")
        .bind([2u8; 32].as_slice())
        .execute(&db.pool)
        .await
        .is_err());
    dispose(db, admin, guard).await;
}
#[tokio::test]
async fn append_races_have_one_winner_and_exact_retries_do_not_reapply() {
    let (db, admin, guard, key, library) = chain_fixture().await;
    let first = block(&key, library, 1, library, vec![]);
    let mut alternate = crate::chain::verify_record(&first, &key.public)
        .unwrap()
        .body;
    alternate.nonce = serde_bytes::ByteBuf::from(vec![5; 12]);
    let second = signed_chain(&alternate, &key);
    let (left, right) = tokio::join!(
        db.append_record(key.public, &first),
        db.append_record(key.public, &second)
    );
    assert_ne!(left.is_ok(), right.is_ok());
    let winner = if left.is_ok() { first } else { second };
    db.append_record(key.public, &winner).await.unwrap();
    let outsider = crate::reference_crypto::from_seed([8; 32]);
    assert!(db.append_record(outsider.public, &winner).await.is_err());
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM blocks")
            .fetch_one(&db.pool)
            .await
            .unwrap(),
        1
    );
    assert!(sqlx::query("DELETE FROM blocks")
        .execute(&db.pool)
        .await
        .is_err());
    dispose(db, admin, guard).await;
}
#[tokio::test]
async fn chain_blobs_publish_versions_and_purge_all_bytes_atomically() {
    use crate::chain::{inventory_digest, verify_record, StorageEffect};
    let (db, admin, guard, identity, library) = chain_fixture().await;
    let file = [5; 32];
    let first = db
        .stage_blob(identity.public, file, &[1; 16])
        .await
        .unwrap();
    let second = db
        .stage_blob(identity.public, file, &[2; 17])
        .await
        .unwrap();
    db.stage_blob(identity.public, file, &[1; 16])
        .await
        .unwrap();
    let quota = db.quota(identity.public).await.unwrap();
    assert_eq!((quota.used_content_bytes, quota.file_count), (33, 1));
    assert!(matches!(
        db.read_blob(identity.public, file, first).await,
        Err(Error::NotFound)
    ));
    let wrong = storage_record(
        &identity,
        library,
        1,
        library,
        StorageEffect::Publish {
            file,
            inventory: [0; 32],
        },
    );
    assert!(matches!(
        db.append_record(identity.public, &wrong).await,
        Err(Error::Conflict)
    ));
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM blocks")
            .fetch_one(&db.pool)
            .await
            .unwrap(),
        0
    );
    let inventory = inventory_digest(&library, &file, &[(first, 16), (second, 17)]).unwrap();
    let publish = storage_record(
        &identity,
        library,
        1,
        library,
        StorageEffect::Publish { file, inventory },
    );
    db.append_record(identity.public, &publish).await.unwrap();
    assert_eq!(
        db.read_blob(identity.public, file, first).await.unwrap(),
        [1; 16]
    );
    let third = db
        .stage_blob(identity.public, file, &[3; 18])
        .await
        .unwrap();
    let commit = storage_record(
        &identity,
        library,
        2,
        verify_record(&publish, &identity.public).unwrap().hash,
        StorageEffect::Commit {
            file,
            hashes: vec![third],
        },
    );
    db.append_record(identity.public, &commit).await.unwrap();
    db.stage_blob(identity.public, file, &[4; 19])
        .await
        .unwrap();
    let purge = storage_record(
        &identity,
        library,
        3,
        verify_record(&commit, &identity.public).unwrap().hash,
        StorageEffect::Purge { files: vec![file] },
    );
    db.append_record(identity.public, &purge).await.unwrap();
    db.append_record(identity.public, &purge).await.unwrap();
    let quota = db.quota(identity.public).await.unwrap();
    assert_eq!((quota.used_content_bytes, quota.file_count), (0, 0));
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM blobs")
            .fetch_one(&db.pool)
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT status FROM files")
            .fetch_one(&db.pool)
            .await
            .unwrap(),
        "purged"
    );
    assert!(matches!(
        db.stage_blob(identity.public, file, &[1; 16]).await,
        Err(Error::Conflict)
    ));
    assert!(db.log_bytes(identity.public).await.unwrap() > 0);
    dispose(db, admin, guard).await;
}

#[tokio::test]
async fn chain_blobs_expiry_preserves_active_uploads_and_committed_history() {
    use crate::chain::{inventory_digest, StorageEffect};
    let (db, admin, guard, identity, library) = chain_fixture().await;
    let now = crypto::now_secs() as i64;
    let file = [5; 32];
    let hash = db
        .stage_blob(identity.public, file, &[1; 16])
        .await
        .unwrap();
    sqlx::query("UPDATE blobs SET staging_expires_at=0")
        .execute(&db.pool)
        .await
        .unwrap();
    assert_eq!(db.maintain(now).await.unwrap().3, 0);
    assert!(db.stage_blob(identity.public, file, &[1; 16]).await.is_ok());
    let before: i64 = sqlx::query_scalar("SELECT staging_expires_at FROM files")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    db.stage_blob(identity.public, file, &[1; 16])
        .await
        .unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT staging_expires_at FROM files")
            .fetch_one(&db.pool)
            .await
            .unwrap(),
        before
    );
    let publish = storage_record(
        &identity,
        library,
        1,
        library,
        StorageEffect::Publish {
            file,
            inventory: inventory_digest(&library, &file, &[(hash, 16)]).unwrap(),
        },
    );
    db.append_record(identity.public, &publish).await.unwrap();
    db.stage_blob(identity.public, file, &[2; 17])
        .await
        .unwrap();
    db.stage_blob(identity.public, [6; 32], &[3; 18])
        .await
        .unwrap();
    sqlx::query("UPDATE blobs SET staging_expires_at=0 WHERE committed_at_sequence IS NULL")
        .execute(&db.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE files SET staging_expires_at=0 WHERE status='staging'")
        .execute(&db.pool)
        .await
        .unwrap();
    assert!(matches!(
        db.stage_blob(identity.public, [6; 32], &[3; 18]).await,
        Err(Error::Conflict)
    ));
    assert_eq!(db.maintain(now).await.unwrap(), (0, 0, 1, 35));
    assert_eq!(
        db.read_blob(identity.public, file, hash).await.unwrap(),
        [1; 16]
    );
    let quota = db.quota(identity.public).await.unwrap();
    assert_eq!((quota.used_content_bytes, quota.file_count), (16, 1));
    assert_eq!(db.maintain(now).await.unwrap(), (0, 0, 0, 0));
    dispose(db, admin, guard).await;
}

#[tokio::test]
async fn chain_blobs_quota_races_and_busy_cleanup_are_bounded() {
    let (db, admin, guard, identity, library) = chain_fixture().await;
    db.set_limits(
        &identity.public,
        StorageLimits {
            max_content_bytes: 16,
            max_files: 1,
        },
    )
    .await
    .unwrap();
    let (left, right) = tokio::join!(
        db.stage_blob(identity.public, [5; 32], &[1; 16]),
        db.stage_blob(identity.public, [6; 32], &[2; 16])
    );
    assert!(matches!(
        (&left, &right),
        (Ok(_), Err(Error::StorageLimit)) | (Err(Error::StorageLimit), Ok(_))
    ));
    let quota = db.quota(identity.public).await.unwrap();
    assert_eq!((quota.used_content_bytes, quota.file_count), (16, 1));
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM files")
            .fetch_one(&db.pool)
            .await
            .unwrap(),
        1
    );
    sqlx::query("UPDATE files SET staging_expires_at=0")
        .execute(&db.pool)
        .await
        .unwrap();
    let mut lock = db.pool.begin().await.unwrap();
    sqlx::query("SELECT id FROM libraries WHERE id=$1 FOR UPDATE")
        .bind(library.as_slice())
        .fetch_one(&mut *lock)
        .await
        .unwrap();
    assert_eq!(
        tokio::time::timeout(
            Duration::from_secs(3),
            db.maintain(crypto::now_secs() as i64)
        )
        .await
        .unwrap()
        .unwrap()
        .3,
        0
    );
    lock.rollback().await.unwrap();
    assert_eq!(db.maintain(crypto::now_secs() as i64).await.unwrap().3, 16);
    dispose(db, admin, guard).await;
}

#[tokio::test]
async fn fixture_cleanup_survives_a_panicking_test() {
    let (db, admin, fixture) = empty_fixture().await;
    let name = fixture.name.clone();
    let failed = std::panic::catch_unwind(move || {
        let _owned = fixture;
        panic!("simulated test assertion failure");
    });
    assert!(failed.is_err());
    let remaining: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM pg_database WHERE datname = $1")
        .bind(name)
        .fetch_one(&admin)
        .await
        .unwrap();
    assert_eq!(remaining, 0);
    db.close().await;
    admin.close().await;
}

#[tokio::test]
async fn initialization_rejects_changed_migration_checksum() {
    let (db, admin, name) = empty_fixture().await;
    db.initialize().await.unwrap();
    sqlx::query("UPDATE _sqlx_migrations SET checksum = decode('00', 'hex') WHERE version = 1")
        .execute(&db.pool)
        .await
        .unwrap();
    assert!(matches!(
        db.initialize().await,
        Err(Error::Migration(
            sqlx::migrate::MigrateError::VersionMismatch(1)
        ))
    ));
    dispose(db, admin, name).await;
}

#[tokio::test]
async fn maintenance_boundaries_rollback_and_recovery() {
    let (db, admin, name) = fixture().await;
    sqlx::raw_sql(
        r#"
            INSERT INTO nonces (nonce, expires)
            VALUES ('past', 99), ('boundary', 100), ('future', 101);

            INSERT INTO registration_codes (code_hash, expires_at)
            VALUES
                (decode(repeat('01', 32), 'hex'), 99),
                (decode(repeat('02', 32), 'hex'), 100),
                (decode(repeat('03', 32), 'hex'), 101);

            CREATE FUNCTION fail_cleanup() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN
                RAISE EXCEPTION 'test failure';
            END;
            $$;

            CREATE TRIGGER fail_cleanup
                BEFORE DELETE ON registration_codes
                FOR EACH ROW EXECUTE FUNCTION fail_cleanup();
            "#,
    )
    .execute(&db.pool)
    .await
    .unwrap();
    assert!(db.maintain(100).await.is_err());
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM nonces")
            .fetch_one(&db.pool)
            .await
            .unwrap(),
        3
    );
    sqlx::query("DROP TRIGGER fail_cleanup ON registration_codes")
        .execute(&db.pool)
        .await
        .unwrap();
    assert_eq!(db.maintain(100).await.unwrap(), (1, 2, 0, 0));
    assert_eq!(db.maintain(100).await.unwrap(), (0, 0, 0, 0));
    assert_eq!(db.maintain(101).await.unwrap(), (1, 1, 0, 0));
    dispose(db, admin, name).await;
}

#[tokio::test]
async fn pool_reconnects_after_backend_termination() {
    let (db, admin, name) = fixture().await;
    sqlx::query(
        r#"
            SELECT pg_terminate_backend(pid)
            FROM pg_stat_activity
            WHERE datname = $1 AND pid <> pg_backend_pid()
            "#,
    )
    .bind(&name.name)
    .execute(&admin)
    .await
    .unwrap();
    let mut recovered = false;
    for _ in 0..3 {
        if db
            .allowed(&crate::reference_crypto::from_seed([1; 32]).public)
            .await
            .is_ok()
        {
            recovered = true;
            break;
        }
    }
    assert!(recovered);
    dispose(db, admin, name).await;
}

#[tokio::test]
async fn concurrent_nonce_reservation_has_one_winner() {
    let (db, admin, name) = fixture().await;
    let (a, b) = tokio::join!(
        db.remember_nonce("same-nonce", 100),
        db.remember_nonce("same-nonce", 100)
    );
    assert!(matches!(
        (a, b),
        (Ok(()), Err(Error::Unauthorized)) | (Err(Error::Unauthorized), Ok(()))
    ));
    assert!(matches!(
        db.remember_nonce("same-nonce", 100).await,
        Err(Error::Unauthorized)
    ));
    assert_eq!(
        db.maintain(100 + SKEW_SECS as i64).await.unwrap(),
        (0, 0, 0, 0)
    );
    assert_eq!(
        db.maintain(101 + SKEW_SECS as i64).await.unwrap(),
        (1, 0, 0, 0)
    );
    dispose(db, admin, name).await;
}

#[tokio::test]
async fn maintenance_shutdown_waits_for_active_sweep_without_upload_permits() {
    let (db, admin, name) = fixture().await;
    sqlx::query("INSERT INTO nonces (nonce, expires) VALUES ('expired', 0)")
        .execute(&db.pool)
        .await
        .unwrap();
    let state = crate::AppState::new(db.clone(), "http://i2nclip.test".into());
    let mut permits = Vec::new();
    for key in 0..4 {
        permits.push(state.permits.upload([key; 32]).await.unwrap());
    }
    let mut blocked = db.pool.begin().await.unwrap();
    sqlx::query("LOCK TABLE nonces IN ACCESS EXCLUSIVE MODE")
        .execute(&mut *blocked)
        .await
        .unwrap();
    let (stop, receiver) = tokio::sync::watch::channel(false);
    let task = tokio::spawn(crate::maintenance::run(db.clone(), receiver));
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let waiting: bool = sqlx::query_scalar(
                r#"
                    SELECT EXISTS(
                        SELECT 1 FROM pg_stat_activity
                        WHERE datname = current_database()
                          AND wait_event_type = 'Lock'
                          AND query LIKE '%DELETE FROM nonces%'
                    )
                    "#,
            )
            .fetch_one(&db.pool)
            .await
            .unwrap();
            if waiting {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("startup sweep must reach the database despite busy upload slots");
    stop.send(true).unwrap();
    assert!(!task.is_finished(), "shutdown must await the blocked sweep");
    blocked.commit().await.unwrap();
    tokio::time::timeout(Duration::from_secs(5), task)
        .await
        .unwrap()
        .unwrap();
    let remaining: i64 = sqlx::query_scalar("SELECT count(*) FROM nonces")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(remaining, 0, "the active sweep finishes before shutdown");
    drop(permits);
    drop(state);
    dispose(db, admin, name).await;
}

#[tokio::test]
async fn concurrent_registration_retries_preserve_unused_invitations() {
    let (db, admin, guard) = fixture().await;
    let key = crate::reference_crypto::from_seed([7; 32]);
    let first = db.issue_code(3600, StorageLimits::default()).await.unwrap();
    let second = db.issue_code(3600, StorageLimits::default()).await.unwrap();
    let (a, b) = tokio::join!(register(&db, &key, &first), register(&db, &key, &second));
    a.unwrap();
    b.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM registration_codes")
            .fetch_one(&db.pool)
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM libraries")
            .fetch_one(&db.pool)
            .await
            .unwrap(),
        1
    );
    dispose(db, admin, guard).await;
}
