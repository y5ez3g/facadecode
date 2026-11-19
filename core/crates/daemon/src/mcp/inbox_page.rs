//! The inline part of an inbox snapshot, selected before Post settles its delivery.

use facade_base::daemon::{FACADE, Message, MessagesSnapshot};
use facade_base::jsonrpc::ErrorBody;
use facade_base::machine::MachineIdentity;
use facade_base::v3::{InboxMessage, ReadMessagesResult};
use serde_json::Value;

use super::{
    addresses::{inbox_role, qualified},
    envelope,
};
use crate::HUMAN;

const PAGE_TARGET: usize = 8000;

/// Return the complete inline envelope and the number of candidate messages it contains.
pub(crate) fn project_inbox(
    snapshot: &MessagesSnapshot,
    machine_id: &str,
    machines: &[MachineIdentity],
) -> Result<(usize, Value), ErrorBody> {
    let mut page = ReadMessagesResult {
        messages: Vec::new(),
        next_cursor: None,
    };
    for (index, message) in snapshot.messages.iter().enumerate() {
        let previous_cursor = page.next_cursor.take();
        page.messages.push(view(message, machine_id, machines)?);
        page.next_cursor = if index + 1 < snapshot.messages.len() {
            Some(message.message_id.clone())
        } else {
            snapshot.next_cursor.clone()
        };
        if index > 0 && envelope::encode(&page)?.to_string().chars().count() > PAGE_TARGET {
            page.messages.pop();
            page.next_cursor = previous_cursor;
            break;
        }
    }
    Ok((page.messages.len(), envelope::encode(page)?))
}

fn view(
    message: &Message,
    local: &str,
    machines: &[MachineIdentity],
) -> Result<InboxMessage, ErrorBody> {
    let mailbox = message
        .message_ref
        .as_ref()
        .map_or(local, |reference| reference.machine_id.as_str());
    let from = match message.from.as_str() {
        FACADE => FACADE.to_string(),
        HUMAN | "command_line" => "command_line".to_string(),
        id => qualified(
            id,
            message.from_machine_id.as_deref().unwrap_or(mailbox),
            machines,
        )?,
    };
    let reply_to = message
        .reply_to
        .as_deref()
        .map(|reply_to| {
            let machine = message.reply_to_machine_id.as_deref().unwrap_or(mailbox);
            inbox_role(reply_to, machine, local, machines)
        })
        .transpose()?;
    Ok(InboxMessage {
        id: message.message_id.clone(),
        from,
        at: message.at.clone(),
        text: message.text.clone(),
        reply_to,
    })
}
