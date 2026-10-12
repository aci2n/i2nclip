//! Real web/API listener for isolated browser tests, using I2N_DATABASE_URL.

use tokio::net::TcpListener;

#[tokio::main]
async fn main() {
    let mut args = std::env::args().skip(1);
    let database_url = i2nclip::database_url_from_env().expect("database URL");
    let origin = args.next().expect("origin");
    let listen = args.next().expect("listen address");
    let app = i2nclip::router(&database_url, &origin)
        .await
        .expect("router");
    let listener = TcpListener::bind(&listen).await.expect("bind");
    let addr = listener.local_addr().expect("local addr");
    println!("ready {addr}");
    let _ = std::io::Write::flush(&mut std::io::stdout());
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .await
    .expect("serve");
}
