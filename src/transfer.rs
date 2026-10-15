//! Per-key transfer admission. Owned permits keep weak registry entries alive.
use std::collections::HashMap;
use std::sync::{Arc, Mutex, Weak};

use tokio::sync::{OwnedSemaphorePermit, Semaphore};

use crate::Error;

#[derive(Clone)]
pub(crate) struct UserSlots {
    limit: usize,
    slots: Arc<Mutex<HashMap<[u8; 32], Weak<Semaphore>>>>,
}

impl UserSlots {
    pub(crate) fn new(limit: usize) -> Self {
        Self {
            limit,
            slots: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub(crate) async fn acquire(&self, owner: [u8; 32]) -> Result<OwnedSemaphorePermit, Error> {
        let semaphore = {
            let mut slots = self.slots.lock().map_err(|_| Error::Unavailable)?;
            slots.retain(|_, slot| slot.strong_count() > 0);
            match slots.get(&owner).and_then(Weak::upgrade) {
                Some(slot) => slot,
                None => {
                    let slot = Arc::new(Semaphore::new(self.limit));
                    slots.insert(owner, Arc::downgrade(&slot));
                    slot
                }
            }
        };
        semaphore
            .acquire_owned()
            .await
            .map_err(|_| Error::Unavailable)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::future::{poll_fn, Future};
    use std::task::Poll;

    #[tokio::test]
    async fn keyed_slots_wait_independently_and_reclaim_inactive_entries() {
        let slots = UserSlots::new(1);
        let first = slots.acquire([1; 32]).await.unwrap();
        let mut waiting = Box::pin(slots.acquire([1; 32]));
        assert!(poll_fn(|cx| Poll::Ready(waiting.as_mut().poll(cx)))
            .await
            .is_pending());
        let other = slots.acquire([2; 32]).await.unwrap();
        drop(first);
        let admitted = waiting.await.unwrap();
        assert_eq!(slots.slots.lock().unwrap().len(), 2);
        drop(admitted);
        drop(other);
        let active = slots.acquire([3; 32]).await.unwrap();
        assert_eq!(slots.slots.lock().unwrap().len(), 1);
        drop(active);
    }

    #[tokio::test]
    async fn two_download_slots_and_cancelled_waiter_release_capacity() {
        let slots = UserSlots::new(2);
        let first = slots.acquire([1; 32]).await.unwrap();
        let second = slots.acquire([1; 32]).await.unwrap();
        let mut waiting = Box::pin(slots.acquire([1; 32]));
        assert!(poll_fn(|cx| Poll::Ready(waiting.as_mut().poll(cx)))
            .await
            .is_pending());
        drop(waiting);
        drop(first);
        let replacement = slots.acquire([1; 32]).await.unwrap();
        drop(second);
        drop(replacement);
    }
}
