use std::{future::Future, io, time::Duration};

use clap::{Parser, Subcommand};
use i2nclip::{Error, StorageLimits, DEFAULT_REGISTRATION_TTL_SECS};
use tokio::sync::watch;

#[derive(Parser)]
#[command(about, version)]
struct Cli {
    /// Omit the command to start the web/API server.
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    /// Manage registration invitations.
    #[command(subcommand)]
    Otc(OtcCommand),
    /// Manage registered keys.
    #[command(subcommand)]
    Key(KeyCommand),
}

#[derive(Subcommand)]
enum OtcCommand {
    /// Issue a single-use invitation with storage limits.
    Issue {
        /// Invitation lifetime in seconds.
        #[arg(long, default_value_t = DEFAULT_REGISTRATION_TTL_SECS, value_parser = clap::value_parser!(u64).range(1..))]
        ttl_secs: u64,
        /// Maximum encrypted content bytes (512 MiB by default).
        #[arg(long, default_value_t = StorageLimits::default().max_content_bytes, value_parser = clap::value_parser!(i64).range(0..))]
        max_bytes: i64,
        /// Maximum number of files.
        #[arg(long, default_value_t = StorageLimits::default().max_files, value_parser = clap::value_parser!(i64).range(0..))]
        max_files: i64,
    },
}

#[derive(Subcommand)]
enum KeyCommand {
    /// Change an existing key's limits without deleting files.
    SetLimits {
        public_key: String,
        /// Maximum encrypted content bytes; zero blocks uploads.
        #[arg(long, value_parser = clap::value_parser!(i64).range(0..))]
        max_bytes: i64,
        /// Maximum number of files; zero blocks uploads.
        #[arg(long, value_parser = clap::value_parser!(i64).range(0..))]
        max_files: i64,
    },
}

#[tokio::main]
async fn main() {
    exit_on_error(execute(Cli::parse().command).await);
}

fn exit_on_error(result: Result<(), Error>) {
    if let Err(error) = result {
        eprintln!("i2nclip: {error}");
        std::process::exit(1);
    }
}

async fn execute(command: Option<Command>) -> Result<(), Error> {
    match command {
        None => {
            let (stop, receiver) = watch::channel(false);
            bound_shutdown(i2nclip::run(stop), receiver).await
        }
        Some(Command::Otc(OtcCommand::Issue {
            ttl_secs,
            max_bytes,
            max_files,
        })) => {
            let code = i2nclip::issue_registration_otc(
                &i2nclip::database_url_from_env()?,
                ttl_secs,
                StorageLimits {
                    max_content_bytes: max_bytes,
                    max_files,
                },
            )
            .await?;
            println!("{code}");
            Ok(())
        }
        Some(Command::Key(KeyCommand::SetLimits {
            public_key,
            max_bytes,
            max_files,
        })) => {
            i2nclip::set_key_limits(
                &i2nclip::database_url_from_env()?,
                &public_key,
                StorageLimits {
                    max_content_bytes: max_bytes,
                    max_files,
                },
            )
            .await
        }
    }
}

// The executable owns forced termination: main exits nonzero on timeout rather
// than waiting for Tokio's runtime to drain detached connection tasks.
async fn bound_shutdown(
    server: impl Future<Output = Result<(), Error>>,
    mut stopped: watch::Receiver<bool>,
) -> Result<(), Error> {
    tokio::pin!(server);
    tokio::select! {
        biased;
        result = &mut server => return result,
        _ = stopped.wait_for(|stopped| *stopped) => {}
    }
    tokio::time::timeout(Duration::from_secs(30), server)
        .await
        .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "shutdown exceeded 30 seconds"))?
}

#[cfg(test)]
mod tests {
    use std::{
        io::Read,
        process::{Child, Command, Stdio},
        time::Instant,
    };

    use super::*;

    #[tokio::test(start_paused = true)]
    async fn shutdown_deadline_starts_on_notification_and_includes_cleanup() {
        let (stop, receiver) = watch::channel(false);
        let task = tokio::spawn(bound_shutdown(std::future::pending(), receiver));
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_secs(60)).await;
        assert!(!task.is_finished(), "running time is not shutdown time");
        stop.send(true).unwrap();
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_secs(29)).await;
        assert!(!task.is_finished());
        tokio::time::advance(Duration::from_secs(1)).await;
        assert!(
            matches!(task.await.unwrap(), Err(Error::Io(error)) if error.kind() == io::ErrorKind::TimedOut)
        );
    }

    #[tokio::test(start_paused = true)]
    async fn normal_cleanup_and_serving_errors_finish_without_waiting_for_deadline() {
        let (stop, receiver) = watch::channel(false);
        let (done, completed) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(bound_shutdown(async { completed.await.unwrap() }, receiver));
        stop.send(true).unwrap();
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_secs(29)).await;
        done.send(Ok(())).unwrap();
        assert!(task.await.unwrap().is_ok());
        let (_stop, receiver) = watch::channel(false);
        assert!(matches!(
            bound_shutdown(async { Err(Error::Unavailable) }, receiver).await,
            Err(Error::Unavailable)
        ));
    }

    #[test]
    fn shutdown_timeout_exits_process_even_with_detached_tasks() {
        struct Process(Child);
        impl Drop for Process {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        let mut child = Process(
            Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "tests::stalled_shutdown_child",
                    "--ignored",
                    "--nocapture",
                ])
                .stdout(Stdio::null())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap(),
        );
        let deadline = Instant::now() + Duration::from_secs(5);
        let status = loop {
            if let Some(status) = child.0.try_wait().unwrap() {
                break status;
            }
            assert!(Instant::now() < deadline, "shutdown test subprocess hung");
            std::thread::sleep(Duration::from_millis(10));
        };
        let mut stderr = String::new();
        child
            .0
            .stderr
            .take()
            .unwrap()
            .read_to_string(&mut stderr)
            .unwrap();
        assert_eq!(status.code(), Some(1));
        assert!(stderr.contains("shutdown exceeded 30 seconds"));
    }

    #[tokio::test(start_paused = true)]
    #[ignore = "subprocess fixture for shutdown_timeout_exits_process_even_with_detached_tasks"]
    async fn stalled_shutdown_child() {
        // Runtime shutdown would hang on this task without the executable's exit path.
        tokio::task::spawn_blocking(std::thread::park);
        let (_stop, receiver) = watch::channel(true);
        let task = tokio::spawn(bound_shutdown(std::future::pending(), receiver));
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_secs(30)).await;
        exit_on_error(task.await.unwrap());
        panic!("shutdown must exit");
    }
}
