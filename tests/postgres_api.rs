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
mod reference_crypto;

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

#[tokio::test]
async fn tag_catalog_requires_signed_empty_requests_and_filters_owners() {
    let owner = new_identity();
    let other = new_identity();
    let stranger = new_identity();
    let (_db, app) = app(&[&owner, &other]).await;
    let token = client_crypto::tag_token(&owner.seed, "Holiday").unwrap();
    let content = client_crypto::sealed_fixture(0, 43);
    let body = client_crypto::encode_post(&content, &content, &fixture_tag_labels(&token));
    assert_eq!(
        call(&app, &owner, "POST", "/api/media", body).await.0,
        StatusCode::CREATED
    );
    let (status, body) = call(&app, &owner, "GET", "/api/tags", vec![]).await;
    assert_eq!(status, StatusCode::OK);
    let value: serde_json::Value = client_crypto::document_json(&body);
    assert_eq!(value["tags"].as_array().unwrap().len(), 1);
    assert_eq!(
        value["tags"][0]["token"],
        serde_json::json!(URL_SAFE_NO_PAD.decode(token).unwrap())
    );
    assert!(!String::from_utf8_lossy(&body).contains("Holiday"));
    let (_, body) = call(&app, &other, "GET", "/api/tags", vec![]).await;
    assert_eq!(
        client_crypto::document_json(&body)["tags"],
        serde_json::json!([])
    );
    assert_eq!(
        call(&app, &stranger, "GET", "/api/tags", vec![]).await.0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        call(&app, &owner, "GET", "/api/tags", vec![1]).await.0,
        StatusCode::PAYLOAD_TOO_LARGE
    );
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
    let body = client_crypto::registration_body(otc, &key.public);
    let request = Request::builder()
        .method("POST")
        .uri("/api/register-key")
        .header("content-type", codec::CONTENT_TYPE)
        .body(Body::from(body))
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
    let body = client_crypto::registration_body(otc, &key.public);
    let request = Request::builder()
        .method("POST")
        .uri("/api/register-key")
        .header("content-type", codec::CONTENT_TYPE)
        .body(Body::from(body))
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
        ("POST", "/api/media".to_string(), 120),
        ("PUT", format!("/api/media/{id}/meta"), 30),
        ("GET", "/api/media".to_string(), 10),
        ("DELETE", format!("/api/media/{id}"), 10),
        ("POST", "/api/register-key".to_string(), 10),
    ] {
        let registration = path == "/api/register-key";
        let payload = if registration {
            client_crypto::registration_body(&otc, &new_key.public)
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
        call(
            &app,
            &owner,
            "PUT",
            &format!("/api/media/{id}/meta"),
            vec![]
        )
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
    let meta = client_crypto::sealed_fixture(0, 65_536);
    let content = client_crypto::sealed_fixture(0, 33_554_496);
    let hash = crypto::body_hash(&content);
    let id = hash.as_str();
    let tags = b"\x90".to_vec();
    let body = client_crypto::encode_post(&meta, &content, &tags);
    assert!(body.len() <= 33_718_400);
    assert_eq!(
        call(&app, &owner, "POST", "/api/media", body).await.0,
        StatusCode::CREATED
    );
    let body = client_crypto::encode_meta(&raw_hash(&meta), &meta, &tags);
    assert!(body.len() <= 163_936);
    assert_eq!(
        call(&app, &owner, "PUT", &format!("/api/media/{id}/meta"), body)
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
    let otc = i2nclip::issue_registration_otc(&dir.0, 3600, i2nclip::StorageLimits::default())
        .await
        .unwrap();
    let body = client_crypto::registration_body(&otc, &key.public);
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
        ("POST", "/api/media".to_string(), 33_718_400),
        ("PUT", format!("/api/media/{id}/meta"), 163_936),
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
        ("POST", "/api/media".to_string(), 33_718_400),
        ("PUT", format!("/api/media/{id}/meta"), 163_936),
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
                client_crypto::document_json(&body),
                serde_json::json!({ "error": "too large" })
            );
        }
    }
}

