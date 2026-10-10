//! PostgreSQL fixture helper used by Firefox and local test tooling.

use sqlx::PgPool;

#[tokio::main]
async fn main() {
    let mut args = std::env::args().skip(1);
    let operation = args.next().expect("create, drop, or expire");
    let base = std::env::var("I2N_TEST_DATABASE_URL")
        .expect("set I2N_TEST_DATABASE_URL; real PostgreSQL is required");
    let pool = PgPool::connect(&base)
        .await
        .expect("test PostgreSQL unavailable");
    match operation.as_str() {
        "create" => {
            let name = format!(
                "i2nclip_e2e_{}_{}",
                std::process::id(),
                i2nclip::crypto::now_secs()
            );
            sqlx::query(&format!("CREATE DATABASE {name}"))
                .execute(&pool)
                .await
                .unwrap();
            let mut url = url::Url::parse(&base).unwrap();
            url.set_path(&name);
            println!("{url}");
        }
        "drop" => {
            let target =
                url::Url::parse(&std::env::var("I2N_DATABASE_URL").expect("fixture URL")).unwrap();
            let name = target.path().trim_start_matches('/');
            assert!(
                name.starts_with("i2nclip_e2e_")
                    && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
            );
            sqlx::query(&format!("DROP DATABASE {name} WITH (FORCE)"))
                .execute(&pool)
                .await
                .unwrap();
        }
        "expire" => {
            let target = PgPool::connect(&std::env::var("I2N_DATABASE_URL").expect("fixture URL"))
                .await
                .unwrap();
            sqlx::query("UPDATE registration_codes SET expires_at = 0")
                .execute(&target)
                .await
                .unwrap();
            target.close().await;
        }
        _ => panic!("unknown operation"),
    }
    pool.close().await;
}
