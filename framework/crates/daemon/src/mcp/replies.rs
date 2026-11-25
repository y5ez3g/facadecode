//! Reserves enough space to answer an effect before accepting it.

use std::sync::Arc;

use facade_base::model::error::{ErrorBody, Reason};
use serde_json::{Value, json, value::RawValue};
use tokio::sync::{OwnedRwLockReadGuard, TryAcquireError};

use super::lines::Response;
use crate::lifecycle::RelayLink;
use crate::messages::{InboxSelection, ReadAnswer};
use crate::server::{MAX_OUTBOX_BYTES, Outbox, OutboxRoom};

pub(crate) enum InboxAnswer {
    Page(Value),
    Answered,
}

#[derive(Clone)]
pub(crate) struct ReplyTarget {
    outbox: Outbox,
    pub(super) link: Arc<RelayLink>,
    id: Box<RawValue>,
}

impl ReplyTarget {
    pub(super) fn new(outbox: Outbox, link: Arc<RelayLink>, id: Box<RawValue>) -> Self {
        Self { outbox, link, id }
    }

    pub(super) fn line(&self, result: Value) -> Vec<u8> {
        Response::ok(self.id.clone(), tool_result(result)).into_line()
    }

    /// Text and keys may report any outcome including partial input. Their whole answer has
    /// a place in the queue before the daemon asks the terminal to write.
    pub(super) async fn command(&self) -> Result<EffectRoom, ErrorBody> {
        if let Some(room) = self.try_room(MAX_OUTBOX_BYTES, None)? {
            return Ok(room);
        }
        loop {
            let room = self.reserve(MAX_OUTBOX_BYTES).await?;
            if let Some(effect) = self.link.try_effect()? {
                return Ok(EffectRoom {
                    room,
                    _effect: effect,
                });
            }
            drop(room);
            drop(self.link.effect().await?);
        }
    }

    fn try_room(
        &self,
        bytes: usize,
        reserved: Option<OutboxRoom>,
    ) -> Result<Option<EffectRoom>, ErrorBody> {
        let Some(effect) = self.link.try_effect()? else {
            return Ok(None);
        };
        Ok(self.try_outbox(bytes, reserved)?.map(|room| EffectRoom {
            room,
            _effect: effect,
        }))
    }

    fn try_outbox(
        &self,
        bytes: usize,
        reserved: Option<OutboxRoom>,
    ) -> Result<Option<OutboxRoom>, ErrorBody> {
        let room = match reserved.filter(|room| room.fits(bytes)) {
            Some(room) => room,
            None => match self.outbox.try_reserve(bytes) {
                Ok(room) => room,
                Err(TryAcquireError::NoPermits) => return Ok(None),
                Err(TryAcquireError::Closed) => return Err(closed()),
            },
        };
        Ok(Some(room))
    }

    async fn reserve(&self, bytes: usize) -> Result<OutboxRoom, ErrorBody> {
        tokio::select! {
            biased;
            () = self.link.sealed() => Err(ErrorBody::new(Reason::Upgrading, "this relay is handing over its requests")),
            room = self.outbox.reserve(bytes) => room.map_err(|_| closed()),
        }
    }
}

pub(super) fn tool_result(result: Value) -> Value {
    json!({
        "content": [{ "type": "text", "text": result.to_string() }],
        "isError": result["status"] == "failure", "structuredContent": result,
    })
}

pub(super) struct EffectRoom {
    room: OutboxRoom,
    _effect: OwnedRwLockReadGuard<()>,
}

impl EffectRoom {
    pub(super) fn send(self, line: Vec<u8>) {
        self.room.send(line);
    }
}

pub(crate) struct InboxOutput {
    pub(super) target: ReplyTarget,
    /// The send's receipt data, to which a matching reply is added.
    pub(super) sent: Option<Value>,
}

impl InboxOutput {
    pub(crate) fn link(&self) -> &Arc<RelayLink> {
        &self.target.link
    }

    pub(crate) fn prepare(
        &self,
        count: usize,
        mut page: Value,
        reserved: Option<OutboxRoom>,
    ) -> Result<InboxSelection<InboxAnswer, OutboxRoom>, ErrorBody> {
        if count == 0 {
            return Ok(InboxSelection::ready(count, InboxAnswer::Page(page)));
        }
        if let Some(data) = &self.sent {
            let mut data = data.clone();
            data["messages"] = page["data"]["messages"].take();
            page = super::envelope::success(data);
        }
        let line = self.target.line(page);
        let bytes = line.len();
        if let Some(room) = self.target.try_outbox(bytes, reserved)? {
            return Ok(InboxSelection::Ready {
                count,
                result: InboxAnswer::Answered,
                enqueue: Some(ReadAnswer::new(self.target.link.clone(), room, line)),
            });
        }
        let target = self.target.clone();
        Ok(InboxSelection::Wait(Box::pin(async move {
            target.reserve(bytes).await
        })))
    }
}

