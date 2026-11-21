//! The inline part of an inbox snapshot, selected before Post settles its delivery.

use facade_base::model::error::ErrorBody;
use facade_base::model::machine::MachineIdentity;
use facade_base::model::message::{FACADE, Message, MessagesSnapshot};
use serde::Serialize;
use serde_json::Value;

use super::{
    addresses::{inbox_role, qualified},
    envelope,
};
use crate::HUMAN;

const PAGE_TARGET: usize = 8000;

#[derive(Serialize)]
struct InboxMessage {
    id: String,
    from: String,
    at: String,
    text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    reply_to: Option<String>,
}

#[derive(Serialize)]
struct ReadMessagesResult {
    messages: Vec<InboxMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    next_cursor: Option<String>,
}

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

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn message_roles_use_unique_names_then_prefixes_or_exact_ids() {
        let local = "55e07e27-11ef-4b5c-ac23-74d587b3463b";
        let remote = "3f9a2c1d-0ad1-4bd3-a032-a6f7b4f89ac4";
        let message: Message = serde_json::from_value(json!({
            "message_id": "m42", "from": "a7", "from_name": "Ada",
            "from_machine_id": remote, "to": "a1", "text": "Ready",
            "reply_to": "m3", "reply_to_machine_id": remote,
            "at": "2026-11-17T00:00:00.000Z",
            "delivery": {"status": "pending", "text_written": "none"},
        }))
        .unwrap();
        let mut machines = vec![MachineIdentity {
            machine_id: remote.into(),
            name: "gpu".into(),
        }];
        let snapshot = MessagesSnapshot {
            messages: vec![message],
            ..MessagesSnapshot::default()
        };
        let view = |here: &str, machines: &[MachineIdentity]| {
            let (count, result) = project_inbox(&snapshot, here, machines).unwrap();
            assert_eq!(count, 1);
            result["data"]["messages"][0].clone()
        };
        let named = view(local, &machines);
        assert_eq!(named["from"], "a7@gpu");
        assert_eq!(named["reply_to"], "m3@gpu");
        assert!(named.get("from_address").is_none());
        assert!(named.get("from_machine_id").is_none());
        assert!(named.get("reply_to_machine_id").is_none());

        machines.extend([
            MachineIdentity {
                machine_id: local.into(),
                name: "gpu".into(),
            },
            MachineIdentity {
                machine_id: "3f9a2c1d-1ad1-4bd3-a032-a6f7b4f89ac4".into(),
                name: "a-saved-peer".into(),
            },
        ]);
        let duplicate = view(local, &machines);
        assert_eq!(duplicate["from"], format!("a7@{remote}"));
        assert_eq!(duplicate["reply_to"], format!("m3@{remote}"));
        let same_machine = view(remote, &machines);
        assert_eq!(same_machine["from"], format!("a7@{remote}"));
        assert_eq!(same_machine["reply_to"], "m3");

        let exact = view(local, &[]);
        assert_eq!(exact["from"], "a7@3f9a2c1d");
        assert_eq!(exact["reply_to"], "m3@3f9a2c1d");
        assert_eq!(exact["id"], "m42");
        assert_eq!(exact["text"], "Ready");
    }
}
