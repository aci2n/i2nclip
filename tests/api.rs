//! Calls the router in-process. No port is opened. This is the same idea as
//! Spring's MockMvc or Python's httpx ASGI transport.

use std::path::PathBuf;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;

use axum::body::Body;
use axum::http::Request;
use axum::http::StatusCode;
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
async fn upload_retries_require_the_same_owner_and_payload() {
    let owner = new_identity();
    let other = new_identity();
    let (_dir, app) = app(&[&owner, &other]);
    let id = "44444444-4444-4444-8444-444444444444";
    let meta = crypto::encrypt(&owner.seed, &crypto::meta_aad(id), b"{}").unwrap();
    let content = crypto::encrypt(&owner.seed, &crypto::content_aad(id), b"original").unwrap();
    let body = frame::encode_post(id, &meta, &content, "");
    let first = call(&app, &owner, "POST", "/api/media", body.clone()).await;
    let retry = call(&app, &owner, "POST", "/api/media", body.clone()).await;
    assert_eq!(first.0, StatusCode::CREATED);
    assert_eq!(first, retry);
    assert_eq!(call(&app, &other, "POST", "/api/media", body).await.0, StatusCode::CONFLICT);
    let changed = crypto::encrypt(&owner.seed, &crypto::content_aad(id), b"changed").unwrap();
    assert_eq!(call(&app, &owner, "POST", "/api/media", frame::encode_post(id, &meta, &changed, "")).await.0, StatusCode::CONFLICT);
    let (_, listed) = call(&app, &owner, "GET", "/api/media", vec![]).await;
    assert_eq!(serde_json::from_slice::<serde_json::Value>(&listed).unwrap()["media"].as_array().unwrap().len(), 1);
}
