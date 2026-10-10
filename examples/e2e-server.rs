//! Real API listener with test-only CORS, using I2N_DATABASE_URL.

use axum::body::Body;
use axum::extract::Request;
use axum::http::HeaderValue;
use axum::http::Method;
use axum::middleware::Next;
use axum::response::Response;
use tokio::net::TcpListener;

#[tokio::main]
async fn main() {
    let mut args = std::env::args().skip(1);
    let database_url = i2nclip::database_url_from_env().expect("database URL");
    let origin = args.next().expect("origin");
    let listen = args.next().expect("listen address");
    let app = i2nclip::router(&database_url, &origin)
        .await
        .expect("router")
        .layer(axum::middleware::from_fn(allow_browser));
    let listener = TcpListener::bind(&listen).await.expect("bind");
    let addr = listener.local_addr().expect("local addr");
    println!("ready {addr}");
    let _ = std::io::Write::flush(&mut std::io::stdout());
    axum::serve(listener, app).await.expect("serve");
}

async fn allow_browser(request: Request, next: Next) -> Response {
    if request.method() == Method::OPTIONS {
        return Response::builder()
            .status(204)
            .header("access-control-allow-origin", "*")
            .header(
                "access-control-allow-methods",
                "GET, POST, PUT, DELETE, OPTIONS",
            )
            .header(
                "access-control-allow-headers",
                "authorization, content-type",
            )
            .header("access-control-max-age", "600")
            .body(Body::empty())
            .expect("options response");
    }
    let mut response = next.run(request).await;
    response.headers_mut().insert(
        axum::http::header::ACCESS_CONTROL_ALLOW_ORIGIN,
        HeaderValue::from_static("*"),
    );
    response
}
