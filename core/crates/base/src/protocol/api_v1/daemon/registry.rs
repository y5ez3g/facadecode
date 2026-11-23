//! Typed dispatch and advertised audiences for daemon operations and topics.

use super::super::frame::{ErrorBody, decode_arguments};
use super::*;
use crate::operations::{Operation, Topic};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EntryAccess {
    pub local: &'static [ClientKind],
    pub forwarded: bool,
}

impl EntryAccess {
    fn allows(self, kind: ClientKind) -> bool {
        if kind == ClientKind::Machine {
            self.forwarded
        } else {
            self.local.contains(&kind)
        }
    }
}

const ALL: &[ClientKind] = &[ClientKind::Terminal, ClientKind::Ide, ClientKind::Mcp];
const PEOPLE: &[ClientKind] = &[ClientKind::Terminal, ClientKind::Ide];
const TERMINAL: &[ClientKind] = &[ClientKind::Terminal];
const PEER: &[ClientKind] = &[];

fn require_access(name: &str, access: EntryAccess, kind: ClientKind) -> Result<(), ErrorBody> {
    if !access.allows(kind) {
        return Err(ErrorBody::new(
            -32000,
            "refused",
            format!("{name} is unavailable to this client"),
        ));
    }
    Ok(())
}

pub trait DaemonOperationVisitor {
    fn operation<O: Operation>(&mut self, access: EntryAccess);
}

pub trait DaemonTopicVisitor {
    fn topic<T: Topic>(&mut self, access: EntryAccess);
}

macro_rules! operations {
    ($( $marker:ident: $name:literal, $doc:literal, $args:ty => $result:ty, $local:ident, $forwarded:literal; )*) => {
        $(
            pub struct $marker;

            impl Operation for $marker {
                const NAME: &'static str = $name;
                const DOC: &'static str = $doc;
                type Args = $args;
                type Result = $result;
            }
        )*

        #[derive(Clone, Debug)]
        #[expect(clippy::large_enum_variant, reason = "The dispatch API carries the registered argument type by value")]
        pub enum DaemonCall {
            $( $marker($args), )*
        }

        pub fn visit_operations(visitor: &mut impl DaemonOperationVisitor) {
            $( visitor.operation::<$marker>(EntryAccess { local: $local, forwarded: $forwarded }); )*
        }

        pub fn operation_access(name: &str) -> Option<EntryAccess> {
            match name {
                $( $marker::NAME => Some(EntryAccess { local: $local, forwarded: $forwarded }), )*
                _ => None,
            }
        }

        pub fn operation_names(kind: ClientKind) -> Vec<String> {
            [
                $( ($marker::NAME, EntryAccess { local: $local, forwarded: $forwarded }), )*
            ]
            .into_iter()
            .filter(|(_, access)| access.allows(kind))
            .map(|(name, _)| name.to_owned())
            .collect()
        }

        pub fn decode_call(params: CallParams, kind: ClientKind) -> Result<DaemonCall, ErrorBody> {
            let access = operation_access(&params.op).ok_or_else(|| {
                ErrorBody::invalid_argument(format!("unknown operation {}", params.op))
            })?;
            require_access(&params.op, access, kind)?;
            let call = match params.op.as_str() {
                $( $marker::NAME => DaemonCall::$marker(decode_arguments(params.args)?), )*
                _ => unreachable!("operation access comes from the same registry"),
            };
            validate_call(&call)?;
            Ok(call)
        }
    };
}