#[tokio::test]
async fn upload_list_get_delete_roundtrip_and_hides_plaintext() {
    let key = new_identity();
    let (dir, app) = app(&[&key]).await;

    let marker = b"PLAINTEXT-MARKER-i2nclip-upload";
    let filename = "vacation-photo.jpg";
    let tag = "secret-tag-zebra";
    let meta_json =
        format!(r#"{{"name":"{filename}","contentType":"image/jpeg","size":1,"tags":["{tag}"]}}"#);
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
    let body = client_crypto::encode_post(&meta, &content, &fixture_tag_labels(&token));

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
    let listed: serde_json::Value = client_crypto::document_json(&listed);
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
    let body = client_crypto::encode_post(&meta, &content, &fixture_tag_labels(&token));
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
    let listed: serde_json::Value = client_crypto::document_json(&listed);
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
    let body = client_crypto::encode_post(
        &meta,
        b"\xff\xd8\xff\xd8not-encrypted",
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
async fn rejected_public_keys_do_not_consume_registration_code() {
    let (dir, app) = app(&[]).await;
    let otc = i2nclip::issue_registration_otc(&dir.0, 3600, i2nclip::StorageLimits::default())
        .await
        .unwrap();
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
            client_crypto::document_json(&body),
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

    let body = client_crypto::encode_post(&meta, &content, b"\x90");
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
            client_crypto::encode_post(&meta, &changed, b"\x90")
        )
        .await
        .0,
        StatusCode::CREATED
    );
    let (_, listed) = call(&app, &owner, "GET", "/api/media", vec![]).await;
    assert_eq!(
        client_crypto::document_json(&listed)["media"]
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
            client_crypto::encode_post(&meta, &content, b"\x90")
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
    let body = client_crypto::encode_post(&meta, &content, &fixture_tag_labels(&token));
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
        client_crypto::document_json(&listed)["media"][0]["meta"],
        serde_json::json!(meta)
    );
    let page: serde_json::Value = client_crypto::document_json(&listed);
    assert!(page["media"][0].get("tokens").is_none());
    let (_, filtered) = call(
        &app,
        &owner,
        "GET",
        &format!("/api/media?tag={token}"),
        vec![],
    )
    .await;
    let filtered: serde_json::Value = client_crypto::document_json(&filtered);
    assert_eq!(filtered["media"][0]["id"], id);
    drop(app);
    let _reopened = i2nclip::router(&dir.0, "http://i2nclip.test")
        .await
        .unwrap();
}

#[tokio::test(start_paused = true)]
async fn upload_admission_is_shared_and_releases_capacity() {
    let _clock = manual_clock();
    use std::{sync::Arc, time::Duration};

    use axum::body::Bytes;
    use http_body_util::Channel;

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
    let third_owner = new_identity();
    let fourth_owner = new_identity();
    let (dir, app) = app(&[&owner, &other, &third_owner, &fourth_owner]).await;
    let first = stall(&app, &owner).await;
    let second = stall(&app, &other).await;
    let third = stall(&app, &third_owner).await;
    let fourth = stall(&app, &fourth_owner).await;
    let authorization = client_crypto::authorization(
        &owner,
        "http://i2nclip.test",
        crypto::now_secs(),
        &client_crypto::fresh_nonce(),
        "POST",
        "/api/media",
        b"",
    );
    let queued = {
        let router = app.clone();
        let authorization = authorization.clone();
        tokio::spawn(async move {
            router
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri("/api/media")
                        .header("authorization", authorization)
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap()
        })
    };
    tokio::task::yield_now().await;
    assert!(!queued.is_finished(), "upload waits for an available slot");
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
    let otc = i2nclip::issue_registration_otc(&dir.0, 3600, i2nclip::StorageLimits::default())
        .await
        .unwrap();
    enroll_key(&app, &new_identity(), &otc).await;
    first.abort();
    assert!(first.await.unwrap_err().is_cancelled());
    // Admission resumes the authenticated request. Its signed empty body
    // matches the hash, but is not a valid upload frame.
    assert_eq!(queued.await.unwrap().status(), StatusCode::BAD_REQUEST);
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
    // Streaming, transport, and hash failures also return the available slot.
    let (sender, broken) = Channel::<Bytes, std::io::Error>::new(1);
    sender.abort(std::io::Error::other("broken upload"));
    for (body, expected) in [
        (Body::new(broken), StatusCode::BAD_REQUEST),
        (
            Body::from(vec![0; 33_718_401]),
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
    let frame = client_crypto::encode_post(&meta, &content, b"\x90");
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
    for task in [third, fourth] {
        assert_eq!(
            task.await.unwrap().unwrap().status(),
            StatusCode::REQUEST_TIMEOUT
        );
    }
    // Slots become usable again after cancellation and timeout.
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
    let body = client_crypto::encode_post(&meta, &content, b"\x90");
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
    for key in [&owner, &other] {
        let actual: (i64, i64) = sqlx::query_as(
            "SELECT used_content_bytes, file_count FROM key_quotas WHERE public_key = $1",
        )
        .bind(key.public.as_slice())
        .fetch_one(&dir.1)
        .await
        .unwrap();
        let expected = if key.public == winner.public {
            (content.len() as i64, 1)
        } else {
            (0, 0)
        };
        assert_eq!(actual, expected);
    }
}

#[tokio::test]
async fn downloads_retain_owned_content_after_deletion() {
    use std::time::Duration;

    tokio::time::timeout(Duration::from_secs(60), async {
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
        let meta =
            client_crypto::encrypt(&owner.seed, &client_crypto::meta_aad(id), b"{}").unwrap();
        assert_eq!(
            call(
                &app,
                &owner,
                "POST",
                "/api/media",
                client_crypto::encode_post(&meta, &content, b"\x90")
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
        assert_eq!(first.headers()["content-type"], codec::CONTENT_TYPE);
        let queued = download_response(&app, &owner, id);
        tokio::pin!(queued);
        assert!(
            tokio::time::timeout(Duration::from_millis(100), &mut queued)
                .await
                .is_err(),
            "a third download waits while the two per-key slots are held"
        );
        assert_eq!(
            call(&app, &owner, "GET", "/api/media", vec![]).await.0,
            StatusCode::OK
        );
        drop(second); // An unpolled response also returns its slot.
        let second = tokio::time::timeout(Duration::from_secs(5), queued)
            .await
            .expect("dropping an unpolled response must admit the queued download");
        assert_eq!(second.status(), StatusCode::OK);
        let mut body = first.into_body();
        let first_chunk = body.frame().await.unwrap().unwrap().into_data().unwrap();
        assert!(first_chunk.len() <= 64 * 1024);
        assert!(first_chunk.len() < content.len());
        let queued = download_response(&app, &owner, id);
        tokio::pin!(queued);
        assert!(
            tokio::time::timeout(Duration::from_millis(100), &mut queued)
                .await
                .is_err(),
            "a partially consumed response continues to hold its slot"
        );
        let mut partial = second.into_body();
        assert!(partial.frame().await.unwrap().is_ok());
        drop(partial); // Cancelling after a chunk also returns its slot.
        let admitted = tokio::time::timeout(Duration::from_secs(5), queued)
            .await
            .expect("dropping a partial response must admit the queued download");
        assert_eq!(admitted.status(), StatusCode::OK);
        drop(admitted);
        // An opened stream survives deletion. Different ciphertext has a different URL.
        assert_eq!(
            call(&app, &owner, "DELETE", &format!("/api/media/{id}"), vec![])
                .await
                .0,
            StatusCode::NO_CONTENT
        );
        let replacement =
            client_crypto::encrypt(&other.seed, &client_crypto::content_aad(), b"replacement")
                .unwrap();
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
                client_crypto::encode_post(&other_meta, &replacement, b"\x90")
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
    })
    .await
    .expect("download ownership and admission checks must finish within 60 seconds");
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
    let body = client_crypto::encode_post(&meta, &content, b"\x90");
    assert_eq!(
        call(&app, &owner, "POST", "/api/media?after=invalid", body)
            .await
            .0,
        StatusCode::CREATED
    );
    let path = format!("/api/media/{id}/meta?after=invalid");
    assert_eq!(
        call(
            &app,
            &owner,
            "PUT",
            &path,
            client_crypto::encode_meta(&raw_hash(&meta), &meta, b"\x90")
        )
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
            client_crypto::encode_post(&meta, &content, &fixture_tag_labels(&token))
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
            client_crypto::encode_post(&meta, &content, &fixture_tag_labels(&token))
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
            &format!("/api/media/{id}/meta"),
            client_crypto::encode_meta(&raw_hash(&meta), &new_meta, &fixture_tag_labels(&token))
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
async fn stale_metadata_update_returns_current_item_without_writing() {
    let owner = new_identity();
    let (dir, app) = app(&[&owner]).await;
    let content =
        client_crypto::encrypt(&owner.seed, &client_crypto::content_aad(), b"clip").unwrap();
    let id = crypto::body_hash(&content);
    let original =
        client_crypto::encrypt(&owner.seed, &client_crypto::meta_aad(&id), b"original").unwrap();
    let initial_token = client_crypto::tag_token(&owner.seed, "initial").unwrap();
    let (status, response) = call(
        &app,
        &owner,
        "POST",
        "/api/media",
        client_crypto::encode_post(&original, &content, &fixture_tag_labels(&initial_token)),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let payload: serde_json::Value = client_crypto::document_json(&response);
    assert!(payload.get("tokens").is_none());

    let current =
        client_crypto::encrypt(&owner.seed, &client_crypto::meta_aad(&id), b"current").unwrap();
    let current_token = client_crypto::tag_token(&owner.seed, "current").unwrap();
    let (status, response) = call(
        &app,
        &owner,
        "PUT",
        &format!("/api/media/{id}/meta"),
        client_crypto::encode_meta(
            &raw_hash(&original),
            &current,
            &fixture_tag_labels(&current_token),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let payload: serde_json::Value = client_crypto::document_json(&response);
    assert!(payload.get("tokens").is_none());

    let stale =
        client_crypto::encrypt(&owner.seed, &client_crypto::meta_aad(&id), b"stale").unwrap();
    let stale_token = client_crypto::tag_token(&owner.seed, "stale").unwrap();
    let (status, response) = call(
        &app,
        &owner,
        "PUT",
        &format!("/api/media/{id}/meta"),
        client_crypto::encode_meta(
            &raw_hash(&original),
            &stale,
            &fixture_tag_labels(&stale_token),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    let payload: serde_json::Value = client_crypto::document_json(&response);
    assert_eq!(payload["code"], "metadata_conflict");
    assert_eq!(payload["media"]["meta"], serde_json::json!(current));
    assert!(payload["media"].get("tokens").is_none());
    for (token, count) in [(&current_token, 1), (&stale_token, 0)] {
        let (_, page) = call(
            &app,
            &owner,
            "GET",
            &format!("/api/media?tag={token}"),
            vec![],
        )
        .await;
        let page: serde_json::Value = client_crypto::document_json(&page);
        assert_eq!(page["media"].as_array().unwrap().len(), count);
    }

    let stored: Vec<u8> = sqlx::query_scalar("SELECT meta FROM files WHERE id=$1")
        .bind(&id)
        .fetch_one(&dir.1)
        .await
        .unwrap();
    assert_eq!(stored, current);

    assert_eq!(
        call(
            &app,
            &owner,
            "PUT",
            &format!("/api/media/{id}/meta"),
            client_crypto::encode_meta(
                &raw_hash(&current),
                &stale,
                &fixture_tag_labels(&stale_token)
            ),
        )
        .await
        .0,
        StatusCode::OK
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
async fn metadata_route_supports_only_updates() {
    let owner = new_identity();
    let (_dir, app) = app(&[&owner]).await;
    let id = "a".repeat(64);
    for (method, path) in [
        ("GET", format!("/api/media/{id}/meta")),
        ("PUT", format!("/api/media/{id}")),
    ] {
        assert_eq!(
            call(&app, &owner, method, &path, vec![]).await.0,
            StatusCode::METHOD_NOT_ALLOWED
        );
    }
}

#[tokio::test]
async fn quota_cli_invitation_and_http_upload_failures_work_together() {
    let key = new_identity();
    let (dir, app) = app(&[]).await;
    async fn cli(database_url: &str, args: &[&str]) -> std::process::Output {
        tokio::process::Command::new(env!("CARGO_BIN_EXE_i2nclip"))
            .env_remove("I2N_DATABASE_URL_FILE")
            .env("I2N_DATABASE_URL", database_url)
            .args(args)
            .output()
            .await
            .unwrap()
    }
    let issued = cli(
        &dir.0,
        &["otc", "issue", "--max-bytes", "42", "--max-files", "1"],
    )
    .await;
    assert!(
        issued.status.success(),
        "{}",
        String::from_utf8_lossy(&issued.stderr)
    );
    let code = String::from_utf8(issued.stdout).unwrap();
    enroll_key(&app, &key, code.trim()).await;
    let body = client_crypto::encode_post(
        &client_crypto::sealed_fixture(1, 42),
        &client_crypto::sealed_fixture(1, 42),
        b"\x90",
    );
    let (status, saved) = call(&app, &key, "POST", "/api/media", body.clone()).await;
    assert_eq!(status, StatusCode::CREATED);
    let saved: serde_json::Value = client_crypto::document_json(&saved);
    assert_eq!(saved["bytes"], 42);
    let second = client_crypto::encode_post(
        &client_crypto::sealed_fixture(1, 42),
        &client_crypto::sealed_fixture(1, 43),
        b"\x90",
    );
    let (status, error) = call(&app, &key, "POST", "/api/media", second.clone()).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(
        client_crypto::document_json(&error),
        serde_json::json!({ "error": "Library storage limit reached." })
    );
    // Updating an existing key is administrative and preserves its files.
    let changed = cli(
        &dir.0,
        &[
            "key",
            "set-limits",
            &key.registration_key(),
            "--max-bytes",
            "0",
            "--max-files",
            "0",
        ],
    )
    .await;
    assert!(
        !changed.status.success(),
        "{}",
        String::from_utf8_lossy(&changed.stderr)
    );
    assert!(String::from_utf8_lossy(&changed.stderr).contains("current usage"));
    let (status, _) = call(
        &app,
        &key,
        "GET",
        &format!("/api/media/{}", saved["id"].as_str().unwrap()),
        vec![],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, error) = call(&app, &key, "POST", "/api/media", body).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(
        client_crypto::document_json(&error),
        serde_json::json!({ "error": "already exists" })
    );
    assert_eq!(
        call(&app, &key, "POST", "/api/media", second.clone())
            .await
            .0,
        StatusCode::CONFLICT
    );
    let changed = cli(
        &dir.0,
        &[
            "key",
            "set-limits",
            &key.registration_key(),
            "--max-bytes",
            "85",
            "--max-files",
            "2",
        ],
    )
    .await;
    assert!(changed.status.success());
    assert_eq!(
        call(&app, &key, "POST", "/api/media", second).await.0,
        StatusCode::CREATED
    );
    let unknown = cli(
        &dir.0,
        &[
            "key",
            "set-limits",
            &new_identity().registration_key(),
            "--max-bytes",
            "0",
            "--max-files",
            "0",
        ],
    )
    .await;
    assert!(!unknown.status.success());
    assert!(String::from_utf8_lossy(&unknown.stderr).contains("not found"));
    let invalid = cli(
        &dir.0,
        &[
            "key",
            "set-limits",
            "invalid",
            "--max-bytes",
            "0",
            "--max-files",
            "0",
        ],
    )
    .await;
    assert!(!invalid.status.success());
    assert!(String::from_utf8_lossy(&invalid.stderr).contains("public_key"));
    let default_code = cli(&dir.0, &["otc", "issue"]).await;
    assert!(default_code.status.success());
    let defaults: (i64, i64) =
        sqlx::query_as("SELECT max_content_bytes, max_files FROM registration_codes")
            .fetch_one(&dir.1)
            .await
            .unwrap();
    assert_eq!(defaults, (536_870_912, 10_000));
}

#[tokio::test]
async fn signed_quota_reads_are_private_uncached_and_follow_media_mutations() {
    let owner = new_identity();
    let other = new_identity();
    let stranger = new_identity();
    let (dir, app) = app(&[&owner, &other]).await;
    i2nclip::set_key_limits(
        &dir.0,
        &other.registration_key(),
        i2nclip::StorageLimits {
            max_content_bytes: 123,
            max_files: 2,
        },
    )
    .await
    .unwrap();
    let (status, bytes) = call(&app, &owner, "GET", "/api/quota", vec![]).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        client_crypto::document_json(&bytes),
        serde_json::json!({
            "max_content_bytes": 536870912, "max_files": 10000, "used_content_bytes": 0, "file_count": 0,
        })
    );
    let content = client_crypto::sealed_fixture(1, 42);
    let body = client_crypto::encode_post(&client_crypto::sealed_fixture(1, 42), &content, b"\x90");
    assert_eq!(
        call(&app, &owner, "POST", "/api/media", body).await.0,
        StatusCode::CREATED
    );
    let (status, bytes) = call(&app, &other, "GET", "/api/quota?owner=ignored", vec![]).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        client_crypto::document_json(&bytes),
        serde_json::json!({
            "max_content_bytes": 123, "max_files": 2, "used_content_bytes": 0, "file_count": 0,
        })
    );
    assert_eq!(
        call(&app, &stranger, "GET", "/api/quota", vec![]).await.0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        call(&app, &owner, "GET", "/api/quota", vec![1]).await.0,
        StatusCode::PAYLOAD_TOO_LARGE
    );
    let authorization = client_crypto::authorization(
        &owner,
        "http://i2nclip.test",
        crypto::now_secs(),
        &client_crypto::fresh_nonce(),
        "GET",
        "/api/quota",
        b"",
    );
    for status in [StatusCode::OK, StatusCode::UNAUTHORIZED] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/quota")
                    .header("authorization", &authorization)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), status);
        assert_eq!(response.headers()["cache-control"], "no-store");
        if status == StatusCode::OK {
            let bytes = response.into_body().collect().await.unwrap().to_bytes();
            let quota: serde_json::Value = client_crypto::document_json(&bytes);
            assert_eq!(quota["used_content_bytes"], 42);
            assert_eq!(quota["file_count"], 1);
        }
    }
    assert_eq!(
        call(
            &app,
            &owner,
            "DELETE",
            &format!("/api/media/{}", crypto::body_hash(&content)),
            vec![]
        )
        .await
        .0,
        StatusCode::NO_CONTENT
    );
    let (_, bytes) = call(&app, &owner, "GET", "/api/quota", vec![]).await;
    let quota: serde_json::Value = client_crypto::document_json(&bytes);
    assert_eq!(quota["used_content_bytes"], 0);
    assert_eq!(quota["file_count"], 0);
}

#[tokio::test]
async fn per_key_upload_waiters_do_not_read_bodies_or_consume_other_keys_global_capacity() {
    use std::{
        sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        },
        time::Duration,
    };

    use axum::body::Bytes;
    use http_body_util::Channel;
    let owner = new_identity();
    let other = new_identity();
    let (_db, app) = app(&[&owner, &other]).await;
    let (mut sender, body) = Channel::<Bytes>::new(1);
    sender.send_data(Bytes::new()).await.unwrap();
    let entered = Arc::new(tokio::sync::Notify::new());
    let observed = entered.clone();
    let body = Body::new(body.map_frame(move |frame| {
        observed.notify_one();
        frame
    }));
    let header = client_crypto::authorization(
        &owner,
        "http://i2nclip.test",
        crypto::now_secs(),
        &client_crypto::fresh_nonce(),
        "POST",
        "/api/media",
        b"",
    );
    let router = app.clone();
    let first = tokio::spawn(async move {
        router
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/media")
                    .header("authorization", header)
                    .body(body)
                    .unwrap(),
            )
            .await
            .unwrap()
    });
    tokio::time::timeout(Duration::from_secs(5), entered.notified())
        .await
        .unwrap();
    let polled = Arc::new(AtomicUsize::new(0));
    let mut queued = Vec::new();
    for _ in 0..4 {
        let observed = polled.clone();
        let body = Body::new(Body::from("queued").map_frame(move |frame| {
            observed.fetch_add(1, Ordering::SeqCst);
            frame
        }));
        let header = client_crypto::authorization(
            &owner,
            "http://i2nclip.test",
            crypto::now_secs(),
            &client_crypto::fresh_nonce(),
            "POST",
            "/api/media",
            b"queued",
        );
        let mut request = Box::pin(
            app.clone().oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/media")
                    .header("authorization", header)
                    .body(body)
                    .unwrap(),
            ),
        );
        assert!(
            tokio::time::timeout(Duration::from_millis(50), &mut request)
                .await
                .is_err()
        );
        queued.push(request);
    }
    assert_eq!(polled.load(Ordering::SeqCst), 0);
    let response = tokio::time::timeout(
        Duration::from_secs(5),
        call(
            &app,
            &other,
            "POST",
            "/api/media",
            b"invalid frame".to_vec(),
        ),
    )
    .await
    .unwrap();
    assert_eq!(response.0, StatusCode::BAD_REQUEST);
    assert_eq!(
        call(&app, &owner, "GET", "/api/quota", vec![]).await.0,
        StatusCode::OK
    );
    assert_eq!(
        download_response(&app, &owner, &"0".repeat(64))
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
    drop(queued);
    first.abort();
    assert!(first.await.unwrap_err().is_cancelled());
    drop(sender);
    assert_eq!(
        tokio::time::timeout(
            Duration::from_secs(5),
            call(
                &app,
                &owner,
                "POST",
                "/api/media",
                b"invalid frame".to_vec()
            )
        )
        .await
        .unwrap()
        .0,
        StatusCode::BAD_REQUEST
    );
}

#[tokio::test]
async fn global_download_limit_still_applies_across_independent_keys() {
    use std::time::Duration;
    let owners: Vec<_> = (0..9).map(|_| new_identity()).collect();
    let (_db, app) = app(&owners.iter().collect::<Vec<_>>()).await;
    let mut held = Vec::new();
    let mut ids = Vec::new();
    for (n, owner) in owners.iter().enumerate() {
        let content = client_crypto::sealed_fixture(n as u8, 42);
        let id = crypto::body_hash(&content);
        assert_eq!(
            call(
                &app,
                owner,
                "POST",
                "/api/media",
                client_crypto::encode_post(
                    &client_crypto::sealed_fixture(1, 42),
                    &content,
                    b"\x90"
                )
            )
            .await
            .0,
            StatusCode::CREATED
        );
        if n < 8 {
            for _ in 0..2 {
                let response = download_response(&app, owner, &id).await;
                assert_eq!(response.status(), StatusCode::OK);
                held.push(response);
            }
        }
        ids.push(id);
    }
    let mut queued = Box::pin(download_response(&app, &owners[8], &ids[8]));
    assert!(
        tokio::time::timeout(Duration::from_millis(100), &mut queued)
            .await
            .is_err()
    );
    assert_eq!(
        call(&app, &owners[8], "GET", "/api/quota", vec![]).await.0,
        StatusCode::OK
    );
    drop(held.pop());
    let admitted = tokio::time::timeout(Duration::from_secs(5), queued)
        .await
        .unwrap();
    assert_eq!(admitted.status(), StatusCode::OK);
    drop(admitted);
    drop(held);
}
