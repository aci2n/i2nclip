//! Scheduled expiration cleanup, independent of transfer admission.

use std::time::Duration;

use tokio::sync::watch;
use tokio::time::MissedTickBehavior;

use crate::{crypto, db::Database};

pub(crate) async fn run(db: Database, mut stop: watch::Receiver<bool>) {
    let mut interval = tokio::time::interval(Duration::from_secs(3600));
    interval.set_missed_tick_behavior(MissedTickBehavior::Skip);

    loop {
        tokio::select! {
            biased;

            _ = stop.changed() => break,
            _ = interval.tick() => {
                match db.maintain(crypto::now_secs() as i64).await {
                    Ok((nonces, codes)) => {
                        tracing::info!(nonces, codes, "maintenance complete");
                    }
                    Err(err) => {
                        tracing::error!(%err, "maintenance failed; retrying next interval");
                    }
                }
            }
        }
    }
}
