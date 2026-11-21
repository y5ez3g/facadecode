//! The keeper's API v1 requests on the authenticated Windows link.

#![allow(
    clippy::result_large_err,
    reason = "Keeper requests return the shared API v1 error by value"
)]

use std::ffi::OsStr;
use std::path::Path;
use std::time::Instant;

use facade_base::api_v1::keeper::{
    HelloResult, KeeperCall, StartArgs, StartResult, SyncArgs, project_error,
};
use facade_base::api_v1::{EmptyResult, ErrorBody, Request, Response, parse_request};
use facade_base::model::error::{ErrorBody as RuntimeError, Reason};
use facade_base::process::ProcessIdentity;
use facade_base::terminal::PtyMaster;

use super::Keeper;
use super::cli::{Adoption, Cli};
use super::console::ConPty;
use super::link::Link;
use crate::log;
use crate::runtime::{self, AdmittedRequest, KeeperStartArgs};

impl Keeper {
    /// Serves one line from the daemon. Id-less messages have no effects, and only a sync
    /// request can use an incoming terminal.
    pub(super) fn serve_line(&mut self, text: &[u8], terminal: Option<PtyMaster>) {
        let request = match parse_request(text) {
            Ok(request) => request,
            Err(malformed) => {
                self.post(&Response::failed(malformed.id, malformed.error));
                return;
            }
        };
        let Some(id) = request.id else {
            return;
        };
        if let Err(error) = self.serve_request(id, request, terminal) {
            self.post(&Response::failed(Some(id), error));
        }
    }

    fn serve_request(
        &mut self,
        id: u64,
        request: Request,
        terminal: Option<PtyMaster>,
    ) -> Result<(), ErrorBody> {
        let greeted = self.link.as_ref().is_some_and(Link::is_greeted);
        match runtime::admit(request, greeted, terminal.is_some())? {
            AdmittedRequest::Hello(api_version) => {
                let link = self.link.as_mut().expect("serving the daemon's request");
                link.greet(api_version);
                self.post(&Response::ok(
                    id,
                    HelloResult {
                        api_version,
                        build: facade_base::build_id(),
                        agents: self.clis.values().map(Cli::as_held).collect(),
                    },
                ));
            }
            AdmittedRequest::Call(call) => match call {
                KeeperCall::Sync(args) => self.sync(id, args, terminal)?,
                KeeperCall::Start(args) => self.start(id, args)?,
                KeeperCall::Stop(args) => {
                    self.stop(&args.agent_id)?;
                    self.post(&Response::ok(id, EmptyResult {}));
                }
                KeeperCall::Ping(_) => {
                    self.supervisor.ping(Instant::now());
                    self.post(&Response::ok(id, EmptyResult {}));
                }
            },
            AdmittedRequest::Unknown(method) => {
                return Err(ErrorBody::method_not_found(format!(
                    "unknown method {method}; keeper methods are hello and call"
                )));
            }
        }
        Ok(())
    }

    fn start(&mut self, id: u64, args: StartArgs) -> Result<(), ErrorBody> {
        let args = KeeperStartArgs::from(args);
        if self.clis.contains_key(&args.agent) {
            return Err(ErrorBody::invalid_argument(format!(
                "{} already has a CLI",
                args.agent
            )));
        }
        if !Path::new(&args.launch.folder).is_absolute() || args.launch.folder.contains('\0') {
            return Err(ErrorBody::invalid_argument(
                "cwd must be an absolute path without NUL characters",
            ));
        }
        let program = Path::new(&args.launch.program);
        if !program.is_absolute() && program.file_name() != Some(OsStr::new(&args.launch.program)) {
            return Err(ErrorBody::invalid_argument(
                "command must start with an absolute executable path or a program name",
            ));
        }
        if self.conpty.is_none() {
            self.conpty = Some(ConPty::load().map_err(project_error)?);
        }
        let conpty = self.conpty.as_ref().expect("the package was just loaded");
        let cli = Cli::spawn(&args, conpty, &mut self.port).map_err(project_error)?;
        let ProcessIdentity { pid, birth } = cli.process().clone();
        self.clis.insert(args.agent.clone(), cli);
        if let Err(error) =
            self.post_terminal(&Response::ok(id, StartResult { pid, birth }), &args.agent)
        {
            let mut cli = self
                .clis
                .remove(&args.agent)
                .expect("the CLI was just started");
            cli.kill_job(Instant::now());
            return Err(error);
        }
        log("info", &format!("started {}'s CLI ({pid})", args.agent));
        Ok(())
    }

    fn stop(&mut self, agent: &str) -> Result<(), ErrorBody> {
        let cli = self.clis.get_mut(agent).ok_or_else(|| not_held(agent))?;
        cli.begin_stop(Instant::now());
        Ok(())
    }

    /// Makes sure both sides hold the CLI's terminal: whichever side lacks it gets a copy.
    fn sync(&mut self, id: u64, args: SyncArgs, given: Option<PtyMaster>) -> Result<(), ErrorBody> {
        let agent = args.agent_id;
        let process = ProcessIdentity {
            pid: args.pid,
            birth: args.birth,
        };
        let reply = Response::ok(id, EmptyResult {});
        if let Some(cli) = self.clis.get(&agent) {
            if cli.process() != &process {
                return Err(ErrorBody::invalid_argument(format!(
                    "{agent}'s held CLI identity does not match process {} and birth {}",
                    process.pid, process.birth
                )));
            }
            // With a terminal on both sides the daemon's extra copy is closed here.
            if given.is_none() {
                return self.post_terminal(&reply, &agent);
            }
            drop(given);
            self.post(&reply);
            return Ok(());
        }
        let master = given.ok_or_else(|| not_held(&agent))?;
        match Cli::adopt(agent.clone(), process, master, &mut self.port).map_err(project_error)? {
            Adoption::Held(cli) => {
                log(
                    "info",
                    &format!("now holding {agent}'s CLI from the daemon"),
                );
                self.clis.insert(agent, cli);
                self.post(&reply);
            }
            Adoption::Ended(exit) => {
                self.post(&reply);
                self.report_exit(&agent, exit);
            }
        }
        Ok(())
    }
}

fn not_held(agent: &str) -> ErrorBody {
    project_error(RuntimeError::new(
        Reason::NotFound,
        format!("no CLI is held for {agent}"),
    ))
}
