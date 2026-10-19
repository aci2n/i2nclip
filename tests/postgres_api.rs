//! In-process API tests; no listening port is needed.

use std::sync::atomic::{AtomicU64, Ordering};

use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use http_body_util::BodyExt;
use i2nclip::{codec, crypto, Error};
use reference_crypto::{self as client_crypto, fixture_tag_labels, Identity};
use tower::ServiceExt;

#[path = "../src/reference_crypto.rs"]
pub mod reference_crypto;

static N: AtomicU64 = AtomicU64::new(0);

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
        ("http://i2nclip.test", "/api/media", b"".as_slice()),
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

fn raw_hash(bytes: &[u8]) -> [u8; 32] {
    let encoded = crypto::body_hash(bytes);
    std::array::from_fn(|index| u8::from_str_radix(&encoded[index * 2..index * 2 + 2], 16).unwrap())
}

// Keep paused time from auto-advancing while real PostgreSQL I/O is pending.
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
        sqlx::query("INSERT INTO registered_keys (public_key) VALUES ($1) ON CONFLICT DO NOTHING")
            .bind(key.public.as_slice())
            .execute(&dir.1)
            .await
            .unwrap();
        sqlx::query("INSERT INTO key_quotas (public_key) VALUES ($1) ON CONFLICT DO NOTHING")
            .bind(key.public.as_slice())
            .execute(&dir.1)
            .await
            .unwrap();
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

async fn register(app: &axum::Router, key: &Identity, otc: &str) -> (StatusCode, Vec<u8>) {
    call(
        app,
        key,
        "POST",
        "/api/register-key",
        client_crypto::registration_body(otc),
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
            "/api/media",
            b"",
        );
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/api/media")
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
    let id = "6666666666666666666666666666666666666666666666666666666666666666";
    for (method, path, seconds) in [
        ("POST", "/api/media".to_string(), 30),
        ("PUT", format!("/api/media/{id}/chunks/0"), 120),
        ("PUT", format!("/api/media/{id}/meta"), 30),
        ("GET", "/api/media".to_string(), 10),
        ("DELETE", format!("/api/media/{id}"), 10),
        ("POST", "/api/register-key".to_string(), 10),
    ] {
        let registration = path == "/api/register-key";
        let payload = if registration {
            client_crypto::registration_body(&otc)
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
async fn rejects_bad_signature_replay_and_raw_jpeg() {
    let key = new_identity();
    let (_dir, app) = app(&[&key]).await;
    let (status, _) = call(&app, &key, "GET", "/api/media", Vec::new()).await;
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
        "/api/media",
        b"",
    );
    let request = Request::builder()
        .method("GET")
        .uri("/api/media")
        .header("authorization", header.clone())
        .body(Body::empty())
        .unwrap();
    let again = Request::builder()
        .method("GET")
        .uri("/api/media")
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

    let id = "3333333333333333333333333333333333333333333333333333333333333333";
    let meta = client_crypto::seal_metadata(&key.seed, id, b"{}").unwrap();
    let body = client_crypto::encode_create(
        id,
        0,
        b"\xff\xd8\xff\xd8not-encrypted",
        &meta,
        &fixture_tag_labels("not-a-token"),
    );
    let (status, _) = call(&app, &key, "POST", "/api/media", body).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
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
        "/api/media",
        &body,
    );
    let origin_request = Request::builder()
        .method("POST")
        .uri("/api/media")
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
        "/api/media",
        &body,
    );
    let swapped_request = Request::builder()
        .method("POST")
        .uri("/api/media")
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
    assert_eq!(status, StatusCode::FORBIDDEN);

    let otc2 = i2nclip::issue_registration_otc(&dir.0, 3600, i2nclip::StorageLimits::default())
        .await
        .unwrap();
    let (status, _) = register(&app, &key, &otc2).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
}

