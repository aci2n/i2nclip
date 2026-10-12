//! Real web/API listener for isolated browser tests, using I2N_DATABASE_URL.

use tokio::net::TcpListener;

#[tokio::main]
async fn main() {
    let database_url = i2nclip::database_url_from_env().expect("database URL");
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let origin = format!("http://{}", listener.local_addr().expect("local addr"));
    let app = i2nclip::router(&database_url, &origin)
        .await
        .expect("router");
    println!("ready {origin}");
    let _ = std::io::Write::flush(&mut std::io::stdout());
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .await
    .expect("serve");
}
