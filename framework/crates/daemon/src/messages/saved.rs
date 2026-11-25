//! Durably keeps new messages and joins their existing receipts.

use std::sync::Arc;

use facade_base::model::error::{ErrorBody, Reason};
use facade_base::model::message::Message;
use tokio::time::Instant;

use super::write_queue::Lane;
use super::writer::{self, Effect, EffectStop, Prepared, stop_before_effect};
use super::{Deliveries, Earlier, Messages, Posted, hour_ago};
use crate::delivery::{send_before_deadline, send_cancelled_before_save};
use crate::lifecycle::RelayLink;
use crate::store::{MessageTable, RequestId, SaveRejection, SendRoute, SendRouteBinding};
use crate::{Cancel, blocking_in_place};

pub(crate) struct Saving {
    pub(crate) message: Message,
    pub(crate) request_id: Option<String>,
    pub(crate) notify_failure: bool,
    pub(crate) binding: Option<SendRouteBinding>,
    pub(crate) until: Option<Instant>,
    pub(crate) cancel: Cancel,
    pub(crate) relay: Option<Arc<RelayLink>>,
    pub(crate) ordinary: bool,
}

enum SaveAttempt {
    Saved(Option<Posted>),
    Pause(Saving),
}

struct KeepingRoute {
    sender: String,
    id: String,
    binding: SendRouteBinding,
    until: Instant,
    cancel: Cancel,
    relay: Option<Arc<RelayLink>>,
}

enum RouteAttempt {
    Kept(SendRoute, bool),
    Pause(KeepingRoute),
}

impl Messages {
    /// None means that another sender call kept this request's route first. Resolve it again.
    pub(crate) async fn save(&self, mut saving: Saving) -> Result<Option<Posted>, ErrorBody> {
        loop {
            let deliveries = self.deliveries.clone();
            let lane = if saving.ordinary {
                Lane::Ordinary
            } else {
                Lane::Ordered
            };
            let bytes = saving.message.text.len();
            let traced_request = if saving.ordinary && crate::trace_message_batches() {
                saving.request_id.clone()
            } else {
                None
            };
            let stop = stop_before_effect(
                saving.until,
                saving.cancel.clone(),
                saving.relay.as_ref().map(|relay| relay.closing()),
            );
            let attempt = self
                .deliveries
                .writer
                .before_effect(
                    lane,
                    bytes,
                    saving,
                    stop,
                    traced_request.as_deref(),
                    move |batch, pending| {
                        let Some(saving) = pending.lock().unwrap().take() else {
                            return Ok(Prepared::known(Err(send_cancelled_before_save())));
                        };
                        stage_save(batch, deliveries, saving)
                    },
                )
                .await?;
            let attempt = match attempt {
                Effect::Answered(attempt) => attempt,
                Effect::Stopped(waiting, EffectStop::Frozen) => SaveAttempt::Pause(waiting),
                Effect::Stopped(waiting, cause) => {
                    return self.earlier_or_stopped(waiting, cause).await;
                }
            };
            match attempt {
                SaveAttempt::Saved(saved) => return Ok(saved),
                SaveAttempt::Pause(waiting) => {
                    let relay = waiting
                        .relay
                        .as_ref()
                        .expect("this save waits for a relay effect");
                    wait_for_effect(relay, waiting.until, waiting.cancel.clone()).await?;
                    saving = waiting;
                }
            }
        }
    }

    async fn earlier_or_stopped(
        &self,
        saving: Saving,
        stop: EffectStop,
    ) -> Result<Option<Posted>, ErrorBody> {
        let Saving {
            message,
            request_id,
            cancel,
            ..
        } = saving;
        let Message {
            from,
            to,
            from_machine_id,
            text,
            ..
        } = message;
        drop(text);
        if let Some(id) = request_id
            && let Some(earlier) = self
                .saved_request(
                    from_machine_id
                        .as_deref()
                        .unwrap_or(&self.deliveries.machine_id),
                    &from,
                    &to,
                    &id,
                    &cancel,
                )
                .await?
        {
            return Ok(Some(Posted::Earlier(earlier)));
        }
        Err(match stop {
            EffectStop::Cancelled => send_cancelled_before_save(),
            EffectStop::Expired => send_before_deadline(),
            EffectStop::Frozen => unreachable!("a frozen send can resume"),
        })
    }

