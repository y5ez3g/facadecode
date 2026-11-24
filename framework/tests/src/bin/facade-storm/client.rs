//! Connections a storm drives the daemon through: line JSON-RPC, answered as each answer arrives
//! rather than at a poll.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::time::{Duration, Instant};

use anyhow::{Context, bail};
use facade_base::paths::ClientSocket;
use facade_scenarios::serde_json::{self, Value, json};
use facade_scenarios::*;

/// JSON-RPC IDs never repeat in one storm: a relay's request ID is its process and the call's ID.
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

type Waiting = Arc<Mutex<HashMap<u64, mpsc::Sender<(Instant, Value)>>>>;

/// An answer to a request, and when its line was read.
pub type Answer = mpsc::Receiver<(Instant, Value)>;

/// One line JSON-RPC connection, shared by any number of threads.
pub struct Rpc {
    write: Mutex<Box<dyn Write + Send>>,
    waiting: Waiting,
    /// The socket under it, if it has one: its reader keeps it open until it is shut.
    socket: Option<ClientSocket>,
}

impl Drop for Rpc {
    fn drop(&mut self) {
        if let Some(socket) = &self.socket {
            let _ = socket.shutdown(std::net::Shutdown::Both);
        }
    }
}

impl Rpc {
    pub fn new(read: impl Read + Send + 'static, write: Box<dyn Write + Send>) -> Rpc {
        Self::with_notices(read, write, |_| {})
    }

    /// A connection whose notifications go to `on_notice`, on the thread that reads it.
    pub fn with_notices(
        read: impl Read + Send + 'static,
        write: Box<dyn Write + Send>,
        mut on_notice: impl FnMut(Value) + Send + 'static,
    ) -> Rpc {
        let waiting: Waiting = Arc::default();
        let answered = waiting.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(read).lines() {
                let Ok(line) = line else { break };
                let at = Instant::now();
                let Ok(message) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                if message.get("method").is_some() {
                    on_notice(message);
                    continue;
                }
                let waiter = message["id"]
                    .as_u64()
                    .and_then(|id| answered.lock().unwrap().remove(&id));
                if let Some(waiter) = waiter {
                    let _ = waiter.send((at, message));
                }
            }
            // Dropping the waiters tells each that no answer comes.
            answered.lock().unwrap().clear();
        });
        Rpc {
            write: Mutex::new(write),
            waiting,
            socket: None,
        }
    }

    /// A connection over `socket`, which closes it as it ends.
    fn over(
        socket: ClientSocket,
        read: impl Read + Send + 'static,
        on_notice: impl FnMut(Value) + Send + 'static,
    ) -> anyhow::Result<Rpc> {
        let write = socket.try_clone()?;
        let mut rpc = Self::with_notices(read, Box::new(write), on_notice);
        rpc.socket = Some(socket);
        Ok(rpc)
    }

    fn write_line(&self, message: &Value) -> std::io::Result<()> {
        let mut line = serde_json::to_vec(message).expect("JSON");
        line.push(b'\n');
        let mut write = self.write.lock().unwrap();
        write.write_all(&line)?;
        write.flush()
    }

    /// Sends a request; the receiver gets its answer.
    pub fn begin(&self, method: &str, params: Value) -> Answer {
        let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
        let (answer, receiver) = mpsc::channel();
        self.waiting.lock().unwrap().insert(id, answer);
        let message = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        if self.write_line(&message).is_err() {
            self.waiting.lock().unwrap().remove(&id);
        }
        receiver
    }

    pub fn request(&self, method: &str, params: Value, timeout: Duration) -> anyhow::Result<Value> {
        let (_, answer) = self
            .begin(method, params)
            .recv_timeout(timeout)
            .with_context(|| format!("no answer to {method}"))?;
        Ok(answer)
    }

    /// Sends a notification: no answer comes.
    pub fn notify(&self, method: &str, params: Value) -> std::io::Result<()> {
        self.write_line(&json!({ "jsonrpc": "2.0", "method": method, "params": params }))
    }

    /// A daemon operation, and its result.
    pub fn call(&self, op: &str, args: Value) -> anyhow::Result<Value> {
        let answer = self.request(
            "call",
            json!({ "op": op, "args": args }),
            Duration::from_secs(60),
        )?;
        match answer.get("result") {
            Some(result) => Ok(result.clone()),
            None => bail!("{op} failed: {answer}"),
        }
    }
}

/// Connects to `socket`'s daemon as a person's terminal.
pub fn terminal(socket: &Path) -> anyhow::Result<Rpc> {
    terminal_with(socket, |_| {})
}

/// [`terminal`], with the daemon's notifications.
pub fn terminal_with(
    socket: &Path,
    on_notice: impl FnMut(Value) + Send + 'static,
) -> anyhow::Result<Rpc> {
    let stream = ClientSocket::connect(socket).context("connecting to the storm's daemon")?;
    let read = stream.try_clone()?;
    let rpc = Rpc::over(stream, read, on_notice)?;
    let hello = rpc.request(
        "hello",
        json!({ "api_versions": DAEMON_API_VERSIONS, "build": "storm", "kind": "terminal" }),
        Duration::from_secs(20),
    )?;
    anyhow::ensure!(hello["result"]["api_version"] == 1, "hello: {hello}");
    Ok(rpc)
}

