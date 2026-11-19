//! `facade-mcp` run as an agent's CLI runs it, for scenario tests: MCP over its standard input and
//! output. Or the daemon's own MCP server, reached as `facade-mcp` reaches it: a relay connection
//! to the daemon's socket.

use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{Context, ensure};
use facade_base::paths::ClientSocket;
use serde_json::{Value, json};

use crate::*;

/// Builds the relay command from the Facade entry an isolated CLI was given.
pub fn mcp_command(
    config: &Value,
    home: &Path,
    command_for: impl FnOnce(&Path) -> Command,
) -> anyhow::Result<Command> {
    let entry = &config["mcpServers"]["facade"];
    let program = entry["command"]
        .as_str()
        .context("the test MCP entry has no command")?;
    let program = Path::new(program);
    #[cfg(windows)]
    let powershell = (program == Path::new("powershell.exe"))
        .then(|| {
            let system =
                std::env::var_os("SystemRoot").context("the isolated Windows system root")?;
            Ok::<_, anyhow::Error>(
                std::path::PathBuf::from(system)
                    .join("System32/WindowsPowerShell/v1.0/powershell.exe"),
            )
        })
        .transpose()?;
    #[cfg(windows)]
    let program = powershell.as_deref().unwrap_or(program);
    ensure!(
        program.is_absolute(),
        "the test MCP command must have an absolute path"
    );
    let mut command = command_for(program);
    if let Some(args) = entry.get("args") {
        let args: Vec<String> = serde_json::from_value(args.clone())
            .map_err(|_| anyhow::anyhow!("the test MCP arguments must be an array of strings"))?;
        command.args(args);
    }
    if let Some(env) = entry.get("env") {
        let env: std::collections::BTreeMap<String, String> = serde_json::from_value(env.clone())
            .map_err(|_| {
            anyhow::anyhow!("the test MCP environment must contain string values")
        })?;
        if let Some(configured_home) = env.get("FACADE_HOME") {
            let configured_home = Path::new(configured_home);
            ensure!(
                configured_home == home
                    || configured_home == facade_base::files::real_path(home)?.as_path(),
                "the test MCP configuration must stay in its Facade home"
            );
        }
        command.envs(env);
    }
    command.env("FACADE_HOME", home);
    Ok(command)
}

/// What a test's MCP client speaks to.
enum Server {
    /// A `facade-mcp` process.
    Program(Child),
    /// The daemon, over a relay connection.
    Daemon(ClientSocket),
}

/// A `facade-mcp` process, or a relay connection to the daemon, and the answers it wrote.
pub struct McpTestClient {
    server: Server,
    input: Option<Box<dyn Write + Send>>,
    /// Reads facade-mcp's output until it closes.
    reader: Option<std::thread::JoinHandle<()>>,
    answers: Arc<Mutex<Vec<Value>>>,
    next: u64,
}

impl McpTestClient {
    /// Runs the relay with the command and identity that the active fake CLI was given.
    pub fn open_configured(home: &TestHome, agent: &str) -> McpTestClient {
        McpTestClient::spawn(home, Self::configured_command(home, agent))
    }

    /// Speaks the relay wire protocol with the same private configuration as a running CLI.
    pub fn relay_configured(home: &TestHome, agent: &str) -> McpTestClient {
        let command = Self::configured_command(home, agent);
        let args: Vec<_> = command
            .get_args()
            .map(|arg| arg.to_str().unwrap())
            .collect();
        let env: Vec<_> = command
            .get_envs()
            .filter_map(|(name, value)| Some((name.to_str()?, value?.to_str()?)))
            .collect();
        Self::relay(home, &args, &env)
    }

    fn configured_command(home: &TestHome, agent: &str) -> Command {
        let run = facade_rules::run_folder(&home.path.join("core/runs"), agent)
            .expect("the fake CLI has one run directory");
        let text = std::fs::read_to_string(run.join("mcp.json"))
            .expect("the fake CLI has a generated MCP configuration");
        let config: Value = serde_json::from_str(&text).expect("the run's MCP file is JSON");
        let facade = &config["mcpServers"]["facade"];
        assert!(
            facade["env"]["FACADE_HOME"].is_string(),
            "the run declares its isolated home in the relay configuration"
        );
        assert!(
            facade["args"].as_array().is_some_and(|args| {
                args.len() == 2
                    && args[0] == "--run-credential"
                    && args[1].as_str().is_some_and(|value| !value.is_empty())
            }),
            "the active run has a private credential in its relay arguments"
        );
        mcp_command(&config, &home.path, |program| home.command(program))
            .expect("the run has an isolated relay command")
    }