    pub(crate) async fn keep_send_target(
        &self,
        sender: &str,
        id: &str,
        binding: SendRouteBinding,
        until: Instant,
        cancel: Cancel,
        relay: Option<Arc<RelayLink>>,
    ) -> Result<(SendRoute, bool), ErrorBody> {
        let mut keeping = KeepingRoute {
            sender: sender.to_owned(),
            id: id.to_owned(),
            binding,
            until,
            cancel,
            relay,
        };
        loop {
            let stop = stop_before_effect(
                Some(keeping.until),
                keeping.cancel.clone(),
                keeping.relay.as_ref().map(|relay| relay.closing()),
            );
            let kept = self
                .deliveries
                .writer
                .before_effect(
                    Lane::Ordered,
                    0,
                    keeping,
                    stop,
                    None,
                    move |batch, pending| {
                        let Some(keeping) = pending.lock().unwrap().take() else {
                            return Ok(Prepared::known(Err(send_cancelled_before_save())));
                        };
                        stage_route(batch, keeping)
                    },
                )
                .await?;
            let attempt = match kept {
                Effect::Answered(attempt) => attempt,
                Effect::Stopped(waiting, EffectStop::Frozen) => RouteAttempt::Pause(waiting),
                Effect::Stopped(_, EffectStop::Cancelled) => {
                    return Err(send_cancelled_before_save());
                }
                Effect::Stopped(_, EffectStop::Expired) => return Err(send_before_deadline()),
            };
            match attempt {
                RouteAttempt::Kept(route, repeated) => return Ok((route, repeated)),
                RouteAttempt::Pause(waiting) => {
                    let relay = waiting
                        .relay
                        .as_ref()
                        .expect("this route waits for a relay effect");
                    wait_for_effect(relay, Some(waiting.until), waiting.cancel.clone()).await?;
                    keeping = waiting;
                }
            }
        }
    }

    /// Looks up an existing receipt first in a committed WAL snapshot. A positive candidate is
    /// resolved by the same writer which publishes its original open delivery.
    pub(crate) async fn saved_request(
        &self,
        machine: &str,
        from: &str,
        to: &str,
        id: &str,
        cancel: &Cancel,
    ) -> Result<Option<Earlier>, ErrorBody> {
        let since = hour_ago();
        let request = RequestId {
            id,
            since: &since,
            caller_window_id: None,
        };
        let table = &self.deliveries.table;
        let found = {
            let _turn = table.read_turn().await;
            blocking_in_place(|| table.find_request(machine, from, to, request))
                .map_err(ErrorBody::internal)?
        };
        if found.is_none() {
            return Ok(None);
        }
        let deliveries = self.deliveries.clone();
        let (machine, from, to, id) = (
            machine.to_owned(),
            from.to_owned(),
            to.to_owned(),
            id.to_owned(),
        );
        let lane = if cancel.is_requested() {
            Lane::Closing
        } else {
            Lane::Ordered
        };
        let ticket = self
            .deliveries
            .writer
            .enqueue(lane, 0, move |batch| {
                let request = RequestId {
                    id: &id,
                    since: &since,
                    caller_window_id: None,
                };
                let found = MessageTable::find_request_in(batch, &machine, &from, &to, request)?;
                Ok(Prepared {
                    witness: None,
                    finish: Box::new(move |committed| {
                        committed.require()?;
                        let found = found.map_err(ErrorBody::internal)?;
                        let open = deliveries.lock();
                        Ok(found.map(|receipt| deliveries.earlier(&open, receipt)))
                    }),
                })
            })
            .await?;
        writer::answer(ticket).await
    }
}

async fn wait_for_effect(
    relay: &RelayLink,
    until: Option<Instant>,
    mut cancel: Cancel,
) -> Result<(), ErrorBody> {
    // The queue only tries for a relay effect when it actually has the SQLite write connection.
    if let Some(until) = until {
        tokio::select! {
            biased;
            () = cancel.requested() => Err(send_cancelled_before_save()),
            () = tokio::time::sleep_until(until) => Err(send_before_deadline()),
            effect = relay.effect() => effect.map(drop),
        }
    } else {
        relay.effect().await.map(drop)
    }
}

