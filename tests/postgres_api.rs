//! In-process API tests; no listening port is needed.

use std::sync::atomic::{AtomicU64, Ordering};

use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use http_body_util::BodyExt;
use i2nclip::{codec, crypto};
use reference_crypto::{self as client_crypto, Identity};
use tower::ServiceExt;

#[path = "../src/reference_crypto.rs"]
pub mod reference_crypto;

static N: AtomicU64 = AtomicU64::new(0);

fn sign_public_record(identity: &Identity, body: &i2nclip::chain::Body) -> Vec<u8> {
    use ed25519_dalek::{Signer, SigningKey};
    use i2nclip::chain::SIGN_DOMAIN;
    use serde_bytes::ByteBuf;
    let signed = body.encode().unwrap();
    let signature =
        SigningKey::from_bytes(&identity.seed).sign(&[SIGN_DOMAIN, signed.as_slice()].concat());
    rmp_serde::to_vec(&(
        ByteBuf::from(signed),
        ByteBuf::from(signature.to_bytes().to_vec()),
    ))
    .unwrap()
}

#[tokio::test]
async fn chain_http_registration_paging_and_fixed_authority() {
    use i2nclip::chain::Body as BlockBody;
    use serde_bytes::ByteBuf;
    let key = new_identity();
    let outsider = new_identity();
    let (db, app) = app(&[]).await;
    let code = i2nclip::issue_registration_otc(&db.0, 3600, i2nclip::StorageLimits::default())
        .await
        .unwrap();
    let registration = registration_body(&code, &key);
    assert_eq!(
        call(
            &app,
            &key,
            "POST",
            "/api/register-key",
            registration.clone()
        )
        .await
        .0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        call(&app, &key, "POST", "/api/register-key", registration)
            .await
            .0,
        StatusCode::NO_CONTENT
    );
    let library = i2nclip::chain::genesis(&key.public).unwrap();
    let hex = library
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    let path = format!("/api/blocks?after={hex}");
    let (status, bytes) = call(&app, &key, "GET", &path, vec![]).await;
    assert_eq!(status, StatusCode::OK);
    let (head, sequence, records, next): (ByteBuf, u64, Vec<ByteBuf>, Option<ByteBuf>) =
        codec::decode(&bytes).unwrap();
    assert_eq!(head.as_ref(), library);
    assert_eq!(sequence, 0);
    assert!(records.is_empty() && next.is_none());
    let body = BlockBody {
        version: 1,
        library,
        sequence: 1,
        previous: library,
        effects: vec![],
        salt: ByteBuf::from(vec![1; 32]),
        nonce: ByteBuf::from(vec![2; 12]),
        encrypted: ByteBuf::from(vec![3; 16]),
    };
    let record = sign_public_record(&key, &body);
    for _ in 0..2 {
        assert_eq!(
            call(&app, &key, "POST", "/api/blocks", record.clone())
                .await
                .0,
            StatusCode::OK
        );
    }
    assert_eq!(
        call(&app, &outsider, "GET", &path, vec![]).await.0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        call(&app, &outsider, "POST", "/api/blocks", record).await.0,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn chain_http_blob_staging_publication_and_live_quota_frames() {
    use i2nclip::chain::{Body as BlockBody, StorageEffect};
    use serde_bytes::ByteBuf;
    let initial = new_identity();
    let (db, app) = app(&[]).await;
    let code = i2nclip::issue_registration_otc(&db.0, 3600, i2nclip::StorageLimits::default())
        .await
        .unwrap();
    assert_eq!(
        call(
            &app,
            &initial,
            "POST",
            "/api/register-key",
            registration_body(&code, &initial)
        )
        .await
        .0,
        StatusCode::NO_CONTENT
    );
    let library = i2nclip::chain::genesis(&initial.public).unwrap();
    let file = [7u8; 32];
    let ciphertext = vec![9u8; 16];
    let request = codec::encode(&(
        ByteBuf::from(file.to_vec()),
        ByteBuf::from(ciphertext.clone()),
    ))
    .unwrap();
    let (status, bytes) = call(&app, &initial, "POST", "/api/blobs", request.clone()).await;
    assert_eq!(status, StatusCode::OK);
    let (hash,): (ByteBuf,) = codec::decode(&bytes).unwrap();
    assert_eq!(hash.as_ref(), i2nclip::chain::digest(&ciphertext));
    assert_eq!(
        call(&app, &initial, "POST", "/api/blobs", request).await.0,
        StatusCode::OK
    );
    let hex = |value: &[u8]| value.iter().map(|b| format!("{b:02x}")).collect::<String>();
    let path = format!("/api/blobs/{}/{}", hex(&file), hex(&hash));
    assert_eq!(
        call(&app, &initial, "GET", &path, vec![]).await.0,
        StatusCode::NOT_FOUND
    );
    let body = BlockBody {
        version: 1,
        library,
        sequence: 1,
        previous: library,
        effects: vec![StorageEffect::Publish {
            file,
            inventory: i2nclip::chain::inventory_digest(
                &library,
                &file,
                &[(i2nclip::chain::digest(&ciphertext), 16)],
            )
            .unwrap(),
        }],
        salt: ByteBuf::from(vec![1; 32]),
        nonce: ByteBuf::from(vec![2; 12]),
        encrypted: ByteBuf::from(vec![3; 16]),
    };
    assert_eq!(
        call(
            &app,
            &initial,
            "POST",
            "/api/blocks",
            sign_public_record(&initial, &body)
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        call(&app, &initial, "GET", &path, vec![]).await,
        (StatusCode::OK, ciphertext)
    );
    let (status, bytes) = call(&app, &initial, "GET", "/api/quota", vec![]).await;
    assert_eq!(status, StatusCode::OK);
    let (limit, files, used, count, log): (i64, i64, i64, i64, i64) =
        codec::decode(&bytes).unwrap();
    assert_eq!((limit, files, used, count), (536870912, 10000, 16, 1));
    assert!(log > 0);
}

#[tokio::test]
async fn authenticated_ping_checks_registered_signatures_empty_bodies_and_replay() {
    let owner = new_identity();
    let stranger = new_identity();
    let (_db, app) = app(&[&owner]).await;
    assert_eq!(
        call(&app, &owner, "GET", "/api/ping", vec![]).await,
        (StatusCode::NO_CONTENT, vec![])
    );
    assert_eq!(
        call(&app, &stranger, "GET", "/api/ping", vec![]).await.0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        call(&app, &owner, "GET", "/api/ping", vec![1]).await.0,
        StatusCode::PAYLOAD_TOO_LARGE
    );
    let header = client_crypto::authorization(
        &owner,
        "http://i2nclip.test",
        crypto::now_secs(),
        &client_crypto::fresh_nonce(),
        "GET",
        "/api/ping",
        b"",
    );
    for expected in [StatusCode::NO_CONTENT, StatusCode::UNAUTHORIZED] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/ping")
                    .header("authorization", &header)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), expected);
        assert_eq!(response.headers()["cache-control"], "no-store");
    }
    for (origin, path, body) in [
        ("http://wrong.test", "/api/ping", b"".as_slice()),
        ("http://i2nclip.test", "/api/blocks", b"".as_slice()),
        ("http://i2nclip.test", "/api/ping", b"different".as_slice()),
    ] {
        let header = client_crypto::authorization(
            &owner,
            origin,
            crypto::now_secs(),
            &client_crypto::fresh_nonce(),
            "GET",
            path,
            body,
        );
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/ping")
                    .header("authorization", header)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }
}

