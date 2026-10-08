use std::path::Path;
use std::path::PathBuf;
use std::time::Duration;

use i2nclip::gc_orphan_blobs;
use i2nclip::issue_registration_otc;
use i2nclip::DATA_DIR;
use i2nclip::DEFAULT_REGISTRATION_TTL_SECS;
use i2nclip::GC_BLOB_MIN_AGE;

#[tokio::main]
async fn main() {
    let mut args = std::env::args().skip(1);
    match args.next().as_deref() {
        None => {
            if let Err(err) = i2nclip::run().await {
                eprintln!("i2nclip: {err}");
                std::process::exit(1);
            }
        }
        Some("otc") => {
            let sub = args.next().unwrap_or_else(|| {
                usage_otc();
                std::process::exit(2);
            });
            if sub != "issue" {
                usage_otc();
                std::process::exit(2);
            }
            let mut ttl_secs = DEFAULT_REGISTRATION_TTL_SECS;
            let mut data_dir = PathBuf::from(DATA_DIR);
            while let Some(arg) = args.next() {
                match arg.as_str() {
                    "--data-dir" => {
                        let path = args.next().unwrap_or_else(|| {
                            usage_otc();
                            std::process::exit(2);
                        });
                        data_dir = PathBuf::from(path);
                    }
                    "--ttl-secs" => {
                        let text = args.next().unwrap_or_else(|| {
                            usage_otc();
                            std::process::exit(2);
                        });
                        ttl_secs = text.parse().unwrap_or_else(|_| {
                            eprintln!("i2nclip otc issue: --ttl-secs must be a positive integer");
                            std::process::exit(2);
                        });
                        if ttl_secs == 0 {
                            eprintln!("i2nclip otc issue: --ttl-secs must be at least 1");
                            std::process::exit(2);
                        }
                    }
                    _ => {
                        usage_otc();
                        std::process::exit(2);
                    }
                }
            }
            match issue_registration_otc(&data_dir, ttl_secs) {
                Ok(code) => println!("{code}"),
                Err(err) => {
                    eprintln!("i2nclip otc issue: {err}");
                    std::process::exit(1);
                }
            }
        }
        Some("gc-blobs") => {
            let mut dry_run = false;
            let mut min_age = GC_BLOB_MIN_AGE;
            while let Some(arg) = args.next() {
                match arg.as_str() {
                    "--dry-run" => dry_run = true,
                    "--min-age" => {
                        let secs = args.next().unwrap_or_else(|| {
                            usage_gc();
                            std::process::exit(2);
                        });
                        let parsed: u64 = secs.parse().unwrap_or_else(|_| {
                            eprintln!("i2nclip gc-blobs: --min-age must be a non-negative integer (seconds)");
                            std::process::exit(2);
                        });
                        min_age = Duration::from_secs(parsed);
                    }
                    _ => {
                        usage_gc();
                        std::process::exit(2);
                    }
                }
            }
            match gc_orphan_blobs(Path::new(DATA_DIR), dry_run, min_age) {
                Ok(report) => {
                    let verb = if dry_run { "would remove" } else { "removed" };
                    for id in &report.removed {
                        eprintln!("{verb} {id}");
                    }
                    eprintln!(
                        "{} orphan blob(s), {} retained (too new), {} ignored entr{}",
                        report.removed.len(),
                        report.retained_young,
                        report.ignored,
                        if report.ignored == 1 { "y" } else { "ies" }
                    );
                }
                Err(err) => {
                    eprintln!("i2nclip gc-blobs: {err}");
                    std::process::exit(1);
                }
            }
        }
        Some(_) => {
            eprintln!("usage: i2nclip");
            eprintln!("       i2nclip gc-blobs [--dry-run] [--min-age SECS]");
            eprintln!("       i2nclip otc issue [--ttl-secs SECS]");
            std::process::exit(2);
        }
    }
}

fn usage_otc() {
    eprintln!("usage: i2nclip otc issue [--data-dir PATH] [--ttl-secs SECS]");
    eprintln!("default data dir is {DATA_DIR}");
    eprintln!("default --ttl-secs is {DEFAULT_REGISTRATION_TTL_SECS}");
}

fn usage_gc() {
    eprintln!("usage: i2nclip gc-blobs [--dry-run] [--min-age SECS]");
    eprintln!("default --min-age is {} seconds", GC_BLOB_MIN_AGE.as_secs());
}