#[tokio::test]
async fn legacy_weak_key_forgery_is_rejected_before_body_and_nonce() {
    let mut public = [0u8; 32];
    public[0] = 1;
    let weak = Identity {
        seed: [0u8; 32],
        public,
    };
    // Direct insertion simulates a key registered before strict validation.
    let (dir, app) = app(&[&weak]).await;
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
                .uri("/api/media")
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
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM registered_keys WHERE public_key=$1")
            .bind(public.as_slice())
            .fetch_one(conn)
            .await
            .unwrap(),
        1
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
    let header = client_crypto::authorization(
        &key,
        "http://i2nclip.test",
        crypto::now_secs() - 300,
        &client_crypto::fresh_nonce(),
        "POST",
        "/api/media",
        b"",
    );
    let (sender, body) = http_body_util::Channel::<axum::body::Bytes>::new(1);
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/media")
                .header("authorization", header)
                .body(Body::new(body))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    drop(sender);
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM nonces")
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
    let body = client_crypto::registration_body(&otc);
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
            "tampered" => client_crypto::registration_body("changed invitation"),
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
                "/api/media"
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
        let counts: (i64,i64,i64) = sqlx::query_as("SELECT (SELECT count(*) FROM registration_codes), (SELECT count(*) FROM registered_keys), (SELECT count(*) FROM key_quotas)")
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
        let request_body = if replay {
            Body::new(Body::from(body.clone()).map_frame(|_| panic!("replay body was read")))
        } else {
            Body::from(body.clone())
        };
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

struct UploadFixture {
    id: String,
    body: Vec<u8>,
    encrypted: Vec<Vec<u8>>,
    meta: Vec<u8>,
}

fn upload_fixture(owner: &Identity, size: usize, tags: &str) -> UploadFixture {
    let id = crypto::body_hash(client_crypto::fresh_nonce().as_bytes());
    let descriptor =
        client_crypto::content_descriptor(&owner.seed, &id, size as u64, &[0x44; 32], &[0x55; 12]);
    let meta = client_crypto::seal_metadata(&owner.seed, &id, b"encrypted filename").unwrap();
    let encrypted = (0..size.div_ceil(4194304).max(1))
        .map(|index| {
            let length = (size - index * 4194304).min(4194304);
            client_crypto::encrypt_chunk(
                &[0x44; 32],
                &id,
                size as u64,
                index as u64,
                &vec![0x5a; length],
            )
        })
        .collect();
    let body = client_crypto::encode_create(
        &id,
        size as i64,
        &descriptor,
        &meta,
        &fixture_tag_labels(tags),
    );
    UploadFixture {
        id,
        body,
        encrypted,
        meta,
    }
}

async fn publish(app: &axum::Router, owner: &Identity, upload: &UploadFixture) {
    assert_eq!(
        call(app, owner, "POST", "/api/media", upload.body.clone())
            .await
            .0,
        StatusCode::CREATED
    );
    for (index, bytes) in upload.encrypted.iter().enumerate() {
        assert_eq!(
            call(
                app,
                owner,
                "PUT",
                &format!("/api/media/{}/chunks/{index}", upload.id),
                bytes.clone()
            )
            .await
            .0,
            StatusCode::NO_CONTENT
        );
    }
}

#[tokio::test]
async fn pending_chunk_roundtrip_authenticates_metadata_and_publishes_complete_items_only() {
    let owner = new_identity();
    let other = new_identity();
    assert!(!owner.registration_key().is_empty());
    let (_db, app) = app(&[&owner, &other]).await;
    let token = client_crypto::tag_token(&owner.seed, "Holiday").unwrap();
    let upload = upload_fixture(&owner, 4194307, &token);
    let (status, body) = call(&app, &owner, "POST", "/api/media", upload.body.clone()).await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(
        client_crypto::document_json(&body)["expected_chunk_count"],
        2
    );
    assert_eq!(
        client_crypto::document_json(&call(&app, &owner, "GET", "/api/media", vec![]).await.1)
            ["media"],
        serde_json::json!([])
    );
    let meta_path = format!("/api/media/{}/meta", upload.id);
    let chunk_path = format!("/api/media/{}/chunks/0", upload.id);
    assert_eq!(
        call(&app, &owner, "GET", &meta_path, vec![]).await.0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        call(&app, &owner, "GET", &chunk_path, vec![]).await.0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        call(
            &app,
            &other,
            "PUT",
            &chunk_path,
            upload.encrypted[0].clone()
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        call(
            &app,
            &owner,
            "PUT",
            &format!("/api/media/{}/chunks/1", upload.id),
            upload.encrypted[1].clone()
        )
        .await
        .0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        call(
            &app,
            &owner,
            "PUT",
            &chunk_path,
            upload.encrypted[0].clone()
        )
        .await
        .0,
        StatusCode::NO_CONTENT
    );
    let response = request(&app, &owner, "GET", &chunk_path, vec![]).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers()["cache-control"],
        "private, max-age=31536000, immutable"
    );
    assert_eq!(response.headers()["etag"], format!("\"{}.0\"", upload.id));
    assert_eq!(response.headers()["content-length"], "4194320");
    assert_eq!(
        response
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes()
            .as_ref(),
        upload.encrypted[0]
    );
    let (_, summary) = call(&app, &owner, "GET", &meta_path, vec![]).await;
    assert!(!String::from_utf8_lossy(&summary).contains("encrypted filename"));
    let doc = client_crypto::document_json(&summary);
    assert_eq!(doc["bytes"], 4194339);
    assert_eq!(
        client_crypto::open_metadata(&owner.seed, &upload.id, &upload.meta).unwrap(),
        b"encrypted filename"
    );
    let catalog =
        client_crypto::document_json(&call(&app, &owner, "GET", "/api/tags", vec![]).await.1);
    assert_eq!(catalog["tags"].as_array().unwrap().len(), 1);
    assert_eq!(
        call(&app, &other, "GET", &chunk_path, vec![]).await.0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        call(
            &app,
            &owner,
            "DELETE",
            &format!("/api/media/{}", upload.id),
            vec![]
        )
        .await
        .0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        call(&app, &owner, "GET", &chunk_path, vec![]).await.0,
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn concurrent_routers_share_immutable_chunks_and_id_conflicts() {
    let owner = new_identity();
    let (db, first) = app(&[&owner]).await;
    let second = i2nclip::router(&db.0, "http://i2nclip.test").await.unwrap();
    let upload = upload_fixture(&owner, 0, "");
    let (a, b) = tokio::join!(
        call(&first, &owner, "POST", "/api/media", upload.body.clone()),
        call(&second, &owner, "POST", "/api/media", upload.body.clone())
    );
    assert!(matches!(
        (a.0, b.0),
        (StatusCode::CREATED, StatusCode::CONFLICT) | (StatusCode::CONFLICT, StatusCode::CREATED)
    ));
    let path = format!("/api/media/{}/chunks/0", upload.id);
    let (a, b) = tokio::join!(
        call(&first, &owner, "PUT", &path, upload.encrypted[0].clone()),
        call(&second, &owner, "PUT", &path, upload.encrypted[0].clone())
    );
    assert_eq!((a.0, b.0), (StatusCode::NO_CONTENT, StatusCode::NO_CONTENT));
    assert_eq!(
        call(&first, &owner, "PUT", &path, vec![0; 16]).await.0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        call(&first, &owner, "PUT", &path, vec![0; 17]).await.0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        call(
            &first,
            &owner,
            "PUT",
            &format!("/api/media/{}/chunks/1", upload.id),
            vec![0; 16]
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    let quota =
        client_crypto::document_json(&call(&first, &owner, "GET", "/api/quota", vec![]).await.1);
    assert_eq!(quota["used_content_bytes"], 16);
    assert_eq!(quota["file_count"], 1);
    assert!(quota.get("max_file_plaintext_bytes").is_none());
}

#[tokio::test]
async fn metadata_conflict_returns_current_descriptor_without_mutating_chunks() {
    let owner = new_identity();
    let (_db, app) = app(&[&owner]).await;
    let upload = upload_fixture(&owner, 1, "");
    publish(&app, &owner, &upload).await;
    let path = format!("/api/media/{}/meta", upload.id);
    let changed = client_crypto::sealed_fixture(2, 43);
    let update = client_crypto::encode_meta(
        &raw_hash(&upload.meta),
        &changed,
        &fixture_tag_labels(&client_crypto::tag_token(&owner.seed, "updated").unwrap()),
    );
    assert_eq!(
        call(&app, &owner, "PUT", &path, update.clone()).await.0,
        StatusCode::OK
    );
    let (status, body) = call(&app, &owner, "PUT", &path, update).await;
    assert_eq!(status, StatusCode::CONFLICT);
    let value = client_crypto::document_json(&body);
    assert_eq!(value["code"], "metadata_conflict");
    assert_eq!(value["media"]["meta"], serde_json::json!(changed));
    assert_eq!(
        call(
            &app,
            &owner,
            "GET",
            &format!("/api/media/{}/chunks/0", upload.id),
            vec![]
        )
        .await
        .1,
        upload.encrypted[0]
    );
}

#[tokio::test]
async fn chunk_caps_check_declared_and_actual_lengths_after_authentication() {
    use std::{
        sync::{atomic::AtomicBool, Arc},
        task::Poll,
    };
    let owner = new_identity();
    let (_db, app) = app(&[&owner]).await;
    for (method, path, cap) in [
        ("POST", "/api/media".to_string(), 192 * 1024),
        (
            "PUT",
            format!("/api/media/{}/chunks/0", "00".repeat(32)),
            4194320,
        ),
    ] {
        let polled = Arc::new(AtomicBool::new(false));
        let observed = polled.clone();
        let stream = futures_util::stream::poll_fn(move |_| {
            observed.store(true, Ordering::Relaxed);
            Poll::<Option<Result<Vec<u8>, std::io::Error>>>::Pending
        });
        let header = client_crypto::authorization(
            &owner,
            "http://i2nclip.test",
            crypto::now_secs(),
            &client_crypto::fresh_nonce(),
            method,
            &path,
            b"",
        );
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(&path)
                    .header("authorization", header)
                    .header("content-length", cap + 1)
                    .body(Body::from_stream(stream))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
        assert!(!polled.load(Ordering::Relaxed));
        for declared in [None, Some("1")] {
            let body = vec![0; cap + 1];
            let header = client_crypto::authorization(
                &owner,
                "http://i2nclip.test",
                crypto::now_secs(),
                &client_crypto::fresh_nonce(),
                method,
                &path,
                &body,
            );
            let mut request = Request::builder()
                .method(method)
                .uri(&path)
                .header("authorization", header);
            if let Some(declared) = declared {
                request = request.header("content-length", declared);
            }
            assert_eq!(
                app.clone()
                    .oneshot(request.body(Body::from(body)).unwrap())
                    .await
                    .unwrap()
                    .status(),
                StatusCode::PAYLOAD_TOO_LARGE
            );
        }
    }
}

#[tokio::test]
async fn pending_reservations_obey_library_quota_and_failed_tag_writes_roll_back() {
    let owner = new_identity();
    let (db, app) = app(&[&owner]).await;
    i2nclip::set_key_limits(
        &db.0,
        &owner.registration_key(),
        i2nclip::StorageLimits {
            max_content_bytes: 17,
            max_files: 1,
        },
    )
    .await
    .unwrap();
    let upload = upload_fixture(&owner, 1, "");
    assert_eq!(
        call(&app, &owner, "POST", "/api/media", upload.body.clone())
            .await
            .0,
        StatusCode::CREATED
    );
    let other = upload_fixture(&owner, 0, "");
    assert_eq!(
        call(&app, &owner, "POST", "/api/media", other.body.clone())
            .await
            .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        call(
            &app,
            &owner,
            "DELETE",
            &format!("/api/media/{}", upload.id),
            vec![]
        )
        .await
        .0,
        StatusCode::NO_CONTENT
    );
    let quota = request(&app, &owner, "GET", "/api/quota", vec![]).await;
    assert_eq!(quota.headers()["cache-control"], "no-store");
    let quota =
        client_crypto::document_json(&quota.into_body().collect().await.unwrap().to_bytes());
    assert_eq!(quota["used_content_bytes"], 0);
    sqlx::raw_sql("CREATE FUNCTION fail_tags() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test'; END; $$; CREATE TRIGGER fail_tags BEFORE INSERT ON tags FOR EACH ROW EXECUTE FUNCTION fail_tags();").execute(&db.1).await.unwrap();
    let tagged = upload_fixture(
        &owner,
        0,
        &client_crypto::tag_token(&owner.seed, "tag").unwrap(),
    );
    assert_eq!(
        call(&app, &owner, "POST", "/api/media", tagged.body)
            .await
            .0,
        StatusCode::INTERNAL_SERVER_ERROR
    );
    assert_eq!(
        client_crypto::document_json(&call(&app, &owner, "GET", "/api/quota", vec![]).await.1)
            ["file_count"],
        0
    );
}

#[tokio::test]
async fn held_chunk_responses_keep_per_key_permits_until_disposal() {
    use std::time::Duration;
    let owner = new_identity();
    let other = new_identity();
    let (_db, app) = app(&[&owner, &other]).await;
    let upload = upload_fixture(&owner, 0, "");
    publish(&app, &owner, &upload).await;
    let path = format!("/api/media/{}/chunks/0", upload.id);
    let first = request(&app, &owner, "GET", &path, vec![]).await;
    let second = request(&app, &owner, "GET", &path, vec![]).await;
    let pending = {
        let app = app.clone();
        let owner = client_crypto::from_seed(owner.seed);
        let path = path.clone();
        tokio::spawn(async move { request(&app, &owner, "GET", &path, vec![]).await })
    };
    tokio::task::yield_now().await;
    assert!(!pending.is_finished());
    assert_eq!(
        request(&app, &other, "GET", &path, vec![]).await.status(),
        StatusCode::NOT_FOUND
    );
    drop(first);
    let resumed = tokio::time::timeout(Duration::from_secs(5), pending)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(resumed.status(), StatusCode::OK);
    drop(second);
    drop(resumed);
}

#[tokio::test(start_paused = true)]
async fn transfer_admission_timeouts_preserve_nonce_and_body_policy() {
    use std::{sync::Arc, time::Duration};

    use axum::body::Bytes;
    use http_body_util::Channel;
    use tokio::sync::Notify;

    let _clock = manual_clock();
    let owner = new_identity();
    let (db, app) = app(&[&owner]).await;
    let upload = upload_fixture(&owner, 0, "");
    publish(&app, &owner, &upload).await;
    let path = format!("/api/media/{}/chunks/0", upload.id);
    let first = request(&app, &owner, "GET", &path, vec![]).await;
    let second = request(&app, &owner, "GET", &path, vec![]).await;

    let (mut sender, body) = Channel::<Bytes>::new(1);
    sender
        .send_data(Bytes::from(upload.encrypted[0].clone()))
        .await
        .unwrap();
    let polled = Arc::new(Notify::new());
    let observed = polled.clone();
    let header = client_crypto::authorization(
        &owner,
        "http://i2nclip.test",
        crypto::now_secs(),
        &client_crypto::fresh_nonce(),
        "PUT",
        &path,
        &upload.encrypted[0],
    );
    let holding = tokio::spawn(
        app.clone().oneshot(
            Request::builder()
                .method("PUT")
                .uri(&path)
                .header("authorization", header)
                .body(Body::new(body.map_frame(move |frame| {
                    observed.notify_one();
                    frame
                })))
                .unwrap(),
        ),
    );
    polled.notified().await;

    for (method, target) in [
        ("POST", "/api/media".to_string()),
        ("GET", format!("/api/media/{}/chunks/0", "f".repeat(64))),
    ] {
        let nonce = client_crypto::fresh_nonce();
        let header = client_crypto::authorization(
            &owner,
            "http://i2nclip.test",
            crypto::now_secs(),
            &nonce,
            method,
            &target,
            b"",
        );
        let unread = if method == "POST" {
            Body::new(
                Body::from("unread").map_frame(|_| panic!("queued upload body must not be read")),
            )
        } else {
            Body::empty()
        };
        let waiting = tokio::spawn(
            app.clone().oneshot(
                Request::builder()
                    .method(method)
                    .uri(&target)
                    .header("authorization", &header)
                    .body(unread)
                    .unwrap(),
            ),
        );
        // Nonce insertion is the last database step before admission.
        while !sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM nonces WHERE nonce=$1)")
            .bind(&nonce)
            .fetch_one(&db.1)
            .await
            .unwrap()
        {
            tokio::task::yield_now().await;
        }
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_secs(29)).await;
        assert!(!waiting.is_finished());
        tokio::time::advance(Duration::from_secs(1)).await;
        let response = waiting.await.unwrap().unwrap();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(response.headers()["retry-after"], "1");
        let replay = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(&target)
                    .header("authorization", header)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(replay.status(), StatusCode::UNAUTHORIZED);
    }
    holding.abort();
    assert!(holding.await.unwrap_err().is_cancelled());
    drop(sender);
    drop((first, second));
}