struct ManualClock(tokio::task::JoinHandle<()>);
impl Drop for ManualClock {
    fn drop(&mut self) {
        self.0.abort();
    }
}
fn manual_clock() -> ManualClock {
    ManualClock(tokio::spawn(async {
        loop {
            tokio::task::yield_now().await;
        }
    }))
}

struct TestDatabase(String, sqlx::PgPool);
impl TestDatabase {
    async fn new() -> Self {
        let base = std::env::var("I2N_TEST_DATABASE_URL").expect(
            "set I2N_TEST_DATABASE_URL; PostgreSQL integration tests require a real database",
        );
        let admin = sqlx::postgres::PgPoolOptions::new()
            .max_connections(1)
            .connect(&base)
            .await
            .expect("test PostgreSQL unavailable");
        let name = format!(
            "i2nclip_test_{}_{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        );
        sqlx::query(&format!("CREATE DATABASE {name}"))
            .execute(&admin)
            .await
            .unwrap();
        admin.close().await;
        let mut url = url::Url::parse(&base).unwrap();
        url.set_path(&name);
        let pool = sqlx::postgres::PgPoolOptions::new()
            .max_connections(1)
            .connect(url.as_str())
            .await
            .unwrap();
        Self(url.to_string(), pool)
    }
}
impl Drop for TestDatabase {
    fn drop(&mut self) {
        let target = self.0.clone();
        std::thread::spawn(move || {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap()
                .block_on(async move {
                    let base = std::env::var("I2N_TEST_DATABASE_URL").unwrap();
                    let pool = sqlx::postgres::PgPoolOptions::new()
                        .max_connections(1)
                        .connect(&base)
                        .await
                        .unwrap();
                    let url = url::Url::parse(&target).unwrap();
                    let name = url.path().trim_start_matches('/');
                    sqlx::query(&format!("DROP DATABASE {name} WITH (FORCE)"))
                        .execute(&pool)
                        .await
                        .unwrap();
                    pool.close().await;
                });
        })
        .join()
        .unwrap();
    }
}

fn new_identity() -> Identity {
    let mut seed = [0u8; 32];
    getrandom::getrandom(&mut seed).unwrap();
    client_crypto::from_seed(seed)
}

async fn app(keys: &[&Identity]) -> (TestDatabase, axum::Router) {
    let dir = TestDatabase::new().await;
    let router = i2nclip::router(&dir.0, "http://i2nclip.test")
        .await
        .unwrap();
    for key in keys {
        let code = i2nclip::issue_registration_otc(&dir.0, 3600, i2nclip::StorageLimits::default())
            .await
            .unwrap();
        let body = registration_body(&code, key);
        assert_eq!(
            call(&router, key, "POST", "/api/register-key", body)
                .await
                .0,
            StatusCode::NO_CONTENT
        );
    }
    (dir, router)
}

async fn enroll_key(app: &axum::Router, key: &Identity, otc: &str) {
    let (status, body) = register(app, key, otc).await;
    assert_eq!(
        status,
        StatusCode::NO_CONTENT,
        "{}",
        String::from_utf8_lossy(&body)
    );
}

fn registration_body(otc: &str, identity: &Identity) -> Vec<u8> {
    use serde_bytes::ByteBuf;
    codec::encode(&(
        otc,
        ByteBuf::from(i2nclip::chain::genesis_bytes(&identity.public).unwrap()),
    ))
    .unwrap()
}

async fn register(app: &axum::Router, key: &Identity, otc: &str) -> (StatusCode, Vec<u8>) {
    call(
        app,
        key,
        "POST",
        "/api/register-key",
        registration_body(otc, key),
    )
    .await
}

async fn call(
    app: &axum::Router,
    key: &Identity,
    method: &str,
    path: &str,
    body: Vec<u8>,
) -> (StatusCode, Vec<u8>) {
    let response = request(app, key, method, path, body).await;
    let status = response.status();
    let bytes = response
        .into_body()
        .collect()
        .await
        .unwrap()
        .to_bytes()
        .to_vec();
    (status, bytes)
}

async fn request(
    app: &axum::Router,
    key: &Identity,
    method: &str,
    path: &str,
    body: Vec<u8>,
) -> axum::response::Response {
    let header = client_crypto::authorization(
        key,
        "http://i2nclip.test",
        crypto::now_secs(),
        &client_crypto::fresh_nonce(),
        method,
        path,
        &body,
    );
    app.clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("authorization", header)
                .body(Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap()
}

#[tokio::test]
async fn configured_origins_authenticate_browser_canonical_signatures() {
    let key = new_identity();
    let (dir, initial) = app(&[&key]).await;
    drop(initial);
    let vectors: serde_json::Value =
        serde_json::from_str(include_str!("../client/tests/origin-vectors.json")).unwrap();
    for case in vectors["accepted"].as_array().unwrap() {
        let input = case["input"].as_str().unwrap();
        let origin = case["origin"].as_str().unwrap();
        let app = i2nclip::router(&dir.0, input).await.unwrap();
        let authorization = client_crypto::authorization(
            &key,
            origin,
            crypto::now_secs(),
            &client_crypto::fresh_nonce(),
            "GET",
            "/api/quota",
            b"",
        );
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/api/quota")
                    .header("authorization", authorization)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK, "{input}");
    }
}

#[tokio::test(start_paused = true)]
async fn stalled_requests_use_endpoint_deadlines_and_preserve_auth_semantics() {
    let _clock = manual_clock();
    use std::{sync::Arc, time::Duration};

    use axum::body::Bytes;
    use http_body_util::Channel;

    let owner = new_identity();
    let (dir, app) = app(&[&owner]).await;
    let new_key = new_identity();
    let otc = i2nclip::issue_registration_otc(&dir.0, 3600, i2nclip::StorageLimits::default())
        .await
        .unwrap();
    for (method, path, seconds) in [
        ("POST", "/api/blobs".to_string(), 120),
        ("POST", "/api/blocks".to_string(), 10),
        ("GET", "/api/quota".to_string(), 10),
        ("POST", "/api/register-key".to_string(), 10),
    ] {
        let registration = path == "/api/register-key";
        let payload = if registration {
            registration_body(&otc, &new_key)
        } else if method == "GET" || method == "DELETE" {
            vec![]
        } else {
            b"partial".to_vec()
        };
        let mut request = Request::builder().method(method).uri(&path);
        let authorization = client_crypto::authorization(
            &owner,
            "http://i2nclip.test",
            crypto::now_secs(),
            &client_crypto::fresh_nonce(),
            method,
            &path,
            &payload,
        );
        request = request.header("authorization", &authorization);
        let (mut sender, body) = Channel::<Bytes>::new(1);
        sender.send_data(Bytes::from(payload)).await.unwrap();
        // Wait for the first body poll so authentication has completed and
        // the read deadline has started before advancing the paused clock.
        let polled = Arc::new(tokio::sync::Notify::new());
        let observed = polled.clone();
        let body = Body::new(body.map_frame(move |frame| {
            observed.notify_one();
            frame
        }));
        let response = tokio::spawn(app.clone().oneshot(request.body(body).unwrap()));
        polled.notified().await;
        tokio::time::advance(Duration::from_secs(seconds - 1)).await;
        assert!(!response.is_finished(), "{method} {path} timed out early");
        tokio::time::advance(Duration::from_secs(1)).await;
        let response = response.await.unwrap().unwrap();
        assert_eq!(
            response.status(),
            StatusCode::REQUEST_TIMEOUT,
            "{method} {path}"
        );
        assert_eq!(response.headers()["cache-control"], "no-store");
        assert!(sender.send_data(Bytes::from_static(b"late")).await.is_err());
        {
            let replay = Request::builder()
                .method(method)
                .uri(&path)
                .header("authorization", authorization)
                .body(Body::empty())
                .unwrap();
            assert_eq!(
                app.clone().oneshot(replay).await.unwrap().status(),
                StatusCode::UNAUTHORIZED
            );
        }
    }
    // Even a complete registration JSON cannot consume an invitation until
    // the body stream ends; timing out leaves it available for a fresh request.
    enroll_key(&app, &new_key, &otc).await;
    let conn = &dir.1;
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM files")
            .fetch_one(conn)
            .await
            .unwrap(),
        0
    );
}

