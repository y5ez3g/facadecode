//! Facade's server in the configuration of a CLI that rewrites it while it runs: the integration
//! adds and removes it through the CLI's own program (`claude mcp add`, for Claude Code), which
//! rules name, and reads it from the CLI's global configuration.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc::Receiver;
use std::time::{Duration, Instant};

use facade_base::daemon::PartState;
use facade_base::jsonrpc::ErrorBody;
use facade_base::system::{env_var, home_folder_in};
use facade_rules::integration::{self, Programs};
use serde_json::Value;

use crate::store::IntegrationFile;

/// How long the CLI's own command may take.
const COMMAND_TIME: Duration = Duration::from_secs(30);
/// The most of what the command says on its error output that a failure keeps: the end, where a
/// program says why it failed.
const MOST_SAID: usize = 4096;
/// How long a failure waits, once the command ended, for the rest of what it said: a program it
/// started can hold its output open.
const SAID_WAIT: Duration = Duration::from_secs(1);

/// Facade's server of one CLI, in the caller's environment.
pub(super) struct Server<'a> {
    /// The CLI's program, which adds and removes it.
    program: &'static str,
    env: &'a BTreeMap<String, String>,
}

impl<'a> Server<'a> {
    /// The server of `cli`, where its CLI adds it with its own program.
    pub(super) fn of(cli: &str, env: &'a BTreeMap<String, String>) -> Option<Server<'a>> {
        let program = integration::command_program(cli)?;
        Some(Server { program, env })
    }

    /// The part that stands for the server, in answers and in the store.
    pub(super) fn part(&self) -> String {
        format!("{} mcp", self.program)
    }

    /// The program that adds Facade's server, or None where Facade's is there as it would be
    /// added. A server of the person's own named `facade` is refused.
    pub(super) fn plan_add(&self, programs: &Programs) -> Result<Option<PathBuf>, ErrorBody> {
        match self.now()? {
            Some(server) if !integration::is_facade_server(&server) => Err(ErrorBody::refused(
                "Claude Code has a facade server of the person's own; nothing was written",
            )),
            Some(server)
                if integration::same_server(&server, &integration::claude_server(programs)) =>
            {
                Ok(None)
            }
            _ => self.find().map(Some).ok_or_else(|| {
                ErrorBody::refused(format!(
                    "{} is not on PATH: Facade adds its server with Claude Code's own command; \
                     nothing was written",
                    self.program
                ))
            }),
        }
    }

    /// Adds Facade's server with `program`, replacing the one there: what it added.
    pub(super) fn add(&self, program: &Path, programs: &Programs) -> Result<String, ErrorBody> {
        if self.now()?.is_some() {
            self.run(program, &integration::claude_server_remove())?;
        }
        self.run(program, &integration::claude_server_add(programs))?;
        Ok(integration::claude_server(programs).to_string())
    }

    /// Removes Facade's server where it is as Facade adds it now, or as it was added (`kept`); says
    /// so where it is Facade's but changed since.
    pub(super) fn remove(
        &self,
        programs: &Programs,
        kept: Option<&IntegrationFile>,
    ) -> Result<Vec<String>, ErrorBody> {
        let added = kept.and_then(|kept| serde_json::from_slice::<Value>(&kept.written).ok());
        let Some(server) = self.now()? else {
            return Ok(Vec::new());
        };
        let ours = integration::same_server(&server, &integration::claude_server(programs))
            || added.is_some_and(|added| integration::same_server(&server, &added));
        if ours {
            let program = self.find().ok_or_else(|| {
                ErrorBody::refused(format!(
                    "{} is not on PATH: Facade removes its server with Claude Code's own command",
                    self.program
                ))
            })?;
            self.run(&program, &integration::claude_server_remove())?;
            return Ok(Vec::new());
        }
        if integration::is_facade_server(&server) {
            return Ok(vec![format!(
                "{}: Facade's facade server stays: it changed since it was added",
                self.part()
            )]);
        }
        Ok(Vec::new())
    }

    /// Whether the server there is the one Facade last added, `written`.
    pub(super) fn holds(&self, written: &[u8]) -> Result<bool, ErrorBody> {
        let added = serde_json::from_slice::<Value>(written).ok();
        Ok(self
            .now()?
            .zip(added)
            .is_some_and(|(now, added)| integration::same_server(&now, &added)))
    }

    /// Whether Facade's server is there as Facade adds it now.
    pub(super) fn state(&self, programs: &Programs) -> Result<PartState, ErrorBody> {
        Ok(match self.now()? {
            Some(server)
                if integration::same_server(&server, &integration::claude_server(programs)) =>
            {
                PartState::AsWritten
            }
            Some(server) if integration::is_facade_server(&server) => PartState::Changed,
            _ => PartState::Missing,
        })
    }

    /// The user server named `facade` in the CLI's global configuration: `.claude.json` in
    /// `CLAUDE_CONFIG_DIR`, or in the user's home folder.
    fn now(&self) -> Result<Option<Value>, ErrorBody> {
        let folder = env_var(self.env, "CLAUDE_CONFIG_DIR")
            .filter(|folder| !folder.is_empty())
            .map(PathBuf::from)
            .or_else(|| home_folder_in(self.env));
        let Some(folder) = folder else {
            return Ok(None);
        };
        let Some(bytes) = super::files::read(&folder.join(".claude.json"))? else {
            return Ok(None);
        };
        let config: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        Ok(config["mcpServers"].get("facade").cloned())
    }

    /// The CLI's program on the caller's PATH.
    fn find(&self) -> Option<PathBuf> {
        let path = env_var(self.env, "PATH")?;
        facade_base::programs::on_path(self.program, Some(path), Path::new("/"))
    }

    fn run(&self, program: &Path, args: &[String]) -> Result<(), ErrorBody> {
        run(self.program, program, self.env, args)
    }
}

/// Runs `program`, the CLI's program named `name`, with `args` in the caller's environment, for at
/// most 30 seconds. Its error output is read as it comes, on a thread of its own: a pipe Facade
/// read only at the end would fill, and the program would wait on it until it is killed.
fn run(
    name: &str,
    program: &Path,
    env: &BTreeMap<String, String>,
    args: &[String],
) -> Result<(), ErrorBody> {
    let command = format!("{name} {}", args.join(" "));
    let mut child = facade_base::programs::command(program)
        .args(args)
        .env_clear()
        .envs(env)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|err| ErrorBody::internal(format!("could not run {command}: {err}")))?;
    let said = child.stderr.take().map(keep_the_end);
    let until = Instant::now() + COMMAND_TIME;
    let status = loop {
        if let Some(status) = child.try_wait().map_err(ErrorBody::internal)? {
            break status;
        }
        if Instant::now() >= until {
            let _ = child.kill();
            let _ = child.wait();
            return Err(ErrorBody::internal(format!(
                "{command} did not finish within {} seconds",
                COMMAND_TIME.as_secs()
            )));
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    if status.success() {
        return Ok(());
    }
    let said = said
        .and_then(|said| said.recv_timeout(SAID_WAIT).ok())
        .unwrap_or_default();
    Err(ErrorBody::internal(format!(
        "{command} failed: {}",
        said.trim()
    )))
}

/// Reads `output` to its end on a thread of its own and sends its last [`MOST_SAID`] bytes as
/// text, holding meanwhile no more than twice that. The caller may stop waiting before: the thread
/// holds the pipe alone and ends when it closes. Where no thread starts, the pipe closes unread,
/// and a failure says nothing of why.
fn keep_the_end(mut output: impl std::io::Read + Send + 'static) -> Receiver<String> {
    let (send, said) = std::sync::mpsc::channel();
    let reader = std::thread::Builder::new().name("integration-stderr".into());
    let _ = reader.spawn(move || {
        let mut end = Vec::new();
        let mut chunk = [0; 8192];
        loop {
            match output.read(&mut chunk) {
                Ok(0) => break,
                Ok(read) => end.extend_from_slice(&chunk[..read]),
                Err(err) if err.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
            if end.len() > 2 * MOST_SAID {
                end.drain(..end.len() - MOST_SAID);
            }
        }
        let from = end.len().saturating_sub(MOST_SAID);
        let _ = send.send(String::from_utf8_lossy(&end[from..]).into_owned());
    });
    said
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A stand-in `claude`: this test binary, run as a child with `FACADE_TEST_CHATTY` set, writes a
    /// mebibyte to its error output, more than a pipe holds, then that variable's text, and exits
    /// with `FACADE_TEST_CHATTY_CODE`. Run as a test, it does nothing.
    #[test]
    fn chatty_claude() {
        use std::io::Write;
        let Ok(last) = std::env::var("FACADE_TEST_CHATTY") else {
            return;
        };
        let code = std::env::var("FACADE_TEST_CHATTY_CODE")
            .ok()
            .and_then(|code| code.parse().ok())
            .unwrap_or(0);
        let mut said = std::io::stderr().lock();
        said.write_all(&vec![b'x'; 1 << 20]).unwrap();
        writeln!(said, "{last}").unwrap();
        said.flush().unwrap();
        std::process::exit(code);
    }

    /// Runs the stand-in `claude` through `run`, saying `last` and exiting with `code`.
    fn run_chatty_claude(last: &str, code: i32) -> Result<(), ErrorBody> {
        let mut env: BTreeMap<String, String> = std::env::vars_os()
            .filter_map(|(name, value)| Some((name.into_string().ok()?, value.into_string().ok()?)))
            .collect();
        env.insert("FACADE_TEST_CHATTY".into(), last.into());
        env.insert("FACADE_TEST_CHATTY_CODE".into(), code.to_string());
        let test = "guests::integration::command::tests::chatty_claude";
        let args = [test.into(), "--exact".into(), "--nocapture".into()];
        run("claude", &std::env::current_exe().unwrap(), &env, &args)
    }

    /// `claude` saying more on its error output than a pipe holds finishes at once: Facade reads it
    /// as it comes.
    #[test]
    fn a_claude_that_says_much_finishes_at_once() {
        let started = Instant::now();
        run_chatty_claude("done", 0).unwrap();
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "it took {:?}",
            started.elapsed()
        );
    }

    /// A failure says the end of what `claude` said, where it says why, and no more than that.
    #[test]
    fn a_failure_says_the_end_of_what_claude_said() {
        let failed = run_chatty_claude("the-reason", 1).unwrap_err();
        assert!(
            failed.message.ends_with("the-reason"),
            "{}",
            &failed.message[failed.message.len().saturating_sub(80)..]
        );
        assert!(
            failed.message.len() < MOST_SAID + 200,
            "{} bytes",
            failed.message.len()
        );
    }
}
