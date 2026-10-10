//! Host-only GC trigger. One running server owns each data volume.
use crate::store::{self, AppState};
use crate::Error;
use tokio::sync::watch;

#[cfg(unix)]
pub(crate) fn signal() -> Result<tokio::signal::unix::Signal, Error> {
    Ok(tokio::signal::unix::signal(
        tokio::signal::unix::SignalKind::user_defined1(),
    )?)
}

#[cfg(unix)]
pub(crate) async fn listen(
    state: AppState,
    mut signal: tokio::signal::unix::Signal,
    mut stop: watch::Receiver<bool>,
) {
    loop {
        tokio::select! {
            biased;
            _ = stop.changed() => return,
            received = signal.recv() => if received.is_none() { return; },
        }
        tracing::info!("GC requested; waiting for active uploads");
        let permits = tokio::select! {
            biased;
            _ = stop.changed() => return,
            result = state.upload_slots.clone().acquire_many_owned(store::UPLOAD_SLOTS as u32) => {
                match result { Ok(permits) => permits, Err(_) => return }
            },
        };
        let shared = state.clone();
        // The blocking worker owns admission even if its async waiter is cancelled.
        // Shutdown waits for this sweep before releasing the data volume.
        let result = tokio::task::spawn_blocking(move || {
            let _permits = permits;
            let now = i64::try_from(crate::crypto::now_secs()).unwrap_or(i64::MAX);
            store::gc_staged_files(&shared, now.saturating_sub(store::GC_MIN_AGE_SECS))
        })
        .await;
        match result {
            Ok(Ok(report)) => tracing::info!(
                removed = report.removed,
                failed = report.failed,
                "GC complete"
            ),
            Ok(Err(err)) => tracing::error!(%err, "GC failed"),
            Err(err) => tracing::error!(%err, "GC worker failed"),
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    #[tokio::test]
    async fn signal_waits_for_uploads_then_cleans_and_shuts_down() {
        let dir =
            std::env::temp_dir().join(format!("i2nclip-signal-{}", crate::crypto::fresh_nonce()));
        store::prepare(&dir).unwrap();
        let conn = store::open(&dir).unwrap();
        let id = "a".repeat(64);
        conn.execute("INSERT INTO staged_files VALUES (?1, 0)", [&id])
            .unwrap();
        std::fs::write(dir.join("staging").join(&id), b"abandoned").unwrap();
        let state = AppState::new(dir.clone(), conn, "http://i2nclip.test".into());
        let active = state.upload_slots.clone().acquire_owned().await.unwrap();
        let signal = signal().unwrap();
        let (stop, receiver) = watch::channel(false);
        let task = tokio::spawn(listen(state.clone(), signal, receiver));
        assert!(std::process::Command::new("kill")
            .args(["-USR1", &std::process::id().to_string()])
            .status()
            .unwrap()
            .success());
        tokio::time::sleep(std::time::Duration::from_millis(30)).await;
        assert!(dir.join("staging").join(&id).exists());
        drop(active);
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let remaining: i64 = state
                    .lock()
                    .unwrap()
                    .query_row("SELECT COUNT(*) FROM staged_files", [], |r| r.get(0))
                    .unwrap();
                if remaining == 0 {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(!dir.join("staging").join(&id).exists());
        stop.send(true).unwrap();
        task.await.unwrap();
        assert_eq!(state.upload_slots.available_permits(), store::UPLOAD_SLOTS);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
