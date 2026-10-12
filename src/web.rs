//! Static web files share the API listener, without an HTML fallback for unknown paths.

use std::path::PathBuf;

use axum::http::{header, HeaderValue};
use axum::middleware::map_response;
use axum::response::Response;
use axum::Router;
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
        .layer(map_response(html_cache));
    // Stable worker URLs let all tabs join one owner and revalidate across builds.
    let workers = Router::new()
        .route_service(
            "/assets/web-worker.js",
            ServeFile::new(directory.join("assets/web-worker.js")),
        )
        .route_service(
            "/assets/worker.js",
            ServeFile::new(directory.join("assets/worker.js")),
        )
        .layer(map_response(html_cache));
    let assets = Router::new()
        .nest_service(
            "/assets",
            ServeDir::new(directory.join("assets")).append_index_html_on_directories(false),
        )
        .layer(map_response(asset_cache));
    api.merge(html).merge(workers).merge(assets)
}

async fn html_cache(response: Response) -> Response {
    cache(response, "no-cache")
}

async fn asset_cache(response: Response) -> Response {
    cache(response, "public, max-age=31536000, immutable")
}

fn cache(mut response: Response, value: &'static str) -> Response {
    if response.status().is_success() || response.status() == axum::http::StatusCode::NOT_MODIFIED {
        response
            .headers_mut()
            .insert(header::CACHE_CONTROL, HeaderValue::from_static(value));
    }
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::{to_bytes, Body};
    use axum::http::{Method, Request, StatusCode};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tower::ServiceExt;

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
            std::fs::write(directory.join("assets/web-worker.js"), "export {};").unwrap();
            std::fs::write(directory.join("assets/worker.js"), "export {};").unwrap();
            std::fs::write(directory.join("private.txt"), "not public").unwrap();
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
        for path in ["/assets/web-worker.js", "/assets/worker.js"] {
            let response = request(app.clone(), Method::GET, path).await;
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(response.headers()[header::CACHE_CONTROL], "no-cache");
            assert!(response.headers()[header::CONTENT_TYPE]
                .to_str()
                .unwrap()
                .starts_with("text/javascript"));
        }
        for path in [
            "/",
            "/index.html",
            "/favicon.ico",
            "/assets/web-worker.js",
            "/assets/worker.js",
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
            request(app.clone(), Method::GET, "/api/media")
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