#[tokio::test]
async fn rejects_replayed_request_signatures() {
    let key = new_identity();
    let (_dir, app) = app(&[&key]).await;
    let (status, _) = call(&app, &key, "GET", "/api/quota", Vec::new()).await;
    assert_eq!(status, StatusCode::OK);
    // The first call already stored its nonce. Sign a fresh one and send it twice.
    let ts = crypto::now_secs();
    let nonce = client_crypto::fresh_nonce();
    let header = client_crypto::authorization(
        &key,
        "http://i2nclip.test",
        ts,
        &nonce,
        "GET",
        "/api/quota",
        b"",
    );
    let request = Request::builder()
        .method("GET")
        .uri("/api/quota")
        .header("authorization", header.clone())
        .body(Body::empty())
        .unwrap();
    let again = Request::builder()
        .method("GET")
        .uri("/api/quota")
        .header("authorization", header)
        .body(Body::empty())
        .unwrap();
    assert_eq!(
        app.clone().oneshot(request).await.unwrap().status(),
        StatusCode::OK
    );
    assert_eq!(
        app.clone().oneshot(again).await.unwrap().status(),
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn rejects_wrong_origin_and_a_body_other_than_the_signed_one() {
    let key = new_identity();
    let (_dir, app) = app(&[&key]).await;
    let ts = crypto::now_secs();
    let body = b"signed-body".to_vec();

    let other_origin = client_crypto::authorization(
        &key,
        "https://other.example",
        ts,
        &client_crypto::fresh_nonce(),
        "POST",
        "/api/blobs",
        &body,
    );
    let origin_request = Request::builder()
        .method("POST")
        .uri("/api/blobs")
        .header("authorization", other_origin)
        .body(Body::from(body.clone()))
        .unwrap();
    assert_eq!(
        app.clone().oneshot(origin_request).await.unwrap().status(),
        StatusCode::UNAUTHORIZED
    );

    let swapped = client_crypto::authorization(
        &key,
        "http://i2nclip.test",
        ts,
        &client_crypto::fresh_nonce(),
        "POST",
        "/api/blobs",
        &body,
    );
    let swapped_request = Request::builder()
        .method("POST")
        .uri("/api/blobs")
        .header("authorization", swapped)
        .body(Body::from(b"different-body".to_vec()))
        .unwrap();
    assert_eq!(
        app.clone().oneshot(swapped_request).await.unwrap().status(),
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn register_rejects_bad_and_expired_otc() {
    let key = new_identity();
    let dir = TestDatabase::new().await;
    let app = i2nclip::router(&dir.0, "http://i2nclip.test")
        .await
        .unwrap();
    let (status, _) = register(&app, &key, "not-a-real-code").await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    let otc = i2nclip::issue_registration_otc(&dir.0, 3600, i2nclip::StorageLimits::default())
        .await
        .unwrap();
    let conn = &dir.1;
    sqlx::query("UPDATE registration_codes SET expires_at = 0")
        .execute(conn)
        .await
        .unwrap();
    let (status, _) = register(&app, &key, &otc).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn register_otc_is_single_use_and_idempotent_for_key() {
    let key = new_identity();
    let dir = TestDatabase::new().await;
    let app = i2nclip::router(&dir.0, "http://i2nclip.test")
        .await
        .unwrap();
    let otc = i2nclip::issue_registration_otc(&dir.0, 3600, i2nclip::StorageLimits::default())
        .await
        .unwrap();
    enroll_key(&app, &key, &otc).await;
    let (status, _) = register(&app, &key, &otc).await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    let otc2 = i2nclip::issue_registration_otc(&dir.0, 3600, i2nclip::StorageLimits::default())
        .await
        .unwrap();
    let (status, _) = register(&app, &key, &otc2).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
}

#[tokio::test]
async fn weak_key_forgery_is_rejected_before_body_and_nonce() {
    let mut public = [0u8; 32];
    public[0] = 1;
    let (dir, app) = app(&[]).await;
    let mut signature = [0u8; 64];
    signature[0] = 1;
    let nonce = client_crypto::fresh_nonce();
    let ts = crypto::now_secs();
    let body = b"this payload must not be read";
    let hash = crypto::body_hash(body);
    let header = format!(
        "Bearer {}.{ts}.{nonce}.{hash}.{}",
        URL_SAFE_NO_PAD.encode(public),
        URL_SAFE_NO_PAD.encode(signature)
    );
    let unreadable = Body::new(Body::from(body.as_slice()).map_frame(|frame| {
        assert!(frame.data_ref().is_none(), "unauthenticated body was read");
        frame
    }));
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/blobs")
                .header("authorization", header)
                .body(unreadable)
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    let conn = &dir.1;
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM nonces WHERE nonce=$1")
            .bind(&nonce)
            .fetch_one(conn)
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM libraries WHERE signing_public_key=$1")
            .bind(public.as_slice())
            .fetch_one(conn)
            .await
            .unwrap(),
        0
    );
}

#[tokio::test]
async fn invitation_race_has_one_winner() {
    let (dir, first) = app(&[]).await;
    let second = i2nclip::router(&dir.0, "http://i2nclip.test")
        .await
        .unwrap();
    let code = i2nclip::issue_registration_otc(&dir.0, 3600, i2nclip::StorageLimits::default())
        .await
        .unwrap();
    let one = new_identity();
    let two = new_identity();
    let (a, b) = tokio::join!(
        register(&first, &one, &code),
        register(&second, &two, &code)
    );
    let mut statuses = [a.0.as_u16(), b.0.as_u16()];
    statuses.sort();
    assert_eq!(statuses, [204, 403]);
}

#[tokio::test]
async fn authentication_rechecks_timestamp_after_nonce_insert_wait() {
    let key = new_identity();
    let (dir, app) = app(&[&key]).await;
    sqlx::raw_sql(
        r#"
        CREATE FUNCTION delay_nonce() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
            PERFORM pg_sleep(2);
            RETURN NEW;
        END;
        $$;

        CREATE TRIGGER delay_nonce
            BEFORE INSERT ON nonces
            FOR EACH ROW EXECUTE FUNCTION delay_nonce();
        "#,
    )
    .execute(&dir.1)
    .await
    .unwrap();
    let nonce = client_crypto::fresh_nonce();
    let header = client_crypto::authorization(
        &key,
        "http://i2nclip.test",
        crypto::now_secs() - 300,
        &nonce,
        "POST",
        "/api/blobs",
        b"",
    );
    let (sender, body) = http_body_util::Channel::<axum::body::Bytes>::new(1);
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/blobs")
                .header("authorization", header)
                .body(Body::new(body))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    drop(sender);
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM nonces WHERE nonce=$1")
            .bind(nonce)
            .fetch_one(&dir.1)
            .await
            .unwrap(),
        1
    );
}

#[tokio::test]
async fn registration_requires_possession_and_preserves_invitations_on_verification_failure() {
    let key = new_identity();
    let other = new_identity();
    let (dir, app) = app(&[]).await;
    let otc = i2nclip::issue_registration_otc(&dir.0, 3600, i2nclip::StorageLimits::default())
        .await
        .unwrap();
    let body = registration_body(&otc, &key);
    for case in [
        "missing",
        "forged",
        "weak",
        "origin",
        "path",
        "stale",
        "early",
        "tampered",
        "malformed",
    ] {
        let sent = match case {
            "tampered" => registration_body("changed invitation", &key),
            "malformed" => b"not MessagePack".to_vec(),
            _ => body.clone(),
        };
        let forged = Identity {
            seed: other.seed,
            public: key.public,
        };
        let weak = Identity {
            seed: key.seed,
            public: [0; 32],
        };
        let signature = client_crypto::authorization(
            match case {
                "forged" => &forged,
                "weak" => &weak,
                _ => &key,
            },
            if case == "origin" {
                "https://wrong.example"
            } else {
                "http://i2nclip.test"
            },
            crypto::now_secs() - if case == "stale" { 301 } else { 0 },
            &client_crypto::fresh_nonce(),
            "POST",
            if case == "path" {
                "/api/blobs"
            } else {
                "/api/register-key"
            },
            if case == "tampered" { &body } else { &sent },
        );
        let mut request = Request::builder().method("POST").uri("/api/register-key");
        if case != "missing" {
            request = request.header("authorization", signature);
        }
        if case == "early" {
            request = request.header("early-data", "1");
        }
        let unread = matches!(
            case,
            "missing" | "forged" | "weak" | "origin" | "path" | "stale" | "early"
        );
        let request_body = if unread {
            Body::new(Body::from(sent).map_frame(|_| panic!("invalid proof must not read a body")))
        } else {
            Body::from(sent)
        };
        let response = app
            .clone()
            .oneshot(request.body(request_body).unwrap())
            .await
            .unwrap();
        let expected = match case {
            "early" => StatusCode::TOO_EARLY,
            "malformed" => StatusCode::BAD_REQUEST,
            _ => StatusCode::UNAUTHORIZED,
        };
        assert_eq!(response.status(), expected, "{case}");
        let counts: (i64,i64,i64) = sqlx::query_as("SELECT (SELECT count(*) FROM registration_codes), (SELECT count(*) FROM nonces), (SELECT count(*) FROM libraries)")
            .fetch_one(&dir.1).await.unwrap();
        assert_eq!(counts, (1, 0, 0), "{case}");
    }
    let signature = client_crypto::authorization(
        &key,
        "http://i2nclip.test",
        crypto::now_secs(),
        &client_crypto::fresh_nonce(),
        "POST",
        "/api/register-key",
        &body,
    );
    for replay in [false, true] {
        // Registration reserves nonces transactionally after verifying its body.
        let request_body = Body::from(body.clone());
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/register-key")
                    .header("authorization", &signature)
                    .body(request_body)
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            if replay {
                StatusCode::UNAUTHORIZED
            } else {
                StatusCode::NO_CONTENT
            }
        );
    }
    assert_eq!(
        call(&app, &key, "GET", "/api/ping", vec![]).await.0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        call(&app, &other, "GET", "/api/ping", vec![]).await.0,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn unknown_chain_keys_never_poll_bodies_or_spend_nonces() {
    let owner = new_identity();
    let (db, app) = app(&[&owner]).await;
    let before: i64 = sqlx::query_scalar("SELECT count(*) FROM nonces")
        .fetch_one(&db.1)
        .await
        .unwrap();
    for _ in 0..5 {
        let outsider = new_identity();
        let payload = b"unread";
        let authorization = client_crypto::authorization(
            &outsider,
            "http://i2nclip.test",
            crypto::now_secs(),
            &client_crypto::fresh_nonce(),
            "POST",
            "/api/blocks",
            payload,
        );
        let body = Body::new(
            Body::from(payload.as_slice()).map_frame(|_| panic!("unknown key body was polled")),
        );
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/blocks")
                    .header("authorization", authorization)
                    .body(body)
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM nonces")
            .fetch_one(&db.1)
            .await
            .unwrap(),
        before
    );
    assert_eq!(
        call(&app, &owner, "GET", "/api/quota", vec![]).await.0,
        StatusCode::OK
    );
}

#[tokio::test]
async fn stalled_registration_has_separate_bounded_admission_and_no_nonce_writes() {
    use std::sync::Arc;

    use axum::body::Bytes;
    use http_body_util::Channel;
    let owner = new_identity();
    let (db, app) = app(&[&owner]).await;
    let before: i64 = sqlx::query_scalar("SELECT count(*) FROM nonces")
        .fetch_one(&db.1)
        .await
        .unwrap();
    let mut jobs = tokio::task::JoinSet::new();
    let mut senders = Vec::new();
    for _ in 0..4 {
        let key = new_identity();
        let payload = registration_body("invalid", &key);
        let auth = client_crypto::authorization(
            &key,
            "http://i2nclip.test",
            crypto::now_secs(),
            &client_crypto::fresh_nonce(),
            "POST",
            "/api/register-key",
            &payload,
        );
        let (mut sender, channel) = Channel::<Bytes>::new(1);
        sender.send_data(Bytes::from(payload)).await.unwrap();
        let polled = Arc::new(tokio::sync::Notify::new());
        let observed = polled.clone();
        let body = Body::new(channel.map_frame(move |frame| {
            observed.notify_one();
            frame
        }));
        jobs.spawn(
            app.clone().oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/register-key")
                    .header("authorization", auth)
                    .body(body)
                    .unwrap(),
            ),
        );
        tokio::time::timeout(std::time::Duration::from_secs(5), polled.notified())
            .await
            .unwrap();
        senders.push(sender);
    }
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM nonces")
            .fetch_one(&db.1)
            .await
            .unwrap(),
        before
    );
    let fifth = new_identity();
    assert_eq!(
        call(
            &app,
            &fifth,
            "POST",
            "/api/register-key",
            registration_body("invalid", &fifth)
        )
        .await
        .0,
        StatusCode::SERVICE_UNAVAILABLE
    );
    assert_eq!(
        call(&app, &owner, "GET", "/api/quota", vec![]).await.0,
        StatusCode::OK
    );
    jobs.abort_all();
    while jobs.join_next().await.is_some() {}
    drop(senders);
    assert_eq!(
        call(
            &app,
            &fifth,
            "POST",
            "/api/register-key",
            registration_body("invalid", &fifth)
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
}
