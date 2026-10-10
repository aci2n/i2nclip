//! Scheduled expiration cleanup, independent of transfer admission.

use std::time::Duration;

use tokio::sync::watch;
use tokio::time::MissedTickBehavior;

use crate::crypto;
use crate::db::Database;

/// Sweep immediately and hourly. A stop signal prevents another sweep while
/// allowing an active transaction to finish before the task exits.
pub(crate) async fn run(db: Database, mut stop: watch::Receiver<bool>) {
    let mut interval = tokio::time::interval(Duration::from_secs(3600));
    // Await each sweep in this loop; missed ticks must not cause catch-up work.
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
