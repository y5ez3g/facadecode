//! A relay's connection: after its hello, every line is an MCP message, which the service's
//! [`RelayLines`] answers on a blocking thread of its own, the answers written as they finish.

use std::sync::Arc;
use std::time::Instant;

use serde_json::Value;
use tokio::io::AsyncBufReadExt;
use tokio::sync::Notify;

use super::connection::{Connection, Reader};
use super::outbox::Outbox;
use super::{RelayLines, Service};

/// Serves the relay whose hello `params` request `id` carried, until it closes or answers
/// `closing`. A relay the service refuses gets the error, and its connection ends.
pub(super) async fn serve<S: Service>(
    connection: &mut Connection<S>,
    reader: &mut Reader,
    id: Option<u64>,
    params: Value,
) -> anyhow::Result<()> {
    let accepted = connection.service.relay(params, connection.peer_pid).await;
    let (answer, lines) = match accepted {
        Ok(accepted) => accepted,
        Err(error) => {
            connection.outbox.answer(id, Err(error)).await;
            return Ok(());
        }
    };
    connection.outbox.answer(id, Ok(answer)).await;
    connection.teller = Some(connection.tell_closing());
    let mut closing_answered = false;
    let (outbox, answered) = (connection.outbox.clone(), connection.answered.clone());
    let read = carry(&outbox, &answered, reader, &lines, &mut closing_answered).await;
    lines.ended(closing_answered);
    read
}

async fn carry(
    outbox: &Outbox,
    answered: &Notify,
    reader: &mut Reader,
    lines: &Arc<dyn RelayLines>,
    closing_answered: &mut bool,
) -> anyhow::Result<()> {
    let mut line = Vec::new();
    loop {
        line.clear();
        if reader.read_until(b'\n', &mut line).await? == 0 {
            return Ok(());
        }
        let arrived = Instant::now();
        if super::is_closing_response(&line) {
            answered.notify_one();
            *closing_answered = true;
            return Ok(());
        }
        if line.trim_ascii().is_empty() || lines.notice(&line) {
            continue;
        }
        let (lines, outbox) = (lines.clone(), outbox.clone());
        let message = std::mem::take(&mut line);
        tokio::spawn(async move {
            let answering = lines.clone();
            let answer = tokio::task::spawn_blocking(move || answering.respond(&message, arrived))
                .await
                .unwrap_or_else(|_| Some(lines.failed()));
            if let Some(answer) = answer {
                let mut written = answer.to_string().into_bytes();
                written.push(b'\n');
                outbox.send(written).await;
            }
        });
    }
}
