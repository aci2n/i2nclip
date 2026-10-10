//! Calls the router in-process. No port is opened. This is the same idea as
//! Spring's MockMvc or Python's httpx ASGI transport.

use std::path::PathBuf;
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
use i2nclip::crypto::Identity;
use i2nclip::frame;
use tower::ServiceExt;

static N: AtomicU64 = AtomicU64::new(0);

struct TempDir(PathBuf);

impl TempDir {
    fn new() -> Self {
        let n = N.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!("i2nclip-api-{n}-{}", std::process::id()));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn new_identity() -> Identity {
    let mut seed = [0u8; 32];
    getrandom::getrandom(&mut seed).unwrap();
    crypto::from_seed(seed)
}

fn app(keys: &[&Identity]) -> (TempDir, axum::Router) {
    let dir = TempDir::new();
    let router = i2nclip::router(&dir.0, "http://i2nclip.test").unwrap();
    if !keys.is_empty() {
        let conn = rusqlite::Connection::open(dir.0.join("i2nclip.db")).unwrap();
        for key in keys {
            conn.execute(
                "INSERT OR IGNORE INTO registered_keys (public_key) VALUES (?1)",
                rusqlite::params![key.public.as_slice()],
            )
            .unwrap();
        }
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
    let nonce = crypto::fresh_nonce();
    let header = crypto::authorization(key, "http://i2nclip.test", ts, &nonce, method, path, &body);
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
    let (dir, initial) = app(&[&key]);
    drop(initial);
    let vectors: serde_json::Value =
        serde_json::from_str(include_str!("../client/tests/origin-vectors.json")).unwrap();
    for case in vectors["accepted"].as_array().unwrap() {
        let input = case["input"].as_str().unwrap();
        let origin = case["origin"].as_str().unwrap();
        let app = i2nclip::router(&dir.0, input).unwrap();
        let authorization = crypto::authorization(
            &key,
            origin,
            crypto::now_secs(),
            &crypto::fresh_nonce(),
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
    use axum::body::Bytes;
    use http_body_util::Channel;
    use std::sync::Arc;
    use std::time::Duration;

    let owner = new_identity();
    let (dir, app) = app(&[&owner]);
    let new_key = new_identity();
    let otc = i2nclip::issue_registration_otc(&dir.0, 3600).unwrap();
    let id = "66666666-6666-4666-8666-666666666666";
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
        let authorization = crypto::authorization(
            &owner,
            "http://i2nclip.test",
            crypto::now_secs(),
            &crypto::fresh_nonce(),
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
    let conn = rusqlite::Connection::open(dir.0.join("i2nclip.db")).unwrap();
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM files", [], |row| row.get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[tokio::test]
async fn body_caps_accept_complete_frames_at_the_protocol_boundaries() {
    let owner = new_identity();
    let (dir, app) = app(&[&owner]);
    let id = "77777777-7777-4777-8777-777777777777";
    // The server checks ciphertext framing, not the authentication tag.
    let mut meta = vec![0u8; 65_536];
    meta[0] = 1;
    let mut content = vec![0u8; 33_554_496];
    content[0] = 1;
    let tags = "\n".repeat(4096);
    let body = frame::encode_post(id, &meta, &content, &tags);
    assert_eq!(body.len(), 33_624_180);
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
    let otc = i2nclip::issue_registration_otc(&dir.0, 3600).unwrap();
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
    let (_dir, app) = app(&[&owner]);
    let id = "88888888-8888-4888-8888-888888888888";
    for (method, path, cap) in [
        ("POST", "/api/media".to_string(), 33_624_180),
        ("PUT", format!("/api/media/{id}"), 69_640),
        ("GET", "/api/media".to_string(), 0),
        ("DELETE", format!("/api/media/{id}"), 0),
    ] {
        let authorization = crypto::authorization(
            &owner,
            "http://i2nclip.test",
            crypto::now_secs(),
            &crypto::fresh_nonce(),
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
    let (_dir, app) = app(&[&owner]);
    let id = "99999999-9999-4999-8999-999999999999";
    for (method, path, cap) in [
        ("POST", "/api/media".to_string(), 33_624_180),
        ("PUT", format!("/api/media/{id}"), 69_640),
        ("GET", "/api/media".to_string(), 0),
        ("DELETE", format!("/api/media/{id}"), 0),
        ("POST", "/api/register-key".to_string(), 4096),
    ] {
        for declared in [None, Some(0)] {
            let bytes = Bytes::from(vec![0u8; cap + 1]);
            let authorization = crypto::authorization(
                &owner,
                "http://i2nclip.test",
                crypto::now_secs(),
                &crypto::fresh_nonce(),
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
    let (_dir, app) = app(&[]);
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
    let (dir, app) = app(&[&key]);
    let id = "11111111-1111-4111-8111-111111111111";
    let marker = b"PLAINTEXT-MARKER-i2nclip-upload";
    let filename = "vacation-photo.jpg";
    let tag = "secret-tag-zebra";
    let meta_json =
        format!(r#"{{"name":"{filename}","content_type":"image/jpeg","size":1,"tags":["{tag}"]}}"#);
    let meta = crypto::encrypt(&key.seed, &crypto::meta_aad(id), meta_json.as_bytes()).unwrap();
    let content = crypto::encrypt(&key.seed, &crypto::content_aad(id), marker).unwrap();
    let token = crypto::tag_token(&key.seed, tag).unwrap();
    let body = frame::encode_post(id, &meta, &content, &token);

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
        crypto::decrypt(&key.seed, &crypto::content_aad(id), &stored).unwrap(),
        marker
    );

    let needles: [&[u8]; 3] = [marker, filename.as_bytes(), tag.as_bytes()];
    for entry in walk(&dir.0) {
        let data = std::fs::read(&entry).unwrap();
        for needle in needles {
            assert!(
                !data.windows(needle.len()).any(|window| window == needle),
                "{} contains plaintext",
                entry.display()
            );
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
    let (_dir, app) = app(&[&owner, &other]);
    let id = "22222222-2222-4222-8222-222222222222";
    let meta = crypto::encrypt(&owner.seed, &crypto::meta_aad(id), b"{}").unwrap();
    let content = crypto::encrypt(&owner.seed, &crypto::content_aad(id), b"pic").unwrap();
    let token = crypto::tag_token(&owner.seed, "shared-word").unwrap();
    let other_token = crypto::tag_token(&other.seed, "shared-word").unwrap();
    assert_ne!(token, other_token);
    let body = frame::encode_post(id, &meta, &content, &token);
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
    let (_dir, app) = app(&[&key]);
    let (status, _) = call(&app, &key, "GET", "/api/media", Vec::new()).await;
    assert_eq!(status, StatusCode::OK);
    // The first call already stored its nonce. Sign a fresh one and send it twice.
    let ts = crypto::now_secs();
    let nonce = crypto::fresh_nonce();
    let header = crypto::authorization(
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

    let id = "33333333-3333-4333-8333-333333333333";
    let meta = crypto::encrypt(&key.seed, &crypto::meta_aad(id), b"{}").unwrap();
    let body = frame::encode_post(id, &meta, b"\xff\xd8\xff\xd8not-encrypted", "not-a-token");
    let (status, _) = call(&app, &key, "POST", "/api/media", body).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn rejects_wrong_origin_and_a_body_other_than_the_signed_one() {
    let key = new_identity();
    let (_dir, app) = app(&[&key]);
    let ts = crypto::now_secs();
    let body = b"signed-body".to_vec();

    let other_origin = crypto::authorization(
        &key,
        "https://other.example",
        ts,
        &crypto::fresh_nonce(),
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

    let swapped = crypto::authorization(
        &key,
        "http://i2nclip.test",
        ts,
        &crypto::fresh_nonce(),
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
    let dir = TempDir::new();
    let app = i2nclip::router(&dir.0, "http://i2nclip.test").unwrap();
    let (status, _) = register(&app, &key, "not-a-real-code").await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    let otc = i2nclip::issue_registration_otc(&dir.0, 3600).unwrap();
    let conn = rusqlite::Connection::open(dir.0.join("i2nclip.db")).unwrap();
    conn.execute("UPDATE registration_codes SET expires_at = 0", [])
        .unwrap();
    let (status, _) = register(&app, &key, &otc).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn register_otc_is_single_use_and_idempotent_for_key() {
    let key = new_identity();
    let dir = TempDir::new();
    let app = i2nclip::router(&dir.0, "http://i2nclip.test").unwrap();
    let otc = i2nclip::issue_registration_otc(&dir.0, 3600).unwrap();
    enroll_key(&app, &key, &otc).await;
    let (status, _) = register(&app, &key, &otc).await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    let otc2 = i2nclip::issue_registration_otc(&dir.0, 3600).unwrap();
    let (status, _) = register(&app, &key, &otc2).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
}

#[tokio::test]
async fn rejected_public_keys_do_not_consume_registration_code() {
    let (dir, app) = app(&[]);
    let otc = i2nclip::issue_registration_otc(&dir.0, 3600).unwrap();
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
    let conn = rusqlite::Connection::open(dir.0.join("i2nclip.db")).unwrap();
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM registered_keys", [], |row| row
            .get::<_, i64>(0))
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
    let (dir, app) = app(&[&weak]);
    let mut signature = [0u8; 64];
    signature[0] = 1;
    let nonce = crypto::fresh_nonce();
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
    let conn = rusqlite::Connection::open(dir.0.join("i2nclip.db")).unwrap();
    assert_eq!(
        conn.query_row(
            "SELECT COUNT(*) FROM nonces WHERE nonce = ?1",
            [&nonce],
            |row| row.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    assert_eq!(
        conn.query_row(
            "SELECT COUNT(*) FROM registered_keys WHERE public_key = ?1",
            [public.as_slice()],
            |row| row.get::<_, i64>(0)
        )
        .unwrap(),
        1
    );
}

fn walk(dir: &std::path::Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(dir).unwrap() {
        let entry = entry.unwrap();
        let path = entry.path();
        if path.is_dir() {
            out.extend(walk(&path));
        } else {
            out.push(path);
        }
    }
    out
}

#[tokio::test]
async fn duplicate_uploads_conflict_without_replacing_content() {
    let owner = new_identity();
    let other = new_identity();
    let (dir, app) = app(&[&owner, &other]);
    let id = "44444444-4444-4444-8444-444444444444";
    let meta = crypto::encrypt(&owner.seed, &crypto::meta_aad(id), b"{}").unwrap();
    let content = crypto::encrypt(&owner.seed, &crypto::content_aad(id), b"original").unwrap();
    let body = frame::encode_post(id, &meta, &content, "");
    let first = call(&app, &owner, "POST", "/api/media", body.clone()).await;
    let retry = call(&app, &owner, "POST", "/api/media", body.clone()).await;
    assert_eq!(first.0, StatusCode::CREATED);
    assert_eq!(retry.0, StatusCode::CONFLICT);
    assert_eq!(
        call(&app, &other, "POST", "/api/media", body).await.0,
        StatusCode::CONFLICT
    );
    let changed = crypto::encrypt(&owner.seed, &crypto::content_aad(id), b"changed").unwrap();
    assert_eq!(
        call(
            &app,
            &owner,
            "POST",
            "/api/media",
            frame::encode_post(id, &meta, &changed, "")
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    let (_, listed) = call(&app, &owner, "GET", "/api/media", vec![]).await;
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&listed).unwrap()["media"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let (status, downloaded) = call(&app, &owner, "GET", &format!("/api/media/{id}"), vec![]).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(downloaded, content);
    // A missing blob must not allow an existing database row to be replaced.
    std::fs::remove_file(dir.0.join("blobs").join(id)).unwrap();
    assert_eq!(
        call(
            &app,
            &owner,
            "POST",
            "/api/media",
            frame::encode_post(id, &meta, &content, "")
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    assert!(!dir.0.join("blobs").join(id).exists());
}

#[tokio::test]
async fn startup_removes_legacy_receipts_and_preserves_media() {
    let owner = new_identity();
    let (dir, app) = app(&[&owner]);
    let id = "55555555-5555-4555-8555-555555555555";
    let meta = crypto::encrypt(&owner.seed, &crypto::meta_aad(id), b"{}").unwrap();
    let content = crypto::encrypt(&owner.seed, &crypto::content_aad(id), b"original").unwrap();
    let token = crypto::tag_token(&owner.seed, "keep").unwrap();
    let body = frame::encode_post(id, &meta, &content, &token);
    assert_eq!(
        call(&app, &owner, "POST", "/api/media", body).await.0,
        StatusCode::CREATED
    );
    drop(app);

    let conn = rusqlite::Connection::open(dir.0.join("i2nclip.db")).unwrap();
    let receipt_count = || {
        conn.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE name = 'upload_receipts'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .unwrap()
    };
    assert_eq!(receipt_count(), 0);
    conn.execute_batch(
        "CREATE TABLE upload_receipts (
            file_id TEXT PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
            body_hash TEXT NOT NULL
        );",
    )
    .unwrap();
    conn.execute(
        "INSERT INTO upload_receipts VALUES (?1, ?2)",
        rusqlite::params![id, "legacy-hash"],
    )
    .unwrap();

    let app = i2nclip::router(&dir.0, "http://i2nclip.test").unwrap();
    assert_eq!(receipt_count(), 0);
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
    let _reopened = i2nclip::router(&dir.0, "http://i2nclip.test").unwrap();
    assert_eq!(receipt_count(), 0);
}
