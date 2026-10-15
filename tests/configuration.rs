//! Startup/configuration checks that do not require PostgreSQL.
use std::process::Command;
fn command() -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_i2nclip"));
    command.env("I2N_ORIGIN", "http://localhost:8080");
    command.env_remove("I2N_DATABASE_URL");
    command.env_remove("I2N_TRUSTED_PROXIES");
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

#[test]
fn quota_cli_rejects_invalid_arguments_before_connecting() {
    let key = "a".repeat(43);
    for args in [
        vec!["otc", "issue", "--max-bytes", "-1"],
        vec!["otc", "issue", "--max-files", "9223372036854775808"],
        vec!["otc", "issue", "--max-files", "1.5"],
        vec!["otc", "issue", "--max-files"],
        vec!["otc", "issue", "--ttl-secs", "0"],
        vec!["otc", "issue", "--max-files", "1", "--max-files", "2"],
        vec!["key", "set-limits"],
        vec!["key", "set-limits", &key, "--max-bytes", "100"],
        vec![
            "key",
            "set-limits",
            &key,
            "--max-bytes",
            "0",
            "--max-files",
            "0",
            "--ttl-secs",
            "1",
        ],
    ] {
        let output = command().args(&args).output().unwrap();
        assert_eq!(output.status.code(), Some(2), "{args:?}");
        assert!(!String::from_utf8_lossy(&output.stderr).contains("set I2N_DATABASE_URL"));
    }
    for args in [
        vec!["otc", "issue", "--max-bytes", "0", "--max-files", "0"],
        vec!["otc", "issue", "--max-bytes=+1", "--max-files=10000"],
        vec![
            "key",
            "set-limits",
            &key,
            "--max-bytes",
            "9223372036854775807",
            "--max-files",
            "10000",
        ],
    ] {
        let output = command().args(args).output().unwrap();
        assert_eq!(output.status.code(), Some(1));
        assert!(String::from_utf8_lossy(&output.stderr).contains("set I2N_DATABASE_URL"));
    }
}

#[test]
fn cli_help_is_available_without_database_configuration() {
    for (args, expected) in [
        (vec!["--help"], vec!["otc", "key", "--help"]),
        (vec!["otc", "--help"], vec!["issue"]),
        (
            vec!["otc", "issue", "--help"],
            vec![
                "--ttl-secs",
                "86400",
                "--max-bytes",
                "536870912",
                "--max-files",
                "10000",
            ],
        ),
        (
            vec!["key", "set-limits", "--help"],
            vec!["PUBLIC_KEY", "--max-bytes", "--max-files"],
        ),
    ] {
        let output = command().args(args).output().unwrap();
        assert!(output.status.success());
        let stdout = String::from_utf8(output.stdout).unwrap();
        for text in expected {
            assert!(stdout.contains(text), "missing {text} in {stdout}");
        }
        assert!(output.stderr.is_empty());
    }
}

#[test]
fn invalid_trusted_proxy_configuration_fails_before_database_access() {
    for value in ["bad", "127.0.0.1,", "10.0.0.0/99"] {
        let output = command()
            .env("I2N_DATABASE_URL", "invalid://configuration-only")
            .env("I2N_TRUSTED_PROXIES", value)
            .output()
            .unwrap();
        assert!(!output.status.success());
        assert!(String::from_utf8_lossy(&output.stderr).contains("I2N_TRUSTED_PROXIES"));
    }
}
