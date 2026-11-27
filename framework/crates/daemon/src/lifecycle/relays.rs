//! The cut at which an MCP relay has handed back all its effects and accepted cancellations.

use std::sync::{Arc, Mutex, Weak};

use facade_base::api_v1::daemon::DRAIN_TIME;
use facade_base::model::error::{ErrorBody, Reason};
use tokio::sync::{OwnedRwLockReadGuard, OwnedRwLockWriteGuard, RwLock, watch};
use tokio::time::Instant;

pub(crate) struct RelayDrain {
    effects: Arc<RwLock<()>>,
    closing: watch::Sender<Option<Arc<str>>>,
    links: Mutex<Vec<Weak<RelayLink>>>,
}

impl Default for RelayDrain {
    fn default() -> Self {
        Self {
            effects: Arc::default(),
            closing: watch::channel(None).0,
            links: Mutex::default(),
        }
    }
}

impl RelayDrain {
    pub(crate) fn join(&self) -> Result<Arc<RelayLink>, ErrorBody> {
        let _admission = self.effects.try_read().map_err(|_| upgrading())?;
        let link = Arc::new(RelayLink {
            effects: self.effects.clone(),
            closing: self.closing.subscribe(),
            sealed: watch::Sender::new(false),
            finished: watch::Sender::new(None),
        });
        let mut links = self.links.lock().unwrap();
        links.retain(|previous| previous.strong_count() > 0);
        links.push(Arc::downgrade(&link));
        Ok(link)
    }

    /// Freezes effects, then closes each admitted relay on its own outbox. The caller retains the
    /// freeze until publication either fails or the old daemon exits.
    pub(super) async fn prepare(&self, build: &str) -> Result<RelayFreeze, ErrorBody> {
        facade_base::service::mark_for_test("upgrade-relay-preparing");
        let settled = async {
            let effects = self.effects.clone().write_owned().await;
            let links: Vec<_> = self
                .links
                .lock()
                .unwrap()
                .iter()
                .filter_map(Weak::upgrade)
                .filter(|link| link.finished.borrow().is_none())
                .collect();
            let freeze = RelayFreeze {
                closing: self.closing.clone(),
                _effects: effects,
            };
            self.closing.send_replace(Some(Arc::from(build)));
            for link in links {
                if !link.confirmed().await {
                    return None;
                }
            }
            Some(freeze)
        };
        tokio::time::timeout_at(Instant::now() + DRAIN_TIME, settled)
            .await
            .ok()
            .flatten()
            .ok_or_else(|| {
                ErrorBody::new(
                    Reason::Unavailable,
                    "MCP relays did not finish the handover. Facade is still running this build",
                )
            })
    }
}

pub(super) struct RelayFreeze {
    closing: watch::Sender<Option<Arc<str>>>,
    _effects: OwnedRwLockWriteGuard<()>,
}

impl Drop for RelayFreeze {
    fn drop(&mut self) {
        self.closing.send_replace(None);
    }
}

pub(crate) struct RelayLink {
    effects: Arc<RwLock<()>>,
    closing: watch::Receiver<Option<Arc<str>>>,
    sealed: watch::Sender<bool>,
    finished: watch::Sender<Option<bool>>,
}

impl RelayLink {
    pub(crate) fn closing(&self) -> watch::Receiver<Option<Arc<str>>> {
        self.closing.clone()
    }

    /// Called with the matching closing signal still borrowed and room for its frame reserved.
    pub(crate) fn seal(&self) {
        self.sealed.send_replace(true);
    }

    pub(crate) async fn sealed(&self) {
        let _ = self.sealed.subscribe().wait_for(|sealed| *sealed).await;
    }

    pub(crate) fn is_sealed(&self) -> bool {
        *self.sealed.borrow()
    }

    /// None while a takeover is preparing. Once the link is sealed it cannot start another effect.
    pub(crate) fn try_effect(&self) -> Result<Option<OwnedRwLockReadGuard<()>>, ErrorBody> {
        let Ok(guard) = self.effects.clone().try_read_owned() else {
            return Ok(None);
        };
        if *self.sealed.borrow() {
            return Err(upgrading());
        }
        Ok(Some(guard))
    }

    pub(crate) async fn effect(&self) -> Result<OwnedRwLockReadGuard<()>, ErrorBody> {
        let guard = tokio::select! {
            biased;
            () = self.sealed() => return Err(upgrading()),
            guard = self.effects.clone().read_owned() => guard,
        };
        if self.is_sealed() {
            Err(upgrading())
        } else {
            Ok(guard)
        }
    }

    pub(crate) fn finish(&self, confirmed: bool) {
        self.finished.send_replace(Some(confirmed));
    }

    async fn confirmed(&self) -> bool {
        self.finished
            .subscribe()
            .wait_for(Option::is_some)
            .await
            .is_ok_and(|finished| *finished == Some(true))
    }
}

fn upgrading() -> ErrorBody {
    ErrorBody::new(Reason::Upgrading, "this relay is handing over its requests")
}
