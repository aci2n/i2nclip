//! Static web files share the API listener, without an HTML fallback for unknown paths.

use std::path::PathBuf;

use axum::{
    http::{header, HeaderValue, StatusCode},
    middleware::map_response,
    response::Response,
    Router,
};
use tower_http::services::{ServeDir, ServeFile};

pub(crate) fn directory() -> PathBuf {
    std::env::var_os("I2N_WEB_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("client/dist/web"))
}

pub(crate) fn serve(api: Router, directory: PathBuf) -> Router {
    let html = Router::new()
        .route_service("/", ServeFile::new(directory.join("index.html")))
        .route_service("/index.html", ServeFile::new(directory.join("index.html")))
        .route_service(
            "/favicon.ico",
            ServeFile::new(directory.join("favicon.ico")),
        )
        .layer(map_response(html_response));
    let worker = Router::new()
        .route_service(
            "/streaming-worker.js",
            ServeFile::new(directory.join("streaming-worker.js")),
        )
        .layer(map_response(|response: Response| async {
            nosniff(cache(response, "no-cache"))
        }));
    let assets = Router::new()
        .nest_service(
            "/assets",
            ServeDir::new(directory.join("assets")).append_index_html_on_directories(false),
        )
        .layer(map_response(asset_cache));
    api.merge(html).merge(worker).merge(assets)
}

/// Any same-origin script holds full library authority; see doc/content-security-policy.md.
/// `wasm-unsafe-eval` admits only WebAssembly compilation, which the pairing PAKE requires.
const CONTENT_SECURITY_POLICY: &str = "default-src 'none'; \
script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; \
img-src 'self' blob:; media-src 'self' blob:; worker-src 'self'; \
connect-src 'self' https: http://localhost:* http://127.0.0.1:* http://[::1]:*; \
manifest-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none'; \
frame-ancestors 'none'";

async fn html_response(response: Response) -> Response {
    let mut response = nosniff(cache(response, "no-cache"));
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(CONTENT_SECURITY_POLICY),
    );
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    response
}

async fn asset_cache(response: Response) -> Response {
    nosniff(cache(response, "public, max-age=31536000, immutable"))
}

fn nosniff(mut response: Response) -> Response {
    response.headers_mut().insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    response
}

