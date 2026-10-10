//! In-process API tests; no listening port is needed.

use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;

use axum::body::Body;
use axum::http::Request;
use axum::http::StatusCode;
use base64::engine::general_purpose::STANDARD;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use http_body_util::BodyExt;
use i2nclip::crypto;
use i2nclip::frame;
use i2nclip::Error;
use reference_crypto::{self as client_crypto, Identity};
use tower::ServiceExt;

#[path = "../src/reference_crypto.rs"]
mod reference_crypto;

static N: AtomicU64 = AtomicU64::new(0);

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
        let admin = sqlx::PgPool::connect(&base)
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
        let pool = sqlx::PgPool::connect(url.as_str()).await.unwrap();
        Self(url.to_string(), pool)
    }
}
impl Drop for TestDatabase {
    fn drop(&mut self) {
        let target = self.0.clone();
        std::thread::spawn(move || {
            tokio::runtime::Runtime::new()
                .unwrap()
                .block_on(async move {
                    let base = std::env::var("I2N_TEST_DATABASE_URL").unwrap();
                    let pool = sqlx::PgPool::connect(&base).await.unwrap();
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
        sqlx::query("INSERT INTO registered_keys VALUES ($1) ON CONFLICT DO NOTHING")
            .bind(key.public.as_slice())
            .execute(&dir.1)
            .await
            .unwrap();
    }
    (dir, router)
}

async fn enroll_key(app: &axum::Router, key: &Identity, otc: &str) {
    let body = serde_json::json!({
        "otc": otc,
        "public_key": key.registration_key(),
    });
    let request = Request::builder()
        .method("POST")
        .uri("/api/register-key")
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    let response = app.clone().oneshot(request).await.unwrap();
    assert_eq!(
        response.status(),
        StatusCode::NO_CONTENT,
        "{}",
        String::from_utf8_lossy(&response.into_body().collect().await.unwrap().to_bytes())
    );
}

async fn register(app: &axum::Router, key: &Identity, otc: &str) -> (StatusCode, Vec<u8>) {
    let body = serde_json::json!({
        "otc": otc,
        "public_key": key.registration_key(),
    });
    let request = Request::builder()
        .method("POST")
        .uri("/api/register-key")
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, bytes.to_vec())
}

async fn call(
    app: &axum::Router,
    key: &Identity,
    method: &str,
    path: &str,
    body: Vec<u8>,
) -> (StatusCode, Vec<u8>) {
    let ts = crypto::now_secs();
    let nonce = client_crypto::fresh_nonce();
    let header =
        client_crypto::authorization(key, "http://i2nclip.test", ts, &nonce, method, path, &body);
    let request = Request::builder()
        .method(method)
        .uri(path)
        .header("authorization", header)
        .body(Body::from(body))
        .unwrap();
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, bytes.to_vec())
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
    use axum::body::Bytes;
    use http_body_util::Channel;
    use std::sync::Arc;
    use std::time::Duration;

    let owner = new_identity();
    let (dir, app) = app(&[&owner]).await;
    let new_key = new_identity();
    let otc = i2nclip::issue_registration_otc(&dir.0, 3600).await.unwrap();
    let id = "6666666666666666666666666666666666666666666666666666666666666666";
    for (method, path, seconds) in [
        ("POST", "/api/media".to_string(), 120),
        ("PUT", format!("/api/media/{id}"), 30),
        ("GET", "/api/media".to_string(), 10),
        ("DELETE", format!("/api/media/{id}"), 10),
        ("POST", "/api/register-key".to_string(), 10),
    ] {
        let registration = path == "/api/register-key";
        let payload = if registration {
            serde_json::json!({ "otc": otc, "public_key": new_key.registration_key() })
                .to_string()
                .into_bytes()
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
        if !registration {
            request = request.header("authorization", &authorization);
        }
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
        if !registration {
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
async fn body_caps_accept_complete_frames_at_the_protocol_boundaries() {
    let owner = new_identity();
    let (dir, app) = app(&[&owner]).await;
    let id = "7777777777777777777777777777777777777777777777777777777777777777";
    assert_eq!(
        call(&app, &owner, "PUT", &format!("/api/media/{id}"), vec![])
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        app.clone()
            .oneshot(
                Request::builder()
                    .uri("/api/health")
                    .body(Body::empty())
                    .unwrap()
            )
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    // The server checks ciphertext framing, not the authentication tag.
    let mut meta = vec![0u8; 65_536];
    meta[0] = 1;
    let mut content = vec![0u8; 33_554_496];
    content[0] = 1;
    let hash = crypto::body_hash(&content);
    let id = hash.as_str();
    let tags = "\n".repeat(4096);
    let body = frame::encode_post(&meta, &content, &tags);
    assert_eq!(body.len(), 33_624_140);
    assert_eq!(
        call(&app, &owner, "POST", "/api/media", body).await.0,
        StatusCode::CREATED
    );
    let body = frame::encode_meta(&meta, &tags);
    assert_eq!(body.len(), 69_640);
    assert_eq!(
        call(&app, &owner, "PUT", &format!("/api/media/{id}"), body)
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(
        call(&app, &owner, "GET", "/api/media", vec![]).await.0,
        StatusCode::OK
    );
    assert_eq!(
        call(&app, &owner, "DELETE", &format!("/api/media/{id}"), vec![])
            .await
            .0,
        StatusCode::NO_CONTENT
    );

    let key = new_identity();
    let otc = i2nclip::issue_registration_otc(&dir.0, 3600).await.unwrap();
    let mut body = serde_json::json!({ "otc": otc, "public_key": key.registration_key() })
        .to_string()
        .into_bytes();
    body.resize(4096, b' ');
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/register-key")
                .body(Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
}

#[tokio::test]
async fn media_body_caps_reject_declared_sizes_before_polling() {
    let owner = new_identity();
    let (_dir, app) = app(&[&owner]).await;
    let id = "8888888888888888888888888888888888888888888888888888888888888888";
    for (method, path, cap) in [
        ("POST", "/api/media".to_string(), 33_624_140),
        ("PUT", format!("/api/media/{id}"), 69_640),
        ("GET", "/api/media".to_string(), 0),
        ("DELETE", format!("/api/media/{id}"), 0),
    ] {
        let authorization = client_crypto::authorization(
            &owner,
            "http://i2nclip.test",
            crypto::now_secs(),
            &client_crypto::fresh_nonce(),
            method,
            &path,
            b"",
        );
        let unreadable = Body::new(Body::from("unread").map_frame(|frame| {
            assert!(
                frame.data_ref().is_none(),
                "oversized declared body was read"
            );
            frame
        }));
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(&path)
                    .header("authorization", &authorization)
                    .header("content-length", cap + 1)
                    .body(unreadable)
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE, "{method}");
        // Header rejection still spends the authenticated nonce.
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

#[tokio::test]
async fn body_caps_count_streamed_bytes_without_trusting_content_length() {
    use axum::body::Bytes;
    use http_body_util::Channel;

    let owner = new_identity();
    let (_dir, app) = app(&[&owner]).await;
    let id = "9999999999999999999999999999999999999999999999999999999999999999";
    for (method, path, cap) in [
        ("POST", "/api/media".to_string(), 33_624_140),
        ("PUT", format!("/api/media/{id}"), 69_640),
        ("GET", "/api/media".to_string(), 0),
        ("DELETE", format!("/api/media/{id}"), 0),
        ("POST", "/api/register-key".to_string(), 4096),
    ] {
        for declared in [None, Some(0)] {
            let bytes = Bytes::from(vec![0u8; cap + 1]);
            let authorization = client_crypto::authorization(
                &owner,
                "http://i2nclip.test",
                crypto::now_secs(),
                &client_crypto::fresh_nonce(),
                method,
                &path,
                &bytes,
            );
            let (mut sender, body) = Channel::<Bytes>::new(2);
            sender.send_data(bytes.slice(..cap)).await.unwrap();
            sender.send_data(bytes.slice(cap..)).await.unwrap();
            drop(sender);
            let mut request = Request::builder().method(method).uri(&path);
            if path != "/api/register-key" {
                request = request.header("authorization", authorization);
            }
            if let Some(len) = declared {
                request = request.header("content-length", len);
            }
            let response = app
                .clone()
                .oneshot(request.body(Body::new(body)).unwrap())
                .await
                .unwrap();
            assert_eq!(
                response.status(),
                StatusCode::PAYLOAD_TOO_LARGE,
                "{method} {path}, declared={declared:?}"
            );
            assert_eq!(response.headers()["cache-control"], "no-store");
            let body = response.into_body().collect().await.unwrap().to_bytes();
            assert_eq!(
                serde_json::from_slice::<serde_json::Value>(&body).unwrap(),
                serde_json::json!({ "error": "too large" })
            );
        }
    }
}

#[tokio::test]
async fn health_needs_no_key() {
    let (_dir, app) = app(&[]).await;
    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/health")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
}

#[tokio::test]
async fn upload_list_get_delete_roundtrip_and_hides_plaintext() {
    let key = new_identity();
    let (dir, app) = app(&[&key]).await;

    let marker = b"PLAINTEXT-MARKER-i2nclip-upload";
    let filename = "vacation-photo.jpg";
    let tag = "secret-tag-zebra";
    let meta_json =
        format!(r#"{{"name":"{filename}","content_type":"image/jpeg","size":1,"tags":["{tag}"]}}"#);
    let content = client_crypto::encrypt(&key.seed, &client_crypto::content_aad(), marker).unwrap();
    let hash = crypto::body_hash(&content);
    let id = hash.as_str();
    let meta = client_crypto::encrypt(
        &key.seed,
        &client_crypto::meta_aad(id),
        meta_json.as_bytes(),
    )
    .unwrap();

    let token = client_crypto::tag_token(&key.seed, tag).unwrap();
    let body = frame::encode_post(&meta, &content, &token);

    let (status, bytes) = call(&app, &key, "POST", "/api/media", body).await;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "{}",
        String::from_utf8_lossy(&bytes)
    );

    let (status, listed) = call(
        &app,
        &key,
        "GET",
        &format!("/api/media?tag={token}"),
        Vec::new(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let listed: serde_json::Value = serde_json::from_slice(&listed).unwrap();
    assert_eq!(listed["media"][0]["id"], id);

    let (status, stored) = call(&app, &key, "GET", &format!("/api/media/{id}"), Vec::new()).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        client_crypto::decrypt(&key.seed, &client_crypto::content_aad(), &stored).unwrap(),
        marker
    );

    let needles: [&[u8]; 3] = [marker, filename.as_bytes(), tag.as_bytes()];
    let row: (Vec<u8>, Vec<u8>) = sqlx::query_as("SELECT meta,content FROM files WHERE id=$1")
        .bind(id)
        .fetch_one(&dir.1)
        .await
        .unwrap();
    for data in [row.0, row.1] {
        for needle in needles {
            assert!(!data.windows(needle.len()).any(|w| w == needle));
        }
    }

    let (status, _) = call(
        &app,
        &key,
        "DELETE",
        &format!("/api/media/{id}"),
        Vec::new(),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, _) = call(&app, &key, "GET", &format!("/api/media/{id}"), Vec::new()).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn another_key_cannot_see_or_search() {
    let owner = new_identity();
    let other = new_identity();
    let (_dir, app) = app(&[&owner, &other]).await;

    let content =
        client_crypto::encrypt(&owner.seed, &client_crypto::content_aad(), b"pic").unwrap();
    let hash = crypto::body_hash(&content);
    let id = hash.as_str();
    let meta = client_crypto::encrypt(&owner.seed, &client_crypto::meta_aad(id), b"{}").unwrap();

    let token = client_crypto::tag_token(&owner.seed, "shared-word").unwrap();
    let other_token = client_crypto::tag_token(&other.seed, "shared-word").unwrap();
    assert_ne!(token, other_token);
    let body = frame::encode_post(&meta, &content, &token);
    assert_eq!(
        call(&app, &owner, "POST", "/api/media", body).await.0,
        StatusCode::CREATED
    );
    assert_eq!(
        call(&app, &other, "GET", &format!("/api/media/{id}"), Vec::new())
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    let (_status, listed) = call(
        &app,
        &other,
        "GET",
        &format!("/api/media?tag={other_token}"),
        Vec::new(),
    )
    .await;
    let listed: serde_json::Value = serde_json::from_slice(&listed).unwrap();
    assert_eq!(listed["media"].as_array().unwrap().len(), 0);
    assert_eq!(
        call(
            &app,
            &other,
            "DELETE",
            &format!("/api/media/{id}"),
            Vec::new()
        )
        .await
        .0,
        StatusCode::NOT_FOUND
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
    let meta = client_crypto::encrypt(&key.seed, &client_crypto::meta_aad(id), b"{}").unwrap();
    let body = frame::encode_post(&meta, b"\xff\xd8\xff\xd8not-encrypted", "not-a-token");
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

    let otc = i2nclip::issue_registration_otc(&dir.0, 3600).await.unwrap();
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
    let otc = i2nclip::issue_registration_otc(&dir.0, 3600).await.unwrap();
    enroll_key(&app, &key, &otc).await;
    let (status, _) = register(&app, &key, &otc).await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    let otc2 = i2nclip::issue_registration_otc(&dir.0, 3600).await.unwrap();
    let (status, _) = register(&app, &key, &otc2).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
}

#[tokio::test]
async fn rejected_public_keys_do_not_consume_registration_code() {
    let (dir, app) = app(&[]).await;
    let otc = i2nclip::issue_registration_otc(&dir.0, 3600).await.unwrap();
    let mut identity = [0u8; 32];
    identity[0] = 1;
    for public in [identity, [0u8; 32], [2u8; 32]] {
        let invalid = Identity {
            seed: [0u8; 32],
            public,
        };
        let (status, body) = register(&app, &invalid, &otc).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&body).unwrap(),
            serde_json::json!({ "error": "invalid public_key" })
        );
    }
    let conn = &dir.1;
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM registered_keys")
            .fetch_one(conn)
            .await
            .unwrap(),
        0
    );
    let valid = new_identity();
    enroll_key(&app, &valid, &otc).await;
    assert_eq!(
        call(&app, &valid, "GET", "/api/media", vec![]).await.0,
        StatusCode::OK
    );
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
async fn duplicate_uploads_conflict_without_replacing_content() {
    let owner = new_identity();
    let other = new_identity();
    let (_dir, app) = app(&[&owner, &other]).await;

    let content =
        client_crypto::encrypt(&owner.seed, &client_crypto::content_aad(), b"original").unwrap();
    let hash = crypto::body_hash(&content);
    let id = hash.as_str();
    let meta = client_crypto::encrypt(&owner.seed, &client_crypto::meta_aad(id), b"{}").unwrap();

    let body = frame::encode_post(&meta, &content, "");
    let first = call(&app, &owner, "POST", "/api/media", body.clone()).await;
    let retry = call(&app, &owner, "POST", "/api/media", body.clone()).await;
    assert_eq!(first.0, StatusCode::CREATED);
    assert_eq!(retry.0, StatusCode::CONFLICT);
    assert_eq!(
        call(&app, &other, "POST", "/api/media", body).await.0,
        StatusCode::CONFLICT
    );
    let changed =
        client_crypto::encrypt(&owner.seed, &client_crypto::content_aad(), b"changed").unwrap();
    assert_eq!(
        call(
            &app,
            &owner,
            "POST",
            "/api/media",
            frame::encode_post(&meta, &changed, "")
        )
        .await
        .0,
        StatusCode::CREATED
    );
    let (_, listed) = call(&app, &owner, "GET", "/api/media", vec![]).await;
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&listed).unwrap()["media"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    let (status, downloaded) = call(&app, &owner, "GET", &format!("/api/media/{id}"), vec![]).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(downloaded, content);

    assert_eq!(
        call(
            &app,
            &owner,
            "POST",
            "/api/media",
            frame::encode_post(&meta, &content, "")
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
}

#[tokio::test]
async fn reopening_database_preserves_media() {
    let owner = new_identity();
    let (dir, app) = app(&[&owner]).await;

    let content =
        client_crypto::encrypt(&owner.seed, &client_crypto::content_aad(), b"original").unwrap();
    let hash = crypto::body_hash(&content);
    let id = hash.as_str();
    let meta = client_crypto::encrypt(&owner.seed, &client_crypto::meta_aad(id), b"{}").unwrap();

    let token = client_crypto::tag_token(&owner.seed, "keep").unwrap();
    let body = frame::encode_post(&meta, &content, &token);
    assert_eq!(
        call(&app, &owner, "POST", "/api/media", body).await.0,
        StatusCode::CREATED
    );
    drop(app);

    let app = i2nclip::router(&dir.0, "http://i2nclip.test")
        .await
        .unwrap();
    let (status, downloaded) = call(&app, &owner, "GET", &format!("/api/media/{id}"), vec![]).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(downloaded, content);
    let (_, listed) = call(&app, &owner, "GET", "/api/media", vec![]).await;
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&listed).unwrap()["media"][0]["meta"],
        STANDARD.encode(meta)
    );
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&listed).unwrap()["media"][0]["tokens"],
        serde_json::json!([token])
    );
    drop(app);
    let _reopened = i2nclip::router(&dir.0, "http://i2nclip.test")
        .await
        .unwrap();
}

#[tokio::test(start_paused = true)]
async fn upload_admission_is_shared_and_releases_capacity() {
    let _clock = manual_clock();
    use axum::body::Bytes;
    use http_body_util::Channel;
    use std::sync::Arc;
    use std::time::Duration;

    async fn stall(
        app: &axum::Router,
        owner: &Identity,
    ) -> tokio::task::JoinHandle<Result<axum::response::Response, std::convert::Infallible>> {
        let (mut sender, body) = Channel::<Bytes>::new(1);
        sender.send_data(Bytes::new()).await.unwrap();
        let polled = Arc::new(tokio::sync::Notify::new());
        let observed = polled.clone();
        let body = Body::new(body.map_frame(move |frame| {
            observed.notify_one();
            frame
        }));
        let authorization = client_crypto::authorization(
            owner,
            "http://i2nclip.test",
            crypto::now_secs(),
            &client_crypto::fresh_nonce(),
            "POST",
            "/api/media",
            b"",
        );
        // Retain the sender in the HTTP task so the stream stays unfinished.
        let router = app.clone();
        let task = tokio::spawn(async move {
            let result = router
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri("/api/media")
                        .header("authorization", authorization)
                        .body(body)
                        .unwrap(),
                )
                .await;
            drop(sender);
            result
        });
        polled.notified().await;
        task
    }

    let owner = new_identity();
    let other = new_identity();
    let (dir, app) = app(&[&owner, &other]).await;
    let first = stall(&app, &owner).await;
    let second = stall(&app, &other).await;
    let authorization = client_crypto::authorization(
        &owner,
        "http://i2nclip.test",
        crypto::now_secs(),
        &client_crypto::fresh_nonce(),
        "POST",
        "/api/media",
        b"",
    );
    let unreadable = Body::new(Body::from("unread").map_frame(|_| panic!("busy body polled")));
    let busy = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/media")
                .header("authorization", &authorization)
                .body(unreadable)
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(busy.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(busy.headers()["retry-after"], "1");
    assert_eq!(busy.headers()["cache-control"], "no-store");
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(
            &busy.into_body().collect().await.unwrap().to_bytes()
        )
        .unwrap(),
        serde_json::json!({"error": "uploads busy; try again"})
    );
    let replay = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/media")
                .header("authorization", authorization)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(replay.status(), StatusCode::UNAUTHORIZED);
    let bad = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/media")
                .body(Body::new(
                    Body::from("unread").map_frame(|_| panic!("unauthenticated body polled")),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(bad.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(
        call(&app, &owner, "GET", "/api/media", vec![]).await.0,
        StatusCode::OK
    );
    let id = "7777777777777777777777777777777777777777777777777777777777777777";
    assert_eq!(
        call(&app, &owner, "DELETE", &format!("/api/media/{id}"), vec![])
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    let otc = i2nclip::issue_registration_otc(&dir.0, 3600).await.unwrap();
    enroll_key(&app, &new_identity(), &otc).await;
    first.abort();
    assert!(first.await.unwrap_err().is_cancelled());
    // Streaming, transport, and hash failures also return the available slot.
    let (sender, broken) = Channel::<Bytes, std::io::Error>::new(1);
    sender.abort(std::io::Error::other("broken upload"));
    for (body, expected) in [
        (Body::new(broken), StatusCode::BAD_REQUEST),
        (
            Body::from(vec![0; 33_624_141]),
            StatusCode::PAYLOAD_TOO_LARGE,
        ),
        (Body::from("wrong signed bytes"), StatusCode::UNAUTHORIZED),
    ] {
        let authorization = client_crypto::authorization(
            &owner,
            "http://i2nclip.test",
            crypto::now_secs(),
            &client_crypto::fresh_nonce(),
            "POST",
            "/api/media",
            b"",
        );
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/media")
                    .header("authorization", authorization)
                    .body(body)
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), expected);
    }
    // Each failure must return the one available slot.
    for _ in 0..3 {
        assert_eq!(
            call(
                &app,
                &owner,
                "POST",
                "/api/media",
                b"invalid frame".to_vec()
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
    }

    let content =
        client_crypto::encrypt(&owner.seed, &client_crypto::content_aad(), b"file").unwrap();
    let hash = crypto::body_hash(&content);
    let id = hash.as_str();
    let meta = client_crypto::encrypt(&owner.seed, &client_crypto::meta_aad(id), b"{}").unwrap();
    let frame = frame::encode_post(&meta, &content, "");
    assert_eq!(
        call(&app, &owner, "POST", "/api/media", frame.clone())
            .await
            .0,
        StatusCode::CREATED
    );
    assert_eq!(
        call(&app, &owner, "POST", "/api/media", frame).await.0,
        StatusCode::CONFLICT
    );
    tokio::time::advance(Duration::from_secs(120)).await;
    assert_eq!(
        second.await.unwrap().unwrap().status(),
        StatusCode::REQUEST_TIMEOUT
    );
    // Both slots become usable again after cancellation and timeout.
    let first = stall(&app, &owner).await;
    let second = stall(&app, &other).await;
    first.abort();
    second.abort();
    let _ = first.await;
    let _ = second.await;
}

async fn download_response(
    app: &axum::Router,
    owner: &Identity,
    id: &str,
) -> axum::response::Response {
    let path = format!("/api/media/{id}");
    let authorization = client_crypto::authorization(
        owner,
        "http://i2nclip.test",
        crypto::now_secs(),
        &client_crypto::fresh_nonce(),
        "GET",
        &path,
        b"",
    );
    app.clone()
        .oneshot(
            Request::builder()
                .uri(path)
                .header("authorization", authorization)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap()
}

#[tokio::test]
async fn concurrent_routers_publish_one_hash() {
    let owner = new_identity();
    let other = new_identity();
    let (dir, first) = app(&[&owner, &other]).await;
    let second = i2nclip::router(&dir.0, "http://i2nclip.test")
        .await
        .unwrap();
    let content = client_crypto::encrypt(
        &owner.seed,
        &client_crypto::content_aad(),
        b"same sealed bytes",
    )
    .unwrap();
    let id = crypto::body_hash(&content);
    let meta = client_crypto::encrypt(&owner.seed, &client_crypto::meta_aad(&id), b"{}").unwrap();
    let body = frame::encode_post(&meta, &content, "");
    let (a, b) = tokio::join!(
        call(&first, &owner, "POST", "/api/media", body.clone()),
        call(&second, &other, "POST", "/api/media", body),
    );
    assert!(matches!(
        (a.0, b.0),
        (StatusCode::CREATED, StatusCode::CONFLICT) | (StatusCode::CONFLICT, StatusCode::CREATED)
    ));
    let winner = if a.0 == StatusCode::CREATED {
        &owner
    } else {
        &other
    };
    assert_eq!(
        call(&first, winner, "GET", &format!("/api/media/{id}"), vec![])
            .await
            .1,
        content
    );
    let conn = &dir.1;
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM files")
            .fetch_one(conn)
            .await
            .unwrap(),
        1
    );
}

#[tokio::test]
async fn downloads_retain_owned_content_after_deletion() {
    let owner = new_identity();
    let other = new_identity();
    let (_dir, app) = app(&[&owner, &other]).await;

    let content = client_crypto::encrypt(
        &owner.seed,
        &client_crypto::content_aad(),
        &vec![7; 180_000],
    )
    .unwrap();
    let hash = crypto::body_hash(&content);
    let id = hash.as_str();
    let meta = client_crypto::encrypt(&owner.seed, &client_crypto::meta_aad(id), b"{}").unwrap();
    assert_eq!(
        call(
            &app,
            &owner,
            "POST",
            "/api/media",
            frame::encode_post(&meta, &content, "")
        )
        .await
        .0,
        StatusCode::CREATED
    );
    assert_eq!(
        download_response(&app, &other, id).await.status(),
        StatusCode::NOT_FOUND
    );
    let first = download_response(&app, &owner, id).await;
    let second = download_response(&app, &owner, id).await;
    assert_eq!(first.status(), StatusCode::OK);
    assert_eq!(first.headers()["content-length"], content.len().to_string());
    assert_eq!(first.headers()["content-type"], "application/octet-stream");
    let busy = download_response(&app, &owner, id).await;
    assert_eq!(busy.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(busy.headers()["retry-after"], "1");
    assert_eq!(busy.headers()["cache-control"], "no-store");
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(
            &busy.into_body().collect().await.unwrap().to_bytes()
        )
        .unwrap(),
        serde_json::json!({"error": "downloads busy; try again"})
    );
    assert_eq!(
        call(&app, &owner, "GET", "/api/media", vec![]).await.0,
        StatusCode::OK
    );
    drop(second); // An unpolled response also returns its slot.
    let mut body = first.into_body();
    let first_chunk = body.frame().await.unwrap().unwrap().into_data().unwrap();
    assert!(first_chunk.len() <= 64 * 1024);
    assert!(first_chunk.len() < content.len());
    let second = download_response(&app, &owner, id).await;
    assert_eq!(second.status(), StatusCode::OK);
    assert_eq!(
        download_response(&app, &owner, id).await.status(),
        StatusCode::SERVICE_UNAVAILABLE
    );
    let mut partial = second.into_body();
    assert!(partial.frame().await.unwrap().is_ok());
    drop(partial); // Cancelling after a chunk also returns its slot.
                   // An opened stream survives deletion. Different ciphertext has a different URL.
    assert_eq!(
        call(&app, &owner, "DELETE", &format!("/api/media/{id}"), vec![])
            .await
            .0,
        StatusCode::NO_CONTENT
    );
    let replacement =
        client_crypto::encrypt(&other.seed, &client_crypto::content_aad(), b"replacement").unwrap();
    let replacement_hash = crypto::body_hash(&replacement);
    let id = replacement_hash.as_str();
    let other_meta =
        client_crypto::encrypt(&other.seed, &client_crypto::meta_aad(id), b"{}").unwrap();
    assert_eq!(
        call(
            &app,
            &other,
            "POST",
            "/api/media",
            frame::encode_post(&other_meta, &replacement, "")
        )
        .await
        .0,
        StatusCode::CREATED
    );
    let mut received = first_chunk.to_vec();
    while let Some(chunk) = body.frame().await {
        let chunk = chunk.unwrap().into_data().unwrap();
        assert!(chunk.len() <= 64 * 1024);
        received.extend_from_slice(&chunk);
    }
    assert_eq!(received, content);
    // Completion releases the permit even while the empty body remains alive.
    let first = download_response(&app, &other, id).await;
    let second = download_response(&app, &other, id).await;
    assert_eq!(first.status(), StatusCode::OK);
    assert_eq!(second.status(), StatusCode::OK);
    drop(first);
    drop(second);
    assert_eq!(
        download_response(&app, &owner, id).await.status(),
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn list_query_validation_is_scoped_to_the_list_endpoint() {
    let owner = new_identity();
    let (_dir, app) = app(&[&owner]).await;
    assert_eq!(
        call(&app, &owner, "GET", "/api/media?after=invalid", vec![])
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    let path = format!("/api/media/{}?after=invalid&tag=invalid", "a".repeat(64));
    assert_eq!(
        call(&app, &owner, "GET", &path, vec![]).await.0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        call(&app, &owner, "DELETE", &path, vec![]).await.0,
        StatusCode::NOT_FOUND
    );
    let content = client_crypto::encrypt(
        &owner.seed,
        &client_crypto::content_aad(),
        b"query isolation",
    )
    .unwrap();
    let id = crypto::body_hash(&content);
    let meta = client_crypto::encrypt(&owner.seed, &client_crypto::meta_aad(&id), b"{}").unwrap();
    let body = frame::encode_post(&meta, &content, "");
    assert_eq!(
        call(&app, &owner, "POST", "/api/media?after=invalid", body)
            .await
            .0,
        StatusCode::CREATED
    );
    let path = format!("/api/media/{id}?after=invalid");
    assert_eq!(
        call(&app, &owner, "PUT", &path, frame::encode_meta(&meta, ""))
            .await
            .0,
        StatusCode::OK
    );
}

#[tokio::test]
async fn invitation_race_has_one_winner() {
    let (dir, first) = app(&[]).await;
    let second = i2nclip::router(&dir.0, "http://i2nclip.test")
        .await
        .unwrap();
    let code = i2nclip::issue_registration_otc(&dir.0, 3600).await.unwrap();
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
async fn failed_tag_writes_roll_back_upload_and_metadata() {
    let key = new_identity();
    let (dir, app) = app(&[&key]).await;
    let token = URL_SAFE_NO_PAD.encode([1u8; 32]);
    let content =
        client_crypto::encrypt(&key.seed, &client_crypto::content_aad(), b"atomic").unwrap();
    let id = crypto::body_hash(&content);
    let meta = client_crypto::encrypt(&key.seed, &client_crypto::meta_aad(&id), b"old").unwrap();
    sqlx::raw_sql(
        r#"
        CREATE FUNCTION reject_tags() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
            RAISE EXCEPTION 'test failure';
        END;
        $$;

        CREATE TRIGGER reject_tags
            BEFORE INSERT ON tags
            FOR EACH ROW EXECUTE FUNCTION reject_tags();
        "#,
    )
    .execute(&dir.1)
    .await
    .unwrap();
    assert_eq!(
        call(
            &app,
            &key,
            "POST",
            "/api/media",
            frame::encode_post(&meta, &content, &token)
        )
        .await
        .0,
        StatusCode::INTERNAL_SERVER_ERROR
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM files")
            .fetch_one(&dir.1)
            .await
            .unwrap(),
        0
    );
    sqlx::query("DROP TRIGGER reject_tags ON tags")
        .execute(&dir.1)
        .await
        .unwrap();
    assert_eq!(
        call(
            &app,
            &key,
            "POST",
            "/api/media",
            frame::encode_post(&meta, &content, &token)
        )
        .await
        .0,
        StatusCode::CREATED
    );
    sqlx::query(
        r#"
        CREATE TRIGGER reject_tags
            BEFORE INSERT ON tags
            FOR EACH ROW EXECUTE FUNCTION reject_tags()
        "#,
    )
    .execute(&dir.1)
    .await
    .unwrap();
    let new_meta =
        client_crypto::encrypt(&key.seed, &client_crypto::meta_aad(&id), b"new").unwrap();
    assert_eq!(
        call(
            &app,
            &key,
            "PUT",
            &format!("/api/media/{id}"),
            frame::encode_meta(&new_meta, &token)
        )
        .await
        .0,
        StatusCode::INTERNAL_SERVER_ERROR
    );
    let stored: Vec<u8> = sqlx::query_scalar("SELECT meta FROM files WHERE id=$1")
        .bind(&id)
        .fetch_one(&dir.1)
        .await
        .unwrap();
    assert_eq!(stored, meta);
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM tags")
            .fetch_one(&dir.1)
            .await
            .unwrap(),
        1
    );
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
#[ignore = "maximum-size transfer resource profile; run explicitly with --ignored --nocapture"]
async fn maximum_size_transfer_profile() {
    let key = new_identity();
    let (dir, app) = app(&[&key]).await;
    let (stop, mut stopped) = tokio::sync::watch::channel(false);
    let responsiveness = tokio::spawn(async move {
        let mut worst = std::time::Duration::ZERO;
        loop {
            let start = std::time::Instant::now();
            tokio::select! {
                _ = stopped.changed() => break,
                _ = tokio::time::sleep(std::time::Duration::from_millis(10)) => {}
            }
            worst = worst.max(
                start
                    .elapsed()
                    .saturating_sub(std::time::Duration::from_millis(10)),
            );
        }
        worst
    });
    let content1 = client_crypto::encrypt(
        &key.seed,
        &client_crypto::content_aad(),
        &vec![1; 32 * 1024 * 1024],
    )
    .unwrap();
    let content2 = client_crypto::encrypt(
        &key.seed,
        &client_crypto::content_aad(),
        &vec![2; 32 * 1024 * 1024],
    )
    .unwrap();
    let id1 = crypto::body_hash(&content1);
    let id2 = crypto::body_hash(&content2);
    let meta1 = client_crypto::encrypt(&key.seed, &client_crypto::meta_aad(&id1), b"{}").unwrap();
    let meta2 = client_crypto::encrypt(&key.seed, &client_crypto::meta_aad(&id2), b"{}").unwrap();
    let start = std::time::Instant::now();
    let (a, b) = tokio::join!(
        call(
            &app,
            &key,
            "POST",
            "/api/media",
            frame::encode_post(&meta1, &content1, "")
        ),
        call(
            &app,
            &key,
            "POST",
            "/api/media",
            frame::encode_post(&meta2, &content2, "")
        )
    );
    assert_eq!(a.0, StatusCode::CREATED);
    assert_eq!(b.0, StatusCode::CREATED);
    let (a, b) = tokio::join!(
        download_response(&app, &key, &id1),
        download_response(&app, &key, &id2)
    );
    assert_eq!(a.status(), StatusCode::OK);
    assert_eq!(b.status(), StatusCode::OK);
    // Responses are held unpolled: the database must have no idle transaction.
    let active: i64 = sqlx::query_scalar(
        r#"
        SELECT count(*)
        FROM pg_stat_activity
        WHERE datname = current_database() AND state = 'idle in transaction'
        "#,
    )
    .fetch_one(&dir.1)
    .await
    .unwrap();
    assert_eq!(active, 0);
    let (a, b) = tokio::join!(a.into_body().collect(), b.into_body().collect());
    assert_eq!(a.unwrap().to_bytes().as_ref(), content1);
    assert_eq!(b.unwrap().to_bytes().as_ref(), content2);
    stop.send(true).unwrap();
    eprintln!(
        "transfer elapsed={:?}, worst 10ms timer delay={:?}",
        start.elapsed(),
        responsiveness.await.unwrap()
    );
    eprintln!(
        "{}",
        std::fs::read_to_string("/proc/self/status")
            .unwrap()
            .lines()
            .filter(|l| l.starts_with("VmHWM") || l.starts_with("VmRSS"))
            .collect::<Vec<_>>()
            .join("\n")
    );
    let memory: i64 =
        sqlx::query_scalar("SELECT sum(total_bytes)::bigint FROM pg_backend_memory_contexts")
            .fetch_one(&dir.1)
            .await
            .unwrap();
    eprintln!("PostgreSQL inspecting backend allocated context bytes={memory}");
}