    /// Runs the active agent's relay and completes MCP's handshake. The handshake uses the run
    /// configuration in v3 and the v2 environment when running the v2 scenario harness.
    pub fn open(home: &TestHome, agent: &str) -> McpTestClient {
        Self::open_with(home, agent, &[])
    }

    /// Runs `facade-mcp` for `agent` as [`McpTestClient::open`] does, with `env` added, such as
    /// test gates.
    pub fn open_with(home: &TestHome, agent: &str, env: &[(&str, &str)]) -> McpTestClient {
        let mut command = if DAEMON_RANGE[1] >= 3 {
            Self::configured_command(home, agent)
        } else {
            let mut command = home.command(&test_binaries().mcp);
            command.env("FACADE_AGENT", agent);
            command
        };
        command.envs(env.iter().copied());
        McpTestClient::spawn(home, command)
    }

    /// Runs the active agent's relay with only the wiring needed to select its home and identity.
    pub fn open_stripped(home: &TestHome, agent: &str) -> McpTestClient {
        let mut command = if DAEMON_RANGE[1] >= 3 {
            let mut command = Self::configured_command(home, agent);
            command.env_clear();
            command
        } else {
            let mut command = Command::new(&test_binaries().mcp);
            command.env_clear().env("FACADE_AGENT", agent);
            command
        };
        command.env("FACADE_HOME", &home.path);
        McpTestClient::spawn(home, command)
    }

    /// Runs `facade-mcp --guest <cli>`, as a CLI's user configuration runs it, with `env` added,
    /// and completes MCP's handshake.
    pub fn open_guest(home: &TestHome, cli: &str, env: &[(&str, &str)]) -> McpTestClient {
        let mut command = home.command(&test_binaries().mcp);
        command
            .args(["--guest", cli])
            .envs(env.iter().copied())
            .env("PATH", home.path_with_test_programs());
        McpTestClient::spawn(home, command)
    }

