//! Startup/configuration checks that do not require PostgreSQL.
use std::process::Command;
fn command() -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_i2nclip"));
    command.env("I2N_ORIGIN", "http://localhost:8080");
    command.env_remove("I2N_DATABASE_URL");
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
