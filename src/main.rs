use std::path::PathBuf;

use i2nclip::issue_registration_otc;
use i2nclip::DATA_DIR;
use i2nclip::DEFAULT_REGISTRATION_TTL_SECS;

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
        Some(_) => {
            eprintln!("usage: i2nclip");
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
