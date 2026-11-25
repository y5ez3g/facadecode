//! Restores and retires Guests, and validates an editor's terminal colors.

use facade_base::model::error::ErrorBody;
use facade_base::{
    model::agent::{AgentsUpdate, ManagedAgent},
    model::terminal::TerminalColors,
};

use crate::agent::AgentHandle;
use crate::{Daemon, an_hour_ago, blocking_in_place, gate_for_test, log};

impl Daemon {
    /// Ends the guest of `cli`'s `session`, as its session-end hook or its process's end says.
    async fn end_guest(&self, cli: &str, session: &str) {
        if let Some(id) = self.guests.end(cli, session)
            && let Some(ending) = self.end_listed_guest(&id)
        {
            let _ = ending.await;
        }
    }

    /// Takes guest `id` out of the list: its record says it ended first, then its record goes with
    /// its inbox in one transaction, and watchers learn of each message that went.
    pub(crate) fn end_listed_guest(&self, id: &str) -> Option<tokio::task::JoinHandle<()>> {
        let guest = self.agents.lock().unwrap().remove(id)?;
        guest.mark_ended();
        // Its record and inbox go before anything else can settle: a result its start's prompt
        // owes it is then never written.
        let store = self.store.clone();
        let messages = self.messages.clone();
        let changes = self.changes.clone();
        let machine = self.machine_id.clone();
        let lifecycle = self.lifecycle.clone();
        let id = id.to_owned();
        let removed = id.clone();
        Some(tokio::spawn(async move {
            if let Err(error) = messages
                .remove_inbox(removed.clone(), move || {
                    store.delete_guest(&removed, an_hour_ago)
                })
                .await
            {
                log("warn", &error.message);
            }
            gate_for_test("before-guest-inbox-removal");
            let _ = changes.send(AgentsUpdate::Removed {
                agent_id: id,
                machine_id: machine,
            });
            lifecycle.note_change();
        }))
    }

    /// Lists again the guests a daemon before this one had; ends those that ended meanwhile, by
    /// the machine's restart or 30 days without a word, with their inboxes.
    pub(crate) fn restore_guests(&self) -> anyhow::Result<()> {
        let kept_since = facade_base::time::iso_time(
            std::time::SystemTime::now()
                .checked_sub(crate::messages::KEPT_FOR)
                .unwrap_or(std::time::SystemTime::UNIX_EPOCH),
        );
        let restored = self.guests.restore(&kept_since)?;
        for record in restored.ended {
            blocking_in_place(|| self.store.delete_guest(&record.agent_id, an_hour_ago))?;
        }
        let mut agents = self.agents.lock().unwrap();
        for info in restored.listed {
            agents.insert(
                info.agent_id.clone(),
                AgentHandle::guest(self.project_guest(info)),
            );
        }
        Ok(())
    }

    /// Gives a recovered guest its stable running machine.
    pub(crate) fn project_guest(&self, mut info: ManagedAgent) -> ManagedAgent {
        info.machine_id = self.machine_id.clone();
        info.windows.clear();
        info
    }

    /// Ends the guests not heard from since `before`.
    pub(crate) async fn end_unheard_guests(&self, before: &str) {
        for (cli, session) in self.guests.unheard(before) {
            self.end_guest(&cli, &session).await;
        }
    }
}

/// `colors` as the screen replies with them; a color that is not `#` and six hexadecimal digits
/// is refused.
pub(crate) fn terminal_colors(
    colors: &TerminalColors,
) -> Result<facade_screen::TerminalColors, ErrorBody> {
    let color = |name: &str, text: &Option<String>| -> Result<Option<[u8; 3]>, ErrorBody> {
        let Some(text) = text else {
            return Ok(None);
        };
        let digits = text.strip_prefix('#').filter(|digits| {
            digits.len() == 6 && digits.bytes().all(|byte| byte.is_ascii_hexdigit())
        });
        let Some(digits) = digits else {
            let message = format!("the {name} color {text:?} is not # and six hexadecimal digits");
            return Err(ErrorBody::invalid_argument(message));
        };
        let channel = |at: usize| u8::from_str_radix(&digits[at..at + 2], 16).expect("hex digits");
        Ok(Some([channel(0), channel(2), channel(4)]))
    };
    Ok(facade_screen::TerminalColors {
        foreground: color("foreground", &colors.foreground)?,
        background: color("background", &colors.background)?,
        cursor: color("cursor", &colors.cursor)?,
    })
}