operations! {
    AgentList: "agent.list", "List active agents and Guests.", AgentListArgs => AgentListResult, ALL, false;
    AgentStart: "agent.start", "Start an agent.", StartArgs => StartResult, ALL, true;
    AgentStop: "agent.stop", "Stop selected agents and report each outcome.", StopArgs => BatchStopResult, ALL, true;
    AgentResumeList: "agent.resume_list", "Find agents and sessions that can be resumed.", ResumeListArgs => ResumeListResult, PEOPLE, true;
    AgentResume: "agent.resume", "Resume an agent or a saved CLI session.", ResumeArgs => ResumeResult, PEOPLE, true;
    AgentInspect: "agent.inspect", "Read an agent's status and attachments.", AgentTargetArgs => InspectResult, ALL, true;
    AgentScreen: "agent.screen", "Read logical lines from an agent's screen.", ScreenArgs => ScreenText, ALL, true;
    AgentType: "agent.type", "Send terminal input to an agent.", AgentTypeArgs => TypeResult, ALL, true;
    AgentSend: "agent.send", "Send a message and report delivery.", SendArgs => SendResult, ALL, true;
    AgentRemove: "agent.remove", "Stop an agent and remove its records.", AgentTargetArgs => RemoveResult, ALL, true;
    AgentRename: "agent.rename", "Change an agent's name.", RenameArgs => RenameResult, ALL, true;
    AttachResize: "attach.resize", "Set the capacity of an attached view.", AttachResizeArgs => EmptyResult, PEOPLE, false;
    CliList: "cli.list", "List CLIs available on a machine.", CliListArgs => CliListResult, ALL, true;
    LocationList: "location.list", "List working locations on a machine.", LocationListArgs => LocationListResult, ALL, true;
    MachineList: "machine.list", "Read the local roster of known machines.", NoArgs => MachineListResult, ALL, false;
    MachineConnect: "machine.connect", "Authorize a foreground machine connection.", MachineConnectArgs => MachineConnectResult, TERMINAL, false;
    MachineRemove: "machine.remove", "Remove a saved connection.", MachineRemoveArgs => MachineRemoveResult, PEOPLE, false;
    MachineRename: "machine.rename", "Change the name of a machine.", MachineRenameArgs => MachineRenameResult, PEOPLE, true;
    DaemonStatus: "daemon.status", "Read a daemon's status.", StatusArgs => StatusResult, PEOPLE, true;
    DaemonLog: "daemon.log", "Read the last lines of the local daemon log.", LogArgs => LogResult, PEOPLE, false;
    DaemonUpgrade: "daemon.upgrade", "Arrange for a compatible build to take over.", DaemonUpgradeArgs => DaemonUpgradeResult, TERMINAL, false;
    InternalAgentRecords: "internal.agent_records", "Read visible agent records at their holder.", InternalAgentRecordsArgs => Vec<AgentLookupCandidate>, PEER, true;
    InternalResumeRecords: "internal.resume_records", "Read the holder's resumable agent records.", NoArgs => Vec<ResumeCandidate>, PEER, true;
    InternalEnsureRoute: "internal.ensure_route", "Open saved connections along a machine route.", InternalEnsureRouteArgs => EmptyResult, PEER, true;
    InternalAttachResize: "internal.attach_resize", "Set the capacity of a forwarded view at its holder.", InternalAttachResizeArgs => EmptyResult, PEER, true;
    InternalDeliverStartResult: "internal.deliver_start_result", "Deliver a start receipt to its recipient.", InternalDeliverStartResultArgs => EmptyResult, PEER, true;
    InternalDeliverWaitNotice: "internal.deliver_wait_notice", "Deliver a wait notice to its recipient.", InternalDeliverWaitNoticeArgs => EmptyResult, PEER, true;
    InternalDeliverNotice: "internal.deliver_notice", "Deliver an error, exit, or failed-send notice to its recipient.", InternalDeliverNoticeArgs => EmptyResult, PEER, true;
    InternalCommandReply: "internal.command_reply", "Return a reply to the daemon waiting for it.", CommandReplyArgs => EmptyResult, PEER, true;
}

