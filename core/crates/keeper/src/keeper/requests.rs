//! The keeper protocol's requests: a line is decoded into a [`Request`], carried out against the
//! keeper's state, and answered on the link.

use std::os::fd::{AsFd, OwnedFd};
use std::time::Instant;

use facade_base::jsonrpc::{ErrorBody, Reason, Response, decode_arguments, parse_request};
use facade_base::keeper::{
    AgentArgs, AgentChange, AgentStart, AgentStop, AgentSync, DaemonPing, HelloParams, HelloResult,
    KEEPER_PROTOCOL_VERSION, MIN_KEEPER_PROTOCOL_VERSION, StartArgs, StartResult, SyncArgs,
    methods, operation_names, shared_version,
};
use facade_base::operations::{CallParams, Operation};
use facade_base::process::ProcessIdentity;
use serde::Serialize;
use serde_json::{Value, json};

use super::Keeper;
use crate::cli::{Cli, exit_unknown};
use crate::link::Link;
use crate::log;

/// Oldest and newest keeper protocol versions this keeper speaks.
const VERSIONS: [u32; 2] = [MIN_KEEPER_PROTOCOL_VERSION, KEEPER_PROTOCOL_VERSION];

/// A request the keeper understands, its arguments decoded.
enum Request {
    Hello(HelloParams),
    Start(StartArgs),
    Stop(AgentArgs),
    Sync(SyncArgs),
    Ping,
}

/// A successful request: the `result`, the master the response carries if any, and a CLI end
/// to report right after the response.
struct Handled {
    result: Value,
    master: Option<OwnedFd>,
    then: Option<AgentChange>,
}

impl Handled {
    fn result(result: impl Serialize) -> Handled {
        Handled {
            result: serde_json::to_value(result).expect("keeper protocol results serialize"),
            master: None,
            then: None,
        }
    }

    fn nothing() -> Handled {
        Handled::result(json!({}))
    }

    fn with_master(mut self, master: OwnedFd) -> Handled {
        self.master = Some(master);
        self
    }
}

impl Keeper {
    /// Serves one line from the daemon. `attached` is what came with it; only `agent.sync` may
    /// carry a master, and anything sent with another request is simply closed.
    pub(super) fn serve_line(&mut self, text: &[u8], attached: Result<Option<OwnedFd>, usize>) {
        let request = match parse_request(text) {
            Ok(request) => request,
            Err(error) => {
                self.post(&Response::failed(None, error), None);
                return;
            }
        };
        let greeted = self.link.as_ref().is_some_and(Link::is_greeted);
        let outcome =
            decode(&request.method, request.params, greeted).and_then(|decoded| match decoded {
                Request::Hello(params) => self.hello(params),
                Request::Start(args) => self.start(args),
                Request::Stop(args) => self.stop(args),
                Request::Sync(args) => self.sync(args, attached),
                Request::Ping => {
                    self.supervisor.ping(Instant::now());
                    Ok(Handled::nothing())
                }
            });
        let then = match (request.id, outcome) {
            (None, outcome) => outcome.ok().and_then(|handled| handled.then),
            (Some(id), Err(error)) => {
                self.post(&Response::failed(Some(id), error), None);
                None
            }
            (Some(id), Ok(handled)) => {
                let master = handled.master.as_ref().map(AsFd::as_fd);
                self.post(&Response::ok(id, handled.result), master);
                handled.then
            }
        };
        // A notification gets no response, but a CLI end it found is still reported.
        if let Some(AgentChange::Exit { agent, exit }) = then {
            self.report_exit(&agent, exit);
        }
    }

    fn hello(&mut self, params: HelloParams) -> Result<Handled, ErrorBody> {
        let theirs = params.protocol;
        if shared_version(VERSIONS, theirs).is_none() {
            return Err(ErrorBody::new(
                Reason::ProtocolIncompatible,
                format!(
                    "the keeper speaks keeper protocol versions {}-{}; the daemon speaks {}-{}",
                    VERSIONS[0], VERSIONS[1], theirs[0], theirs[1]
                ),
            ));
        }
        if let Some(link) = &mut self.link {
            link.mark_greeted();
        }
        Ok(Handled::result(HelloResult {
            protocol: VERSIONS,
            build: facade_base::build_id(),
            agents: self.clis.values().map(Cli::as_held).collect(),
        }))
    }

