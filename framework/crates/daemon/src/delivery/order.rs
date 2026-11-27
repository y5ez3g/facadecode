//! A relay admits sends in line order and hands saved messages to each typist in that order.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex, Weak};
use std::task::{Context, Poll, Waker};

use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio::time::Instant;

pub(crate) struct SendOrder {
    admission: Arc<Semaphore>,
    handoffs: Mutex<HashMap<String, Weak<Semaphore>>>,
}

impl Default for SendOrder {
    fn default() -> Self {
        Self {
            admission: Arc::new(Semaphore::new(1)),
            handoffs: Mutex::default(),
        }
    }
}

impl SendOrder {
    pub(crate) fn next(&self) -> SendTurn {
        SendTurn::reserve(&self.admission)
    }

    pub(crate) fn admitted(self: &Arc<Self>, guard: OwnedSemaphorePermit) -> SendAdmission {
        SendAdmission {
            order: self.clone(),
            _guard: guard,
        }
    }
}

pub(crate) struct SendAdmission {
    order: Arc<SendOrder>,
    _guard: OwnedSemaphorePermit,
}

impl SendAdmission {
    /// Reserves a place for this recipient while the save order still holds. The admission turn
    /// is returned as this method ends, even if the recipient has no terminal input room.
    pub(super) fn saved(self, recipient: &str) -> SendTurn {
        let mut handoffs = self.order.handoffs.lock().unwrap();
        let queue = match handoffs.get(recipient).and_then(Weak::upgrade) {
            Some(queue) => queue,
            None => {
                handoffs.retain(|_, entry| entry.strong_count() > 0);
                let queue = Arc::new(Semaphore::new(1));
                handoffs.insert(recipient.to_owned(), Arc::downgrade(&queue));
                queue
            }
        };
        SendTurn::reserve(&queue)
    }
}

pub(crate) enum SendTurn {
    Ready(Option<OwnedSemaphorePermit>),
    Waiting(Pin<Box<dyn Future<Output = Option<OwnedSemaphorePermit>> + Send>>),
}

impl SendTurn {
    /// Enters the FIFO before spawning the work that will wait on it.
    fn reserve(order: &Arc<Semaphore>) -> Self {
        let order = order.clone();
        let mut waiting = Box::pin(async move { order.acquire_owned().await.ok() });
        match waiting
            .as_mut()
            .poll(&mut Context::from_waker(Waker::noop()))
        {
            Poll::Ready(permit) => Self::Ready(permit),
            Poll::Pending => Self::Waiting(waiting),
        }
    }

    pub(crate) async fn until(self, deadline: Instant) -> Option<OwnedSemaphorePermit> {
        match self {
            Self::Ready(permit) => permit,
            Self::Waiting(permit) => tokio::time::timeout_at(deadline, permit)
                .await
                .ok()
                .flatten(),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    #[tokio::test]
    async fn a_blocked_typist_does_not_hold_a_relays_later_saves() {
        let order = Arc::<SendOrder>::default();
        let deadline = Instant::now() + Duration::from_secs(1);
        let first = order.admitted(order.next().until(deadline).await.unwrap());
        let second = order.next();
        let third = order.next();
        let held = first.saved("held").until(deadline).await.unwrap();
        let second = order.admitted(second.until(deadline).await.unwrap());
        let waiting = second.saved("held");
        let third = order.admitted(third.until(deadline).await.unwrap());
        let other = third.saved("other");
        assert!(matches!(waiting, SendTurn::Waiting(_)));
        assert!(matches!(other, SendTurn::Ready(Some(_))));
        drop(held);
        assert!(waiting.until(deadline).await.is_some());
    }
}
