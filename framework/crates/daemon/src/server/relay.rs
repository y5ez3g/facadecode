//! A relay's MCP lines, read in order and answered as their operations settle.

use std::sync::Arc;
use std::time::Instant;

use facade_base::api_v1::daemon::{ClosingParams, methods};
use facade_base::api_v1::{Notification, encode_line};
use serde_json::Value;
use tokio::io::AsyncBufReadExt;
use tokio::task::JoinSet;

use super::connection::{Connection, Reader};
use super::outbox::Outbox;
use super::{RelayHandshake, RelayLines, Service};
use crate::lifecycle::RelayLink;

/// Serves the relay whose hello `params` request `id` carried, until it closes or answers
/// `closing`. A relay the service refuses gets the error, and its connection ends.
pub(super) async fn serve<S: Service>(
    connection: &mut Connection<S>,
    reader: &mut Reader,
    id: u64,
    params: Value,
) -> anyhow::Result<()> {
    let accepted = connection.service.relay(params, connection.peer_pid).await;
    let RelayHandshake {
        answer,
        lines,
        link,
    } = match accepted {
        Ok(accepted) => accepted,
        Err(error) => {
            connection.outbox.answer(Some(id), Err(error)).await;
            return Ok(());
        }
    };
    connection.outbox.answer(Some(id), Ok(answer)).await;
    let teller = tokio::spawn(tell_closing(connection.outbox.clone(), link.clone()));
    let mut calls = JoinSet::new();
    let read = carry(&connection.outbox, reader, &lines, &link, &mut calls).await;
    let closing_answered = matches!(read, Ok(true));
    if closing_answered {
        lines.settle_cancelled().await;
    }
    teller.abort();
    let _ = teller.await;
    calls.abort_all();
    link.finish(closing_answered);
    lines.ended(closing_answered);
    read.map(|_| ())
}

/// A prepared closing frame follows every committed effect in this connection's queue. If the
/// preparation expires before the frame gets room, this link is still open for work.
async fn tell_closing(outbox: Outbox, link: Arc<RelayLink>) {
    let mut closing = link.closing();
    loop {
        let Ok(build) = closing
            .wait_for(Option::is_some)
            .await
            .map(|build| build.clone())
        else {
            return;
        };
        let build = build.expect("a closing build");
        let told = Notification::new(
            methods::CLOSING,
            ClosingParams {
                build: build.to_string(),
            },
        );
        let told = encode_line(&told);
        tokio::select! {
            biased;
            _ = closing.changed() => continue,
            room = outbox.reserve(told.len()) => {
                let current = closing.borrow();
                if current.as_ref().is_some_and(|current| Arc::ptr_eq(current, &build)) {
                    if let Ok(room) = room {
                        link.seal();
                        room.send(told);
                    }
                    return;
                }
            }
        }
    }
}

async fn carry(
    outbox: &Outbox,
    reader: &mut Reader,
    lines: &Arc<dyn RelayLines>,
    link: &RelayLink,
    calls: &mut JoinSet<()>,
) -> anyhow::Result<bool> {
    let mut line = Vec::new();
    loop {
        tokio::select! {
            biased;
            _ = calls.join_next(), if !calls.is_empty() => continue,
            read = reader.read_until(b'\n', &mut line) => {
                if read? == 0 || !line.ends_with(b"\n") {
                    return Ok(false);
                }
            }
        }
        let arrived = Instant::now();
        let frame = line.trim_ascii();
        if link.is_sealed()
            && serde_json::from_slice::<Value>(frame).is_ok_and(|message| {
                message["method"] == methods::CLOSING && message.get("id").is_none()
            })
        {
            return Ok(true);
        }
        let response = if frame.is_empty() {
            None
        } else {
            lines.take(frame, arrived, outbox)
        };
        line.clear();
        let Some(responding) = response else {
            continue;
        };
        let outbox = outbox.clone();
        calls.spawn(async move {
            if let Some(reply) = responding.await {
                outbox.send(reply).await;
            }
        });
    }
}
