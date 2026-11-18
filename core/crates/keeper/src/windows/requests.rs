//! The keeper protocol's requests on Windows: a line is decoded into a [`Request`], carried out
//! against the keeper's state, and answered on the link. A terminal travels as the line's
//! `terminal` member, handles duplicated into the receiving process.

use std::time::Instant;

use facade_base::jsonrpc::{ErrorBody, Reason, Response, decode_arguments, parse_request};
use facade_base::keeper::{
    AgentArgs, AgentChange, AgentStart, AgentStop, AgentSync, DaemonPing, HelloParams, HelloResult,
    KEEPER_PROTOCOL_VERSION, KeeperStartArgs, MIN_KEEPER_PROTOCOL_VERSION, StartArgs, StartResult,
    SyncArgs, methods, operation_names, shared_version,
};
use facade_base::operations::{CallParams, Operation};
use facade_base::process::ProcessIdentity;
use facade_base::terminal::PtyMaster;
use facade_base::terminal_lines::take_terminal;
use serde::Serialize;
use serde_json::{Value, json};

use super::Keeper;
use super::cli::{Cli, exit_unknown};
use super::console::ConPty;
use super::link::Link;
use crate::log;

/// Oldest and newest keeper protocol versions this keeper speaks.
const VERSIONS: [u32; 2] = [MIN_KEEPER_PROTOCOL_VERSION, KEEPER_PROTOCOL_VERSION];

/// A request the keeper understands, its arguments decoded.
enum Request {
    Hello(HelloParams),
    Start(KeeperStartArgs),
    Stop(AgentArgs),
    Sync(SyncArgs),
    Ping,
}

/// A successful request: the `result`, the agent whose terminal the response carries if any,
/// and a CLI end to report right after the response.
struct Handled {
    result: Value,
    terminal_of: Option<String>,
    then: Option<AgentChange>,
}

impl Handled {
    fn result(result: impl Serialize) -> Handled {
        Handled {
            result: serde_json::to_value(result).expect("keeper protocol results serialize"),
            terminal_of: None,
            then: None,
        }
    }

    fn nothing() -> Handled {
        Handled::result(json!({}))
    }

    fn with_terminal_of(mut self, agent: &str) -> Handled {
        self.terminal_of = Some(agent.to_string());
        self
    }
}

impl Keeper {
    /// Serves one line from the daemon. Only `agent.sync` may carry a terminal; one that comes
    /// with another request, or with a line refused, is closed.
    pub(super) fn serve_line(&mut self, text: &[u8]) {
        let given = take_terminal(text);
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
                Request::Sync(args) => self.sync(args, given),
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
                let terminal_of = handled.terminal_of.as_deref();
                self.post(&Response::ok(id, handled.result), terminal_of);
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

    fn start(&mut self, args: KeeperStartArgs) -> Result<Handled, ErrorBody> {
        if self.clis.contains_key(&args.agent) {
            let message = format!("{} already has a CLI", args.agent);
            return Err(ErrorBody::invalid_argument(message));
        }
        if self.conpty.is_none() {
            self.conpty = Some(ConPty::load()?);
        }
        let conpty = self.conpty.as_ref().expect("the package was just loaded");
        let cli = Cli::spawn(&args, conpty, &mut self.port)?;
        let ProcessIdentity { pid, birth } = cli.process().clone();
        log("info", &format!("started {}'s CLI ({pid})", args.agent));
        let handled = Handled::result(StartResult { pid, birth }).with_terminal_of(&args.agent);
        self.clis.insert(args.agent, cli);
        Ok(handled)
    }

    fn stop(&mut self, args: AgentArgs) -> Result<Handled, ErrorBody> {
        let cli = self
            .clis
            .get_mut(&args.agent)
            .ok_or_else(|| not_held(&args.agent))?;
        cli.begin_stop(Instant::now());
        Ok(Handled::nothing())
    }

    /// Makes sure both sides hold the CLI's terminal: whichever side lacks it gets a copy.
    fn sync(&mut self, args: SyncArgs, given: Option<PtyMaster>) -> Result<Handled, ErrorBody> {
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
            // With a terminal on both sides the daemon's extra copy is closed here.
            return match given {
                Some(_) => Ok(Handled::nothing()),
                None => Ok(Handled::nothing().with_terminal_of(&args.agent)),
            };
        }
        let Some(master) = given else {
            return Err(not_held(&args.agent));
        };
        match Cli::adopt(args.agent.clone(), process, master, &mut self.port)? {
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
        AgentStart::NAME => Request::Start(decode_arguments::<StartArgs>(args)?.into()),
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