fn closed() -> ErrorBody {
    ErrorBody::new(
        Reason::Unavailable,
        "the MCP relay closed before the operation was taken",
    )
}

#[cfg(test)]
mod tests {
    use std::future::Future;
    use std::pin::pin;
    use std::task::{Context, Poll, Waker};

    use super::*;

    #[tokio::test]
    async fn terminal_commands_keep_the_outbox_room_they_waited_for() {
        let (outbox, mut flush) = Outbox::for_test();
        let lifecycle = crate::lifecycle::Lifecycle::new();
        let link = lifecycle.relays.join().unwrap();
        let target = |id| {
            ReplyTarget::new(
                outbox.clone(),
                link.clone(),
                serde_json::value::to_raw_value(&id).unwrap(),
            )
        };
        let first = target(1).command().await.unwrap();
        let second = target(2);
        let third = target(3);
        let mut second = pin!(second.command());
        let mut third = pin!(third.command());
        let mut context = Context::from_waker(Waker::noop());
        assert!(second.as_mut().poll(&mut context).is_pending());
        assert!(third.as_mut().poll(&mut context).is_pending());

        first.send(vec![1]);
        assert_eq!(flush(), [1]);
        let Poll::Ready(Ok(second)) = second.as_mut().poll(&mut context) else {
            panic!("the first waiting terminal command takes the released room");
        };
        assert!(third.as_mut().poll(&mut context).is_pending());
        second.send(vec![2]);
        assert_eq!(flush(), [2]);
        let Poll::Ready(Ok(third)) = third.as_mut().poll(&mut context) else {
            panic!("the second waiting terminal command takes the released room");
        };
        third.send(vec![3]);
        assert_eq!(flush(), [3]);
    }

    #[tokio::test]
    async fn inbox_reads_keep_the_outbox_room_they_waited_for() {
        use facade_base::model::message::{MAX_MESSAGE_CHARS, Message, MessagesSnapshot};

        let (outbox, mut flush) = Outbox::for_test();
        let lifecycle = crate::lifecycle::Lifecycle::new();
        let link = lifecycle.relays.join().unwrap();
        let target = |id: String| {
            ReplyTarget::new(
                outbox.clone(),
                link.clone(),
                serde_json::value::to_raw_value(&id).unwrap(),
            )
        };
        let command = target("command".to_string()).command().await.unwrap();
        let message: Message = serde_json::from_value(json!({
            "message_id": "m1", "from": "facade", "to": "a1",
            "at": "2026-11-25T00:00:00.000Z", "text": "😀".repeat(MAX_MESSAGE_CHARS),
            "delivery": {"status": "success", "text_written": "full"},
        }))
        .unwrap();
        let snapshot = MessagesSnapshot {
            messages: vec![message],
            ..MessagesSnapshot::default()
        };
        let (count, page) = crate::mcp::project_inbox(&snapshot, "local", &[]).unwrap();
        assert_eq!(count, 1);
        let answer_bytes = target("read-0000".to_string()).line(page.clone()).len();
        let read_count = MAX_OUTBOX_BYTES / answer_bytes + 2;
        let mut pending = Vec::new();
        let mut context = Context::from_waker(Waker::noop());
        for index in 0..read_count {
            let output = InboxOutput {
                target: target(format!("read-{index:04}")),
                sent: None,
            };
            let page = &page;
            let mut read = Box::pin(tokio::task::unconstrained(async move {
                let mut reserved = None;
                loop {
                    match output.prepare(count, page.clone(), reserved).unwrap() {
                        InboxSelection::Wait(reservation) => {
                            reserved = Some(reservation.await.unwrap())
                        }
                        InboxSelection::Ready { enqueue, .. } => {
                            enqueue
                                .expect("a nonempty page queues an answer")
                                .claim()
                                .unwrap()
                                .expect("the test relay is open")();
                            return;
                        }
                    }
                }
            }));
            assert!(read.as_mut().poll(&mut context).is_pending());
            pending.push(read);
        }

        command.send(vec![1]);
        assert_eq!(flush(), [1]);
        for (index, read) in pending.iter_mut().enumerate() {
            assert!(
                read.as_mut().poll(&mut context).is_ready(),
                "reader {index} has room"
            );
            let answer: Value = serde_json::from_slice(&flush()).unwrap();
            assert_eq!(answer["id"], format!("read-{index:04}"));
        }
    }
}