    fn start(&mut self, args: StartArgs) -> Result<Handled, ErrorBody> {
        if self.clis.contains_key(&args.agent) {
            let message = format!("{} already has a CLI", args.agent);
            return Err(ErrorBody::invalid_argument(message));
        }
        let (cli, for_daemon) = Cli::spawn(&args)?;
        let ProcessIdentity { pid, birth } = cli.process().clone();
        log("info", &format!("started {}'s CLI ({pid})", args.agent));
        self.clis.insert(args.agent, cli);
        Ok(Handled::result(StartResult { pid, birth }).with_master(for_daemon))
    }

    fn stop(&mut self, args: AgentArgs) -> Result<Handled, ErrorBody> {
        let cli = self
            .clis
            .get_mut(&args.agent)
            .ok_or_else(|| not_held(&args.agent))?;
        cli.begin_stop(Instant::now());
        Ok(Handled::nothing())
    }

    /// Makes sure both sides hold the CLI's master: whichever side lacks it gets a copy.
    fn sync(
        &mut self,
        args: SyncArgs,
        attached: Result<Option<OwnedFd>, usize>,
    ) -> Result<Handled, ErrorBody> {
        let given = attached.map_err(|count| {
            ErrorBody::invalid_argument(format!(
                "agent.sync carries at most one descriptor; {count} came"
            ))
        })?;
        let process = ProcessIdentity {
            pid: args.pid,
            birth: args.birth,
        };
        if let Some(cli) = self.clis.get(&args.agent) {
            if cli.process() != &process {
                return Err(ErrorBody::invalid_argument(format!(
                    "{}'s CLI here is process {}, not {}",
                    args.agent,
                    cli.process().pid,
                    process.pid
                )));
            }
            // With a master on both sides the daemon's extra copy is dropped here.
            return match given {
                Some(_) => Ok(Handled::nothing()),
                None => Ok(Handled::nothing().with_master(cli.share_master()?)),
            };
        }
        let Some(master) = given else {
            return Err(not_held(&args.agent));
        };
        match Cli::adopt(args.agent.clone(), process, master) {
            Some(cli) => {
                log(
                    "info",
                    &format!("now holding {}'s CLI from the daemon", args.agent),
                );
                self.clis.insert(args.agent, cli);
                Ok(Handled::nothing())
            }
            None => {
                let mut handled = Handled::nothing();
                handled.then = Some(AgentChange::Exit {
                    agent: args.agent,
                    exit: exit_unknown(),
                });
                Ok(handled)
            }
        }
    }
}

/// Decodes a request, enforcing that `hello` comes first and only once.
fn decode(method: &str, params: Value, greeted: bool) -> Result<Request, ErrorBody> {
    if method == methods::HELLO {
        if greeted {
            return Err(ErrorBody::invalid_argument(
                "hello was already received on this connection",
            ));
        }
        return decode_arguments(params).map(Request::Hello);
    }
    if !greeted {
        return Err(ErrorBody::invalid_argument("send hello first"));
    }
    if method != methods::CALL {
        return Err(ErrorBody::method_not_found(format!(
            "unknown method {method}; keeper protocol methods are hello and call"
        )));
    }
    let CallParams { op, args } = decode_arguments(params)?;
    Ok(match op.as_str() {
        AgentStart::NAME => Request::Start(decode_arguments(args)?),
        AgentStop::NAME => Request::Stop(decode_arguments(args)?),
        AgentSync::NAME => Request::Sync(decode_arguments(args)?),
        DaemonPing::NAME => Request::Ping,
        _ => {
            return Err(ErrorBody::invalid_argument(format!(
                "unknown operation {op}; keeper operations are {}",
                operation_names().join(", ")
            )));
        }
    })
}

fn not_held(agent: &str) -> ErrorBody {
    ErrorBody::new(Reason::NotFound, format!("no CLI is held for {agent}"))
}
