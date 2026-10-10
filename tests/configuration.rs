//! Startup/configuration checks that do not require PostgreSQL.
use std::process::Command;
fn command() -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_i2nclip"));
    command.env("I2N_ORIGIN", "http://localhost:8080");
    command.env_remove("I2N_DATABASE_URL");
    command.env_remove("I2N_DATABASE_URL_FILE");
    command
}
#[test]
fn server_and_otc_require_database_configuration() {
    for args in [vec![], vec!["otc", "issue"]] {
        let output = command().args(args).output().unwrap();
        assert!(!output.status.success());
        assert!(String::from_utf8_lossy(&output.stderr).contains("set I2N_DATABASE_URL"));
    }
}
#[test]
fn invalid_database_url_is_not_logged() {
    let secret = "invalid://private-password-never-log";
    let output = command().env("I2N_DATABASE_URL", secret).output().unwrap();
    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("unable to connect to PostgreSQL"));
    assert!(!stderr.contains("private-password-never-log"));
    assert!(!String::from_utf8_lossy(&output.stdout).contains(secret));
}

#[test]
fn database_url_can_be_read_from_a_secret_file() {
    let secret = "invalid://file-password-never-log";
    let path = std::env::temp_dir().join(format!("i2nclip-database-url-{}", std::process::id()));
    std::fs::write(&path, format!("{secret}\n")).unwrap();
    let output = command()
        .env("I2N_DATABASE_URL_FILE", &path)
        .args(["otc", "issue"])
        .output()
        .unwrap();
    std::fs::remove_file(path).unwrap();

    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("unable to connect to PostgreSQL"));
    assert!(!stderr.contains(secret));
}
