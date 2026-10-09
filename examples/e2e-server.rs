//! Listener for the browser tests. The installed service still uses
//! `/var/lib/i2nclip` and `0.0.0.0:8080`. This binary exists so a test can
//! pick a data directory and a port without changing that.
//!
//! A page served from another port is a different origin, so the browser asks
//! permission before `fetch`. The real add-on does not need that: Firefox
//! treats `moz-extension://` as allowed to call the server. The headers below
//! are only for these tests.

use std::path::PathBuf;

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
    let data = PathBuf::from(args.next().expect("data dir"));
    let origin = args.next().expect("origin");
    let listen = args.next().expect("listen address");
    let app = i2nclip::router(&data, &origin)
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
