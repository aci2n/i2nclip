//! Own PostgreSQL for the lifetime of an explicitly requested test command.

use std::time::Duration;

use testcontainers::{
    core::{IntoContainerPort, WaitFor},
    runners::AsyncRunner,
    GenericImage, ImageExt,
};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("database tests: {error}");
        std::process::exit(1);
    }
}

async fn run() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let executable = args.next().ok_or("provide a test command")?;
    let (database_url, container) = if let Ok(url) = std::env::var("I2N_TEST_DATABASE_URL") {
        (url, None)
    } else {
        let mut secret = [0; 32];
        getrandom::getrandom(&mut secret)
            .map_err(|error| std::io::Error::other(error.to_string()))?;
        let password = i2nclip::crypto::body_hash(&secret);
        let host_network = match std::env::var("I2N_TEST_CONTAINER_NETWORK") {
            Ok(network) if network == "host" => true,
            Ok(_) => return Err(
                "I2N_TEST_CONTAINER_NETWORK supports only host; unset it for the default network"
                    .into(),
            ),
            Err(std::env::VarError::NotPresent) => false,
            Err(error) => return Err(error.into()),
        };
        let host_port = if host_network {
            // Host networking is an opt-in fallback for Podman without /dev/net/tun.
            // Bind PostgreSQL only to loopback and select an unused local port.
            Some(
                std::net::TcpListener::bind(("127.0.0.1", 0))?
                    .local_addr()?
                    .port(),
            )
        } else {
            None
        };
        let mut request = GenericImage::new("docker.io/library/postgres", "18")
            .with_exposed_port(5432.tcp())
            // The temporary bootstrap server is socket-only. Wait for initialization
            // to finish, then check the final TCP listener below.
            .with_wait_for(WaitFor::message_on_stdout(
                "PostgreSQL init process complete; ready for start up.",
            ))
            .with_env_var("POSTGRES_PASSWORD", &password)
            .with_env_var("POSTGRES_HOST_AUTH_METHOD", "scram-sha-256");
        if let Some(port) = host_port {
            request = request
                .with_host_config_modifier(|config| {
                    config.network_mode = Some("host".to_owned());
                    config.port_bindings = None;
                })
                .with_cmd([
                    "postgres".to_owned(),
                    "-p".to_owned(),
                    port.to_string(),
                    "-c".to_owned(),
                    "listen_addresses=127.0.0.1".to_owned(),
                ]);
        }
        let postgres = request.start()
            .await
            .map_err(|error| {
                std::io::Error::other(format!(
                    "testcontainers could not start PostgreSQL: {error}. Enable the Podman API socket or set DOCKER_HOST"
                ))
            })?;
        let (host, port) = if let Some(port) = host_port {
            ("127.0.0.1".to_owned(), port)
        } else {
            (
                postgres.get_host().await?.to_string(),
                postgres.get_host_port_ipv4(5432.tcp()).await?,
            )
        };
        // URL parsing handles IPv6 hosts; generated passwords are lowercase hex.
        let mut url = url::Url::parse("postgresql://postgres@localhost/postgres?sslmode=disable")?;
        url.set_host(Some(&host))?;
        url.set_port(Some(port))
            .map_err(|_| "invalid PostgreSQL port")?;
        url.set_password(Some(&password))
            .map_err(|_| "invalid PostgreSQL password")?;
        (url.to_string(), Some(postgres))
    };

    // Keep the container owned until the command exits, even on test failure.
    let outcome = async {
        if std::env::var_os("I2N_TEST_DATABASE_RESTART").is_some() {
            let postgres = container
                .as_ref()
                .ok_or("restart verification requires a testcontainers-owned database")?;
            verify_restart(postgres, &database_url).await?;
        }
        run_command(executable, args, database_url).await
    }
    .await;
    if let Some(postgres) = container {
        postgres.rm().await?;
    }
    outcome
}

async fn verify_restart(
    postgres: &testcontainers::ContainerAsync<GenericImage>,
    database_url: &str,
) -> Result<()> {
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(8)
        .min_connections(1)
        .acquire_timeout(Duration::from_secs(5))
        .connect(database_url)
        .await?;
    sqlx::query("CREATE TABLE restart_probe (content BYTEA NOT NULL)")
        .execute(&pool)
        .await?;
    let content = vec![7_u8; 100_000];
    sqlx::query("INSERT INTO restart_probe (content) VALUES ($1)")
        .bind(&content)
        .execute(&pool)
        .await?;
    postgres.stop_with_timeout(Some(10)).await?;
    postgres.start().await?;
    let restored = tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            if let Ok(bytes) = sqlx::query_scalar::<_, Vec<u8>>("SELECT content FROM restart_probe")
                .fetch_one(&pool)
                .await
            {
                break bytes;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .map_err(|_| "SQLx pool did not recover after PostgreSQL restart")?;
    if restored != content {
        return Err("stored bytes changed after PostgreSQL restart".into());
    }
    sqlx::query("DROP TABLE restart_probe")
        .execute(&pool)
        .await?;
    pool.close().await;
    eprintln!("PostgreSQL restart: existing SQLx pool reconnected and stored bytes survived");
    Ok(())
}

async fn run_command(
    executable: String,
    args: impl Iterator<Item = String>,
    database_url: String,
) -> Result<()> {
    tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            if let Ok(pool) = sqlx::postgres::PgPoolOptions::new()
                .max_connections(1)
                .acquire_timeout(Duration::from_secs(1))
                .connect(&database_url)
                .await
            {
                pool.close().await;
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .map_err(|_| "test PostgreSQL did not become ready within 30 seconds")?;

    let status = tokio::process::Command::new(executable)
        .args(args)
        .env("I2N_TEST_DATABASE_URL", database_url)
        .kill_on_drop(true)
        .status()
        .await?;
    if !status.success() {
        return Err(format!("test command failed: {status}").into());
    }
    Ok(())
}