/// What an agent's MCP client speaks to: the daemon itself, as the relay does, or a relay process.
enum Server {
    Daemon,
    Relay(Mutex<Child>),
}

/// One agent's or guest's MCP session.
pub struct Mcp {
    rpc: Rpc,
    server: Server,
}

impl Mcp {
    /// `agent`'s MCP session over a relay connection of this process, with its run's credential.
    pub fn managed(home: &TestHome, agent: &str) -> anyhow::Result<Mcp> {
        let command = Self::command(home, agent)?;
        let args: Vec<_> = command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        let env: serde_json::Map<String, Value> = command
            .get_envs()
            .filter_map(|(name, value)| Some((name.to_str()?.to_string(), json!(value?.to_str()?))))
            .collect();
        let mut stream = ClientSocket::connect(home.daemon_socket())?;
        let hello = json!({
            "jsonrpc": "2.0", "id": 0, "method": "hello",
            "params": { "relay": 1, "args": args, "env": env, "cwd": home.project, "reconnect": false },
        });
        stream.write_all(format!("{hello}\n").as_bytes())?;
        let mut read = BufReader::new(stream.try_clone()?);
        let mut answered = String::new();
        read.read_line(&mut answered)?;
        let answered: Value = serde_json::from_str(&answered)?;
        anyhow::ensure!(
            answered["result"] == json!({ "relay": 1 }),
            "the relay's hello: {answered}"
        );
        Self::initialize(Rpc::over(stream, read, |_| {})?, Server::Daemon)
    }

    /// `agent`'s MCP session through the `facade-mcp` its CLI was given.
    pub fn managed_process(home: &TestHome, agent: &str) -> anyhow::Result<Mcp> {
        Self::spawn(Self::command(home, agent)?)
    }

    /// A guest of `cli`, through a `facade-mcp` of its own.
    pub fn guest(home: &TestHome, cli: &str, env: &[(&str, &str)]) -> anyhow::Result<Mcp> {
        let mut command = home.command(&test_binaries().mcp);
        command
            .args(["--guest", cli])
            .envs(env.iter().copied())
            .env("PATH", home.path_with_test_programs());
        Self::spawn(command)
    }

    fn spawn(mut command: std::process::Command) -> anyhow::Result<Mcp> {
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .context("running facade-mcp")?;
        let read = child.stdout.take().expect("its output");
        let write = child.stdin.take().expect("its input");
        Self::initialize(
            Rpc::new(read, Box::new(write)),
            Server::Relay(Mutex::new(child)),
        )
    }

    /// The relay command `agent`'s running CLI was given.
    fn command(home: &TestHome, agent: &str) -> anyhow::Result<std::process::Command> {
        let run = facade_rules::run_folder(&home.path.join("framework/runs"), agent)
            .with_context(|| format!("{agent} has no run folder"))?;
        let config: Value = serde_json::from_str(&std::fs::read_to_string(run.join("mcp.json"))?)?;
        mcp_command(&config, &home.path, |program| home.command(program))
    }

    fn initialize(rpc: Rpc, server: Server) -> anyhow::Result<Mcp> {
        let initialized = rpc.request(
            "initialize",
            json!({
                "protocolVersion": "2025-06-18", "capabilities": {},
                "clientInfo": { "name": "storm", "version": "1" },
            }),
            Duration::from_secs(30),
        )?;
        anyhow::ensure!(
            initialized["result"]["protocolVersion"] == "2025-06-18",
            "{initialized}"
        );
        rpc.notify("notifications/initialized", json!({}))?;
        let listed = rpc.request("tools/list", json!({}), Duration::from_secs(30))?;
        anyhow::ensure!(listed["result"]["tools"].is_array(), "{listed}");
        Ok(Mcp { rpc, server })
    }

    /// Calls a tool; the receiver gets its answer.
    pub fn begin(&self, tool: &str, arguments: Value) -> Answer {
        self.rpc.begin(
            "tools/call",
            json!({ "name": tool, "arguments": arguments }),
        )
    }

    /// Calls a tool and waits for its envelope.
    pub fn call(&self, tool: &str, arguments: Value) -> anyhow::Result<Value> {
        let (_, answer) = self
            .begin(tool, arguments)
            .recv_timeout(Duration::from_secs(60))
            .with_context(|| format!("no answer to {tool}"))?;
        envelope(&answer)
    }
}

impl Drop for Mcp {
    fn drop(&mut self) {
        if let Server::Relay(child) = &self.server {
            let mut child = child.lock().unwrap();
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

/// The envelope in a tool's answer.
pub fn envelope(answer: &Value) -> anyhow::Result<Value> {
    let result = &answer["result"]["structuredContent"];
    anyhow::ensure!(result.is_object(), "not a tool's answer: {answer}");
    Ok(result.clone())
}