fn stage_route(
    batch: &mut crate::store::Batch<'_>,
    keeping: KeepingRoute,
) -> rusqlite::Result<Prepared<RouteAttempt>> {
    if keeping.cancel.is_requested() {
        return Ok(Prepared::known(Err(send_cancelled_before_save())));
    }
    if keeping.until <= Instant::now() {
        return Ok(Prepared::known(Err(send_before_deadline())));
    }
    let effect = if let Some(relay) = &keeping.relay {
        match relay.try_effect() {
            Ok(Some(effect)) => Some(effect),
            Ok(None) => return Ok(Prepared::known(Ok(RouteAttempt::Pause(keeping)))),
            Err(error) => return Ok(Prepared::known(Err(error))),
        }
    } else {
        None
    };
    let ((route, repeated), facts) = match MessageTable::keep_send_target_in(
        batch,
        keeping.sender,
        keeping.id,
        keeping.binding,
    )? {
        Ok(kept) => kept,
        Err(error) => return Ok(Prepared::known(Err(ErrorBody::internal(error)))),
    };
    Ok(Prepared::changed(
        move |connection| facts.states(connection),
        move |committed| {
            let _effect = effect;
            committed.require()?;
            Ok(RouteAttempt::Kept(route, repeated))
        },
    ))
}

fn stage_save(
    batch: &mut crate::store::Batch<'_>,
    deliveries: Arc<Deliveries>,
    saving: Saving,
) -> rusqlite::Result<Prepared<SaveAttempt>> {
    if saving.ordinary
        && crate::trace_message_batches()
        && let Some(id) = &saving.request_id
    {
        crate::log("info", &format!("message send staged: request={id}"));
    }
    let since = hour_ago();
    let request = saving.request_id.as_deref().map(|id| RequestId {
        id,
        since: &since,
        caller_window_id: None,
    });
    let stopped = || {
        if saving.cancel.is_requested() {
            Some(send_cancelled_before_save())
        } else if saving.until.is_some_and(|until| until <= Instant::now()) {
            Some(send_before_deadline())
        } else {
            None
        }
    };
    let effect = if let Some(relay) = saving.relay.as_ref() {
        match relay.try_effect() {
            Ok(Some(effect)) => Some(effect),
            Ok(None) if stopped().is_none() => {
                return Ok(Prepared::known(Ok(SaveAttempt::Pause(saving))));
            }
            Ok(None) => None,
            Err(error) => return Ok(Prepared::known(Err(error))),
        }
    } else {
        None
    };
    if let Some(stop) = stopped() {
        let mut found = None;
        if let Some(request) = request {
            let machine = saving
                .message
                .from_machine_id
                .as_deref()
                .unwrap_or(&deliveries.machine_id);
            found = match MessageTable::find_request_in(
                batch,
                machine,
                &saving.message.from,
                &saving.message.to,
                request,
            )? {
                Ok(found) => found,
                Err(error) => return Ok(Prepared::known(Err(ErrorBody::internal(error)))),
            };
        }
        return Ok(Prepared {
            witness: None,
            finish: Box::new(move |committed| {
                let _effect = effect;
                committed.require()?;
                let Some(found) = found else { return Err(stop) };
                let open = deliveries.lock();
                Ok(SaveAttempt::Saved(Some(Posted::Earlier(
                    deliveries.earlier(&open, found),
                ))))
            }),
        });
    }
    let (kept, facts) = match MessageTable::insert_message_in(
        batch,
        &saving.message,
        request,
        saving.notify_failure,
        saving.binding.as_ref(),
    )? {
        Ok(result) => result,
        Err(error) => return Ok(Prepared::known(Err(ErrorBody::internal(error)))),
    };
    Ok(Prepared::changed(
        move |connection| facts.states(connection),
        move |committed| {
            let _effect = effect;
            committed.require()?;
            match kept {
                Ok(kept) => {
                    let mut open = deliveries.lock();
                    Ok(SaveAttempt::Saved(Some(deliveries.posted(&mut open, kept))))
                }
                Err(SaveRejection::ChangedRoute) => Ok(SaveAttempt::Saved(None)),
                Err(SaveRejection::MissingRecipient) => Err(ErrorBody::new(
                    Reason::Ended,
                    "the recipient stopped accepting messages before the save",
                )),
            }
        },
    ))
}
