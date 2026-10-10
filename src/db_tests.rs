use super::*;

async fn fixture() -> (Database, PgPool, String) {
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
    let db = Database::connect(url.as_str()).await.unwrap();
    db.initialize().await.unwrap();
    (db, admin, name)
}

async fn dispose(db: Database, admin: PgPool, name: String) {
    db.close().await;
    sqlx::query(&format!("DROP DATABASE {name} WITH (FORCE)"))
        .execute(&admin)
        .await
        .unwrap();
    admin.close().await;
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
    assert_eq!(db.maintain(100).await.unwrap(), (1, 2));
    assert_eq!(db.maintain(100).await.unwrap(), (0, 0));
    assert_eq!(db.maintain(101).await.unwrap(), (1, 1));
    dispose(db, admin, name).await;
}

#[tokio::test]
async fn pool_timeout_is_retryable_and_download_does_not_hold_connection() {
    let (db, admin, name) = fixture().await;
    let mut connections = Vec::new();
    for _ in 0..8 {
        connections.push(db.pool.acquire().await.unwrap());
    }
    let error = db.allowed(&[1; 32]).await.unwrap_err();
    assert!(matches!(error, Error::Unavailable));
    let response = crate::routes::fail(error);
    assert_eq!(
        response.status(),
        axum::http::StatusCode::SERVICE_UNAVAILABLE
    );
    assert_eq!(response.headers()[axum::http::header::RETRY_AFTER], "1");
    connections.clear();
    let mut content = vec![1; 100_000];
    content[0] = 1;
    let body = frame::encode_post(&[1; 29], &content, "");
    let item = db.add([1; 32], &body).await.unwrap();
    let downloaded = db.content([1; 32], &item.id).await.unwrap();
    for _ in 0..8 {
        connections.push(db.pool.acquire().await.unwrap());
    }
    assert_eq!(downloaded, content);
    drop(connections);
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
    .bind(&name)
    .execute(&admin)
    .await
    .unwrap();
    let mut recovered = false;
    for _ in 0..3 {
        if db.allowed(&[1; 32]).await.is_ok() {
            recovered = true;
            break;
        }
    }
    assert!(recovered);
    dispose(db, admin, name).await;
}