fn cache(mut response: Response, value: &'static str) -> Response {
    if response.status().is_success() || response.status() == StatusCode::NOT_MODIFIED {
        response
            .headers_mut()
            .insert(header::CACHE_CONTROL, HeaderValue::from_static(value));
    }
    response
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use axum::{
        body::{to_bytes, Body},
        http::{Method, Request, StatusCode},
    };
    use tower::ServiceExt;

    use super::*;

    struct Files(PathBuf);

    impl Files {
        fn new() -> Self {
            static NEXT: AtomicUsize = AtomicUsize::new(0);
            let directory = std::env::temp_dir().join(format!(
                "i2nclip-web-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir(&directory).unwrap();
            std::fs::create_dir(directory.join("assets")).unwrap();
            std::fs::write(directory.join("index.html"), "<html>web</html>").unwrap();
            std::fs::write(directory.join("favicon.ico"), b"\x00\x00\x01\x00").unwrap();
            std::fs::write(directory.join("assets/app-ab123456.js"), "export {};").unwrap();
            std::fs::write(directory.join("assets/app-ab123456.css"), "body {}").unwrap();
            std::fs::write(directory.join("private.txt"), "not public").unwrap();
            std::fs::write(
                directory.join("streaming-worker.js"),
                "self.addEventListener(\"fetch\", () => {});",
            )
            .unwrap();
            std::fs::write(
                directory.join("streaming-worker.js.map"),
                r#"{"version":3,"sources":["worker.ts"],"names":[],"mappings":""}"#,
            )
            .unwrap();
            Self(directory)
        }

        async fn app(&self) -> Router {
            let db = crate::db::Database::closed_for_test().await;
            serve(
                crate::routes::router(crate::AppState::new(db, "http://i2nclip.test".into())),
                self.0.clone(),
            )
        }
    }

    impl Drop for Files {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.0).unwrap();
        }
    }

    async fn request(app: Router, method: Method, path: &str) -> Response {
        app.oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn entry_routes_forbid_framing_including_head_revalidation_and_errors() {
        let files = Files::new();
        let app = files.app().await;
        for path in ["/", "/index.html", "/?page=options", "/index.html?test=1"] {
            for method in [Method::GET, Method::HEAD] {
                let response = request(app.clone(), method, path).await;
                assert_eq!(response.status(), StatusCode::OK);
                assert_entry_headers(&response);
            }
            let response = request(app.clone(), Method::GET, path).await;
            let modified = response.headers()[header::LAST_MODIFIED].clone();
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .uri(path)
                        .header(header::IF_MODIFIED_SINCE, modified)
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::NOT_MODIFIED);
            assert_entry_headers(&response);
            assert_eq!(response.headers()[header::CACHE_CONTROL], "no-cache");
        }
        for (path, nosniff) in [
            ("/assets/app-ab123456.js", true),
            ("/streaming-worker.js", true),
            ("/api/health", false),
        ] {
            let response = request(app.clone(), Method::GET, path).await;
            assert_eq!(response.status(), StatusCode::OK);
            let headers = response.headers();
            assert!(!headers.contains_key(header::CONTENT_SECURITY_POLICY));
            assert!(!headers.contains_key(header::REFERRER_POLICY));
            assert_eq!(
                headers.contains_key(header::X_CONTENT_TYPE_OPTIONS),
                nosniff,
                "{path}"
            );
        }
        std::fs::remove_file(files.0.join("index.html")).unwrap();
        let response = request(app, Method::GET, "/").await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert_entry_headers(&response);
    }

    fn assert_entry_headers(response: &Response) {
        let headers = response.headers();
        let policy = headers[header::CONTENT_SECURITY_POLICY].to_str().unwrap();
        let directives: Vec<&str> = policy.split("; ").collect();
        for directive in [
            "default-src 'none'",
            "script-src 'self' 'wasm-unsafe-eval'",
            "style-src 'self'",
            "object-src 'none'",
            "base-uri 'none'",
            "frame-ancestors 'none'",
        ] {
            assert!(directives.contains(&directive), "{directive} in {policy}");
        }
        assert!(!policy.contains("'unsafe-"));
        assert_eq!(headers[header::REFERRER_POLICY], "no-referrer");
        assert_eq!(headers[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
    }

    #[tokio::test]
    async fn html_and_assets_have_correct_types_cache_and_head_responses() {
        let files = Files::new();
        let app = files.app().await;
        for path in ["/", "/index.html", "/?page=options"] {
            let response = request(app.clone(), Method::GET, path).await;
            assert_eq!(response.status(), StatusCode::OK);
            assert!(response.headers()[header::CONTENT_TYPE]
                .to_str()
                .unwrap()
                .starts_with("text/html"));
            assert_eq!(response.headers()[header::CACHE_CONTROL], "no-cache");
            assert_eq!(
                to_bytes(response.into_body(), 1024).await.unwrap(),
                "<html>web</html>"
            );
        }
        for (path, mime) in [
            ("/assets/app-ab123456.js", "text/javascript"),
            ("/assets/app-ab123456.css", "text/css"),
        ] {
            let response = request(app.clone(), Method::GET, path).await;
            assert_eq!(response.status(), StatusCode::OK);
            assert!(response.headers()[header::CONTENT_TYPE]
                .to_str()
                .unwrap()
                .starts_with(mime));
            assert_eq!(
                response.headers()[header::CACHE_CONTROL],
                "public, max-age=31536000, immutable"
            );
            assert!(!to_bytes(response.into_body(), 1024)
                .await
                .unwrap()
                .is_empty());
        }
        let favicon = request(app.clone(), Method::GET, "/favicon.ico").await;
        assert_eq!(favicon.status(), StatusCode::OK);
        assert_eq!(favicon.headers()[header::CACHE_CONTROL], "no-cache");
        assert!(favicon.headers()[header::CONTENT_TYPE]
            .to_str()
            .unwrap()
            .contains("icon"));
        assert_eq!(
            to_bytes(favicon.into_body(), 1024).await.unwrap(),
            &b"\x00\x00\x01\x00"[..]
        );

        for path in [
            "/",
            "/index.html",
            "/favicon.ico",
            "/assets/app-ab123456.js",
        ] {
            let response = request(app.clone(), Method::HEAD, path).await;
            assert_eq!(response.status(), StatusCode::OK);
            assert!(response.headers().contains_key(header::CONTENT_LENGTH));
            assert!(to_bytes(response.into_body(), 1024)
                .await
                .unwrap()
                .is_empty());
        }
    }

    #[tokio::test]
    async fn streaming_worker_is_javascript_and_revalidated_without_plaintext_routes() {
        let files = Files::new();
        for method in [Method::GET, Method::HEAD] {
            let response = request(files.app().await, method, "/streaming-worker.js").await;
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(response.headers()[header::CACHE_CONTROL], "no-cache");
            assert!(response.headers()[header::CONTENT_TYPE]
                .to_str()
                .unwrap()
                .contains("javascript"));
        }
        let response = request(
            files.app().await,
            Method::GET,
            "/__content/client/token/inline",
        )
        .await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn worker_source_map_is_not_exposed() {
        let files = Files::new();
        let app = files.app().await;
        for method in [Method::GET, Method::HEAD] {
            let response = request(app.clone(), method, "/streaming-worker.js.map").await;
            assert_eq!(response.status(), StatusCode::NOT_FOUND);
            assert!(!response.headers().contains_key(header::CACHE_CONTROL));
        }
    }

    #[tokio::test]
    async fn static_routes_do_not_expose_other_files_or_change_api_behavior() {
        let files = Files::new();
        let app = files.app().await;
        for path in [
            "/unknown",
            "/private.txt",
            "/assets/missing.js",
            "/assets/../private.txt",
            "/assets/%2e%2e/private.txt",
            "/api/unknown",
        ] {
            let response = request(app.clone(), Method::GET, path).await;
            assert_eq!(response.status(), StatusCode::NOT_FOUND, "{path}");
            assert!(!response.headers().contains_key(header::CACHE_CONTROL));
        }
        for path in ["/", "/assets/app-ab123456.js"] {
            assert_eq!(
                request(app.clone(), Method::POST, path).await.status(),
                StatusCode::METHOD_NOT_ALLOWED
            );
        }
        let health = request(app.clone(), Method::GET, "/api/health").await;
        assert_eq!(health.status(), StatusCode::OK);
        assert_eq!(health.headers()[header::CACHE_CONTROL], "no-store");
        assert_eq!(
            request(app.clone(), Method::GET, "/api/blocks")
                .await
                .status(),
            StatusCode::UNAUTHORIZED
        );
        let db = crate::db::Database::closed_for_test().await;
        let absent = serve(
            crate::routes::router(crate::AppState::new(db, "http://i2nclip.test".into())),
            files.0.join("missing"),
        );
        assert_eq!(
            request(absent.clone(), Method::GET, "/").await.status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            request(absent, Method::GET, "/api/health").await.status(),
            StatusCode::OK
        );
    }
}
