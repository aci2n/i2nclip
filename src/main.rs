use clap::{Parser, Subcommand};
use i2nclip::{StorageLimits, DEFAULT_REGISTRATION_TTL_SECS, MAX_FILE_PLAINTEXT_BYTES};

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
        /// Maximum plaintext bytes per file (32 MiB by default); zero blocks uploads.
        #[arg(long, default_value_t = StorageLimits::default().max_file_plaintext_bytes, value_parser = clap::value_parser!(i64).range(0..=MAX_FILE_PLAINTEXT_BYTES))]
        max_file_plaintext_bytes: i64,
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
        /// Maximum plaintext bytes per file; zero blocks uploads (up to 512 MiB).
        #[arg(long, value_parser = clap::value_parser!(i64).range(0..=MAX_FILE_PLAINTEXT_BYTES))]
        max_file_plaintext_bytes: i64,
    },
}

#[tokio::main]
async fn main() {
    if let Err(error) = execute(Cli::parse().command).await {
        eprintln!("i2nclip: {error}");
        std::process::exit(1);
    }
}

async fn execute(command: Option<Command>) -> Result<(), i2nclip::Error> {
    match command {
        None => i2nclip::run().await,
        Some(Command::Otc(OtcCommand::Issue {
            ttl_secs,
            max_bytes,
            max_files,
            max_file_plaintext_bytes,
        })) => {
            let code = i2nclip::issue_registration_otc(
                &i2nclip::database_url_from_env()?,
                ttl_secs,
                StorageLimits {
                    max_content_bytes: max_bytes,
                    max_files,
                    max_file_plaintext_bytes,
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
            max_file_plaintext_bytes,
        })) => {
            i2nclip::set_key_limits(
                &i2nclip::database_url_from_env()?,
                &public_key,
                StorageLimits {
                    max_content_bytes: max_bytes,
                    max_files,
                    max_file_plaintext_bytes,
                },
            )
            .await
        }
    }
}