fn validate_call(call: &DaemonCall) -> Result<(), ErrorBody> {
    if let DaemonCall::AgentType(AgentTypeArgs {
        target,
        input: TerminalInput::Raw { .. },
    }) = call
        && !matches!(target, AgentTarget::Reference(_))
    {
        return Err(ErrorBody::invalid_argument(
            "raw input requires an exact agent reference",
        ));
    }
    Ok(())
}

macro_rules! topics {
    ($( $marker:ident / $variant:ident: $name:literal, $doc:literal, $args:ty => ($snapshot:ty, $change:ty), $local:ident, $forwarded:literal; )*) => {
        $(
            pub struct $marker;

            impl Topic for $marker {
                const NAME: &'static str = $name;
                const DOC: &'static str = $doc;
                type Args = $args;
                type Snapshot = $snapshot;
                type Change = $change;
            }
        )*

        #[derive(Clone, Debug)]
        pub enum DaemonWatch {
            $( $variant($args), )*
        }

        pub fn visit_topics(visitor: &mut impl DaemonTopicVisitor) {
            $( visitor.topic::<$marker>(EntryAccess { local: $local, forwarded: $forwarded }); )*
        }

        pub fn topic_access(name: &str) -> Option<EntryAccess> {
            match name {
                $( $marker::NAME => Some(EntryAccess { local: $local, forwarded: $forwarded }), )*
                _ => None,
            }
        }

        pub fn topic_names(kind: ClientKind) -> Vec<String> {
            [
                $( ($marker::NAME, EntryAccess { local: $local, forwarded: $forwarded }), )*
            ]
            .into_iter()
            .filter(|(_, access)| access.allows(kind))
            .map(|(name, _)| name.to_owned())
            .collect()
        }

        pub fn decode_watch(params: WatchParams, kind: ClientKind) -> Result<DaemonWatch, ErrorBody> {
            let access = topic_access(&params.topic).ok_or_else(|| {
                ErrorBody::invalid_argument(format!("unknown topic {}", params.topic))
            })?;
            require_access(&params.topic, access, kind)?;
            let watch = match params.topic.as_str() {
                $( $marker::NAME => DaemonWatch::$variant(decode_arguments(params.args)?), )*
                _ => unreachable!("topic access comes from the same registry"),
            };
            validate_watch(&watch)?;
            Ok(watch)
        }
    };
}

topics! {
    AgentsTopic / Agents: "agents", "Watch visible agent records.", NoArgs => (AgentsSnapshot, AgentsChange), ALL, true;
    MachinesTopic / Machines: "machines", "Watch the local machine roster.", NoArgs => (Vec<MachineInfo>, MachinesChange), ALL, false;
    AttachTopic / Attach: "attach", "Watch an agent's live or final terminal screen.", AttachArgs => (ScreenSnapshot, ScreenChange), PEOPLE, true;
    AttachShellTopic / AttachShell: "attach.shell", "Watch an agent's terminal screen on a dedicated Shell connection.", AttachArgs => (ScreenSnapshot, ScreenChange), TERMINAL, false;
}

fn validate_watch(watch: &DaemonWatch) -> Result<(), ErrorBody> {
    if let DaemonWatch::Attach(args) | DaemonWatch::AttachShell(args) = watch
        && args.allow_ended
        && !matches!(args.target, AgentTarget::Reference(_))
    {
        return Err(ErrorBody::invalid_argument(
            "allow_ended requires an exact agent reference",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_operation_is_a_thing_and_a_verb_and_every_name_is_there_once() {
        for kind in [
            ClientKind::Terminal,
            ClientKind::Ide,
            ClientKind::Mcp,
            ClientKind::Machine,
        ] {
            let mut names: Vec<String> = operation_names(kind)
                .into_iter()
                .chain(topic_names(kind))
                .collect();
            let count = names.len();
            names.sort();
            names.dedup();
            assert_eq!(names.len(), count);
            assert!(
                operation_names(kind)
                    .iter()
                    .all(|op| op.split('.').count() == 2),
                "{:?}",
                operation_names(kind)
            );
        }
    }
}