    /// Runs `command`, a facade-mcp, in `home`, and initializes it. It finds the daemon's socket
    /// from the `FACADE_HOME` its environment names.
    pub fn spawn(home: &TestHome, mut command: std::process::Command) -> McpTestClient {
        let mut child = command
            .current_dir(&home.path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("could not run facade-mcp");
        let output = BufReader::new(child.stdout.take().expect("facade-mcp's output"));
        let input = child.stdin.take().expect("facade-mcp's input");
        McpTestClient::initialize(Server::Program(child), Box::new(input), output)
    }

    /// Connects to `home`'s daemon as `facade-mcp` does for a CLI that ran it with `args` and `env`
    /// in the Facade home, and initializes the daemon's MCP server: the daemon's side of the relay
    /// contract, without the relay.
    pub fn relay(home: &TestHome, args: &[&str], env: &[(&str, &str)]) -> McpTestClient {
        let stream =
            ClientSocket::connect(home.daemon_socket()).expect("could not connect to the daemon");
        let mut output = BufReader::new(stream.try_clone().expect("the connection's other end"));
        // The environment `facade-mcp` would have, run as `open` and `open_guest` run it.
        let mut program = home.command(&test_binaries().mcp);
        program
            .env("PATH", home.path_with_test_programs())
            .envs(env.iter().copied());
        let env: serde_json::Map<String, Value> = program
            .get_envs()
            .filter_map(|(name, value)| Some((name.to_str()?.to_string(), json!(value?.to_str()?))))
            .collect();
        let hello = json!({
            "jsonrpc": "2.0", "id": 1, "method": "hello",
            "params": { "relay": 1, "args": args, "env": env, "cwd": home.path, "reconnect": false },
        });
        (&stream)
            .write_all(format!("{hello}\n").as_bytes())
            .expect("could not write the relay's hello");
        let mut answered = String::new();
        output
            .read_line(&mut answered)
            .expect("the answer to the relay's hello");
        let answered: Value = serde_json::from_str(&answered).unwrap_or_default();
        assert_eq!(answered["result"], json!({ "relay": 1 }), "{answered}");
        let input = stream.try_clone().expect("the connection's other end");
        McpTestClient::initialize(Server::Daemon(stream), Box::new(input), output)
    }

    /// Reads the answers `server` writes to `output` and completes MCP's handshake over `input`.
    fn initialize(
        server: Server,
        input: Box<dyn Write + Send>,
        output: BufReader<impl Read + Send + 'static>,
    ) -> McpTestClient {
        let answers: Arc<Mutex<Vec<Value>>> = Arc::default();
        let read = answers.clone();
        let reader = std::thread::spawn(move || {
            for line in output.lines() {
                let Ok(line) = line else { break };
                read.lock()
                    .unwrap()
                    .push(serde_json::from_str(&line).unwrap_or_else(|_| {
                        panic!("the MCP server wrote a line that is not JSON: {line}")
                    }));
            }
        });
        let mut client = McpTestClient {
            server,
            input: Some(input),
            reader: Some(reader),
            answers,
            next: 0,
        };
        let initialized = client.request(
            "initialize",
            json!({
                "protocolVersion": "2025-06-18", "capabilities": {},
                "clientInfo": { "name": "test", "version": "1" },
            }),
        );
        assert_eq!(
            initialized["result"]["protocolVersion"], "2025-06-18",
            "{initialized}"
        );
        client
            .write(&json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }).to_string());
        // A CLI asks for the tools next, and has them from this answer on.
        let listed = client.request("tools/list", json!({}));
        assert!(listed["result"]["tools"].is_array(), "{listed}");
        client
    }

    /// Writes one line to facade-mcp.
    pub fn write(&mut self, line: &str) {
        let input = self.input.as_mut().expect("facade-mcp's input is open");
        input
            .write_all(format!("{line}\n").as_bytes())
            .expect("could not write to facade-mcp");
    }

    /// Sends a request and returns its ID.
    pub fn send(&mut self, method: &str, params: Value) -> u64 {
        self.next += 1;
        self.write(
            &json!({ "jsonrpc": "2.0", "id": self.next, "method": method, "params": params })
                .to_string(),
        );
        self.next
    }

    /// Waits for the answer to request `id`.
    pub fn answer(&self, id: u64, timeout: Duration) -> Option<Value> {
        let mut found = None;
        wait_until(timeout, || {
            found = self
                .answers
                .lock()
                .unwrap()
                .iter()
                .find(|answer| answer["id"] == id)
                .cloned();
            found.is_some()
        });
        found
    }

    /// Sends a request and waits up to 40 seconds for its answer: a send answers within 30.
    pub fn request(&mut self, method: &str, params: Value) -> Value {
        let id = self.send(method, params);
        self.answer(id, secs(40))
            .unwrap_or_else(|| panic!("facade-mcp did not answer {method}"))
    }

    /// The server's answer to `initialize`.
    pub fn initialized(&self) -> Value {
        self.answer(1, secs(1)).expect("the answer to initialize")
    }

    /// Calls a tool and returns its result envelope, checking that its text is the same envelope.
    pub fn call(&mut self, tool: &str, arguments: Value) -> Value {
        self.call_in(tool, arguments, Value::Null)
    }

    /// Calls a tool with `meta` as its `_meta`, as a CLI names a call's session there, and returns
    /// its result envelope.
    pub fn call_in(&mut self, tool: &str, arguments: Value, meta: Value) -> Value {
        let mut params = json!({ "name": tool, "arguments": arguments });
        if !meta.is_null() {
            params["_meta"] = meta;
        }
        let id = self.send("tools/call", params);
        self.tool_answer(id)
    }

    /// Reads a tool call already sent by the test, with the same checks as a synchronous call.
    pub fn tool_answer(&self, id: u64) -> Value {
        let answer = self
            .answer(id, secs(40))
            .expect("the MCP tool call was answered");
        let result = &answer["result"];
        let text: Value =
            serde_json::from_str(result["content"][0]["text"].as_str().unwrap_or_default())
                .unwrap_or_else(|_| panic!("{answer}"));
        assert_eq!(
            text, result["structuredContent"],
            "the text is the envelope"
        );
        assert_eq!(
            result["isError"],
            result["structuredContent"]["status"] == "failure"
        );
        result["structuredContent"].clone()
    }

    /// Closes facade-mcp's input and waits for it to exit. Returns every answer it wrote and how it
    /// exited.
    pub fn close(mut self, timeout: Duration) -> (Vec<Value>, ExitStatus) {
        drop(self.input.take());
        let Server::Program(child) = &mut self.server else {
            panic!("only a facade-mcp process exits");
        };
        let mut status = None;
        wait_until(timeout, || {
            status = child.try_wait().ok().flatten();
            status.is_some()
        });
        let status = status.expect("facade-mcp did not exit after its input closed");
        if let Some(reader) = self.reader.take() {
            reader.join().expect("the output reader");
        }
        (self.answers.lock().unwrap().clone(), status)
    }
}

impl Drop for McpTestClient {
    fn drop(&mut self) {
        match &mut self.server {
            Server::Program(child) => {
                if child.try_wait().ok().flatten().is_none() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
            Server::Daemon(stream) => {
                let _ = stream.shutdown(std::net::Shutdown::Both);
            }
        }
    }
}
