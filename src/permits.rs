//! Shared admission policy. Handlers retain owned guards for resource lifetimes.
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, Weak},
};

use tokio::sync::{OwnedSemaphorePermit, Semaphore};

use crate::Error;

const UPLOAD_SLOTS: usize = 4;
const DOWNLOAD_SLOTS: usize = 16;
const PAIRING_BODY_SLOTS: usize = 16;

#[derive(Clone)]
pub(crate) struct Permits {
    uploads: Arc<Semaphore>,
    downloads: Arc<Semaphore>,
    user_uploads: UserSlots,
    user_downloads: UserSlots,
    pairing_bodies: Arc<Semaphore>,
}

pub(crate) struct TransferPermit {
    _user: OwnedSemaphorePermit,
    _global: OwnedSemaphorePermit,
}

impl Permits {
    pub(crate) fn new() -> Self {
        Self {
            uploads: Arc::new(Semaphore::new(UPLOAD_SLOTS)),
            downloads: Arc::new(Semaphore::new(DOWNLOAD_SLOTS)),
            user_uploads: UserSlots::new(1),
            user_downloads: UserSlots::new(2),
            pairing_bodies: Arc::new(Semaphore::new(PAIRING_BODY_SLOTS)),
        }
    }

    pub(crate) async fn upload(&self, owner: [u8; 32]) -> Result<TransferPermit, Error> {
        acquire(&self.user_uploads, &self.uploads, owner).await
    }

    pub(crate) async fn download(&self, owner: [u8; 32]) -> Result<TransferPermit, Error> {
        acquire(&self.user_downloads, &self.downloads, owner).await
    }

    pub(crate) fn try_pairing_body(&self) -> Result<OwnedSemaphorePermit, Error> {
        self.pairing_bodies
            .clone()
            .try_acquire_owned()
            .map_err(|_| Error::Unavailable)
    }
}

async fn acquire(
    users: &UserSlots,
    global: &Arc<Semaphore>,
    owner: [u8; 32],
) -> Result<TransferPermit, Error> {
    // Busy keys must not reserve global capacity while waiting for their turn.
    let user = users.acquire(owner).await?;
    let global = global
        .clone()
        .acquire_owned()
        .await
        .map_err(|_| Error::Unavailable)?;
    Ok(TransferPermit {
        _user: user,
        _global: global,
    })
}

#[derive(Clone)]
struct UserSlots {
    limit: usize,
    slots: Arc<Mutex<HashMap<[u8; 32], Weak<Semaphore>>>>,
}

impl UserSlots {
    fn new(limit: usize) -> Self {
        Self {
            limit,
            slots: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    async fn acquire(&self, owner: [u8; 32]) -> Result<OwnedSemaphorePermit, Error> {
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
    use std::{
        future::{poll_fn, Future},
        task::Poll,
    };

    use super::*;

    #[tokio::test]
    async fn keyed_waiters_leave_global_capacity_for_other_keys() {
        let permits = Permits::new();
        let clone = permits.clone();
        let first = permits.upload([1; 32]).await.unwrap();
        let mut waiting = Box::pin(clone.upload([1; 32]));
        assert!(poll_fn(|cx| Poll::Ready(waiting.as_mut().poll(cx)))
            .await
            .is_pending());
        let mut others = Vec::new();
        for key in 2..=4 {
            others.push(permits.upload([key; 32]).await.unwrap());
        }
        let mut global_waiter = Box::pin(permits.upload([5; 32]));
        assert!(poll_fn(|cx| Poll::Ready(global_waiter.as_mut().poll(cx)))
            .await
            .is_pending());
        // Cancellation at either admission stage releases its resources.
        drop(waiting);
        drop(global_waiter);
        drop(first);
        let replacement = permits.upload([5; 32]).await.unwrap();
        drop(replacement);
        let same_key = clone.upload([1; 32]).await.unwrap();
        drop(same_key);
        drop(others);
    }

    #[tokio::test]
    async fn download_global_capacity_is_shared_and_cancellation_releases_key_slot() {
        let permits = Permits::new();
        let mut held = Vec::new();
        for key in 0..8 {
            held.push(permits.download([key; 32]).await.unwrap());
            held.push(permits.download([key; 32]).await.unwrap());
        }
        let mut waiting = Box::pin(permits.download([9; 32]));
        assert!(poll_fn(|cx| Poll::Ready(waiting.as_mut().poll(cx)))
            .await
            .is_pending());
        drop(waiting);
        drop(held);
        // Both slots must be available even though one was reserved while waiting globally.
        let first = permits.download([9; 32]).await.unwrap();
        let second = permits.download([9; 32]).await.unwrap();
        drop((first, second));
    }

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
