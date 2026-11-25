//! The keeper protocol's requests: a line is decoded into a request, carried out against the
//! keeper's state, and answered on the link.

#![allow(
    clippy::result_large_err,
    reason = "Keeper requests return the shared API v1 error by value"
)]

use std::os::fd::{AsFd, OwnedFd};
use std::time::Instant;

use facade_base::api_v1::keeper::{
    HelloResult, KeeperCall, StartArgs, StartResult, StopArgs, SyncArgs, project_error,
};
use facade_base::api_v1::{
    ApiVersion, EmptyResult, ErrorBody, ProcessExit, Request, Response, parse_request,
};
use facade_base::model::error::{ErrorBody as RuntimeError, Reason};
use facade_base::process::ProcessIdentity;
use serde::Serialize;
use serde_json::Value;

use super::Keeper;
use crate::cli::{Cli, exit_unknown};
use crate::link::Link;
use crate::log;
use crate::runtime::{self, AdmittedRequest};

/// A successful request: the `result`, the master the response carries if any, and a CLI end
/// to report right after the response.
struct Handled {
    result: Value,
    master: Option<OwnedFd>,
    then: Option<(String, ProcessExit)>,
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
        Handled::result(EmptyResult {})
    }

    fn with_master(mut self, master: OwnedFd) -> Handled {
        self.master = Some(master);
        self
    }
}

impl Keeper {
    /// Serves one line from the daemon. Commands require an ID and only `agent.sync` may carry a
    /// master.
    pub(super) fn serve_line(&mut self, text: &[u8], attached: Result<Option<OwnedFd>, usize>) {
        let request = match parse_request(text) {
            Ok(request) => request,
            Err(malformed) => {
                self.post(&Response::failed(malformed.id, malformed.error), None);
                return;
            }
        };
        let Some(id) = request.id else {
            return;
        };
        match self.handle(request, attached) {
            Err(error) => {
                self.post(&Response::failed(Some(id), error), None);
            }
            Ok(handled) => {
                let master = handled.master.as_ref().map(AsFd::as_fd);
                self.post(&Response::ok(id, handled.result), master);
                if let Some((agent, exit)) = handled.then {
                    self.report_exit(&agent, exit);
                }
            }
        }
    }

    fn handle(
        &mut self,
        request: Request,
        attached: Result<Option<OwnedFd>, usize>,
    ) -> Result<Handled, ErrorBody> {
        let greeted = self.link.as_ref().and_then(Link::api_version).is_some();
        let attached = attached.map_err(|count| {
            ErrorBody::invalid_argument(format!(
                "a keeper request carries at most one descriptor; received {count} or more"
            ))
        })?;
        let has_terminal = attached.is_some();
        match runtime::admit(request, greeted, has_terminal)? {
            AdmittedRequest::Hello(api_version) => Ok(self.hello(api_version)),
            AdmittedRequest::Call(call) => match call {
                KeeperCall::Sync(args) => self.sync(args, attached),
                KeeperCall::Start(args) => self.start(args),
                KeeperCall::Stop(args) => self.stop(args),
                KeeperCall::Ping(_) => {
                    self.supervisor.ping(Instant::now());
                    Ok(Handled::nothing())
                }
            },
            AdmittedRequest::Unknown(_) if has_terminal => Err(runtime::unexpected_terminal()),
            AdmittedRequest::Unknown(method) => Err(ErrorBody::method_not_found(format!(
                "unknown method {method}; keeper protocol methods are hello and call"
            ))),
        }
    }

    fn hello(&mut self, api_version: ApiVersion) -> Handled {
        if let Some(link) = &mut self.link {
            link.set_api_version(api_version);
        }
        Handled::result(HelloResult {
            api_version,
            build: facade_base::build_id(),
            agents: self.clis.values().map(Cli::as_held).collect(),
            stop_receipts: true,
        })
    }

    fn start(&mut self, args: StartArgs) -> Result<Handled, ErrorBody> {
        if self.clis.contains_key(&args.agent_id) {
            let message = format!("{} already has a CLI", args.agent_id);
            return Err(ErrorBody::invalid_argument(message));
        }
        let args = args.into();
        let (cli, for_daemon) = Cli::spawn(&args).map_err(project_error)?;
        let ProcessIdentity { pid, birth } = cli.process().clone();
        log("info", &format!("started {}'s CLI ({pid})", args.agent));
        self.clis.insert(args.agent, cli);
        Ok(Handled::result(StartResult { pid, birth }).with_master(for_daemon))
    }

    fn stop(&mut self, args: StopArgs) -> Result<Handled, ErrorBody> {
        let cli = self
            .clis
            .get_mut(&args.agent_id)
            .ok_or_else(|| not_held(&args.agent_id))?;
        runtime::accept_creator_stop(&self.framework, &args, cli.process(), cli.is_stopping())?;
        cli.begin_stop(Instant::now());
        facade_base::service::gate_for_test("keeper-stop-accepted");
        Ok(Handled::nothing())
    }

    /// Makes sure both sides hold the CLI's master: whichever side lacks it gets a copy.
    fn sync(&mut self, args: SyncArgs, given: Option<OwnedFd>) -> Result<Handled, ErrorBody> {
        let SyncArgs {
            agent_id,
            pid,
            birth,
        } = args;
        let process = ProcessIdentity { pid, birth };
        if let Some(cli) = self.clis.get(&agent_id) {
            if cli.process() != &process {
                return Err(ErrorBody::invalid_argument(format!(
                    "pid and birth do not match the CLI held for {agent_id}"
                )));
            }
            // With a master on both sides the daemon's extra copy is dropped here.
            return match given {
                Some(_) => Ok(Handled::nothing()),
                None => {
                    Ok(Handled::nothing().with_master(cli.share_master().map_err(project_error)?))
                }
            };
        }
        let Some(master) = given else {
            return Err(not_held(&agent_id));
        };
        match Cli::adopt(agent_id.clone(), process, master).map_err(project_error)? {
            Some(cli) => {
                log(
                    "info",
                    &format!("now holding {agent_id}'s CLI from the daemon"),
                );
                self.clis.insert(agent_id, cli);
                Ok(Handled::nothing())
            }
            None => {
                let mut handled = Handled::nothing();
                handled.then = Some((agent_id, exit_unknown()));
                Ok(handled)
            }
        }
    }
}

fn not_held(agent: &str) -> ErrorBody {
    project_error(RuntimeError::new(
        Reason::NotFound,
        format!("no CLI is held for {agent}"),
    ))
}
