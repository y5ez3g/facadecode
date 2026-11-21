//! Line-by-line daemon and keeper protocol connections for scenario tests.

use facade_base::paths::ClientSocket;
use facade_base::terminal::PtyMaster;
use facade_base::terminal_lines::{LineReceiver, LineSender};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};

use crate::*;

/// The normal scenario client's daemon API offer.
pub const DAEMON_API_VERSIONS: &[u32] = &[1];

/// A raw daemon protocol connection to the test's Facade home.
pub struct DaemonTestClient {
    stream: ClientSocket,
    responses: Arc<Mutex<HashMap<u64, Value>>>,
    notifications: Arc<Mutex<Vec<Value>>>,
    next: u64,
    /// Keeps the agents this client starts inside the test.
    isolation: Isolation,
}

impl DaemonTestClient {
    /// Connects to the running daemon for `home`.
    pub fn open(home: &TestHome) -> DaemonTestClient {
        DaemonTestClient::try_open(home).expect("could not connect to the test daemon")
    }

    /// Connects to the daemon for `home`, or None when none listens.
    pub fn try_open(home: &TestHome) -> Option<DaemonTestClient> {
        let stream = ClientSocket::connect(home.daemon_socket()).ok()?;
        let reader = stream.try_clone().expect("could not clone the test socket");
        let responses: Arc<Mutex<HashMap<u64, Value>>> = Arc::default();
        let notifications: Arc<Mutex<Vec<Value>>> = Arc::default();
        let (answers_in, notifications_in) = (responses.clone(), notifications.clone());
        std::thread::spawn(move || {
            for line in BufReader::new(reader).lines() {
                let Ok(line) = line else { break };
                let Ok(message) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                match message["id"].as_u64() {
                    Some(id) if message.get("method").is_none() => {
                        drop(answers_in.lock().unwrap().insert(id, message))
                    }
                    _ => notifications_in.lock().unwrap().push(message),
                }
            }
        });
        Some(DaemonTestClient {
            stream,
            responses,
            notifications,
            next: 0,
            isolation: home.isolation(),
        })
    }

    pub fn write(&mut self, message: &Value) {
        let mut message = message.clone();
        self.isolation.apply(&mut message);
        let mut line = serde_json::to_vec(&message).expect("JSON");
        line.push(b'\n');
        self.stream
            .write_all(&line)
            .expect("could not write to the test daemon");
    }

    /// Sends a method request and returns its ID, or None if the connection no longer takes
    /// requests.
    pub fn try_send(&mut self, method: &str, params: Value) -> Option<u64> {
        self.next += 1;
        let mut message =
            json!({ "jsonrpc": "2.0", "id": self.next, "method": method, "params": params });
        self.isolation.apply(&mut message);
        let mut line = serde_json::to_vec(&message).expect("JSON");
        line.push(b'\n');
        self.stream.write_all(&line).ok().map(|()| self.next)
    }

    /// Sends a method request and returns its ID.
    pub fn send(&mut self, method: &str, params: Value) -> u64 {
        self.next += 1;
        let id = self.next;
        self.write(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }));
        id
    }

    pub fn wait_for_response(&self, id: u64, timeout: Duration) -> Option<Value> {
        let mut response = None;
        wait_until(timeout, || {
            response = self.responses.lock().unwrap().get(&id).cloned();
            response.is_some()
        });
        response
    }

    /// Sends a request and waits for its response as long as a loaded machine may take.
    pub fn request(&mut self, method: &str, params: Value) -> Value {
        let what = params["op"]
            .as_str()
            .map_or_else(|| method.to_string(), |op| format!("{method} {op}"));
        let id = self.send(method, params);
        self.wait_for_response(id, LOADED_TIMEOUT)
            .unwrap_or_else(|| panic!("no response to {what} within {LOADED_TIMEOUT:?}"))
    }

    /// Sends hello with a client kind, supported APIs, and additional fields.
    pub fn hello(&mut self, kind: &str, api_versions: &[u32], more: Value) -> Value {
        let mut params = json!({ "api_versions": api_versions, "build": "test", "kind": kind });
        if let (Some(params), Some(more)) = (params.as_object_mut(), more.as_object()) {
            params.extend(more.clone());
        }
        self.request("hello", params)
    }

    /// The prerelease hello used for cutover fixtures and explicit refusal checks.
    pub fn hello_prerelease(&mut self, kind: &str, protocol: [u32; 2], more: Value) -> Value {
        let mut params = json!({ "protocol": protocol, "build": "test", "kind": kind });
        if let (Some(params), Some(more)) = (params.as_object_mut(), more.as_object()) {
            params.extend(more.clone());
        }
        self.request("hello", params)
    }

    pub fn call(&mut self, op: &str, args: Value) -> Value {
        self.request("call", json!({ "op": op, "args": args }))
    }

    pub fn call_ok(&mut self, op: &str, args: Value) -> Value {
        let response = self.call(op, args);
        response
            .get("result")
            .unwrap_or_else(|| panic!("{op} failed: {response}"))
            .clone()
    }

    /// Returns the changes received for this watch.
    pub fn changes(&self, watch: u64) -> Vec<Value> {
        self.notifications
            .lock()
            .unwrap()
            .iter()
            .filter(|n| n["method"] == "changed" && n["params"]["watch"] == watch)
            .map(|n| n["params"].clone())
            .collect()
    }
}

impl Drop for DaemonTestClient {
    /// Closes both sides of the connection, including the reader's socket copy.
    fn drop(&mut self) {
        let _ = self.stream.shutdown(std::net::Shutdown::Both);
    }
}

/// A keeper connection that keeps each line and its native terminal resource together.
pub struct KeeperTestClient {
    writer: LineSender,
    reader: LineReceiver,
    next: u64,
}

impl KeeperTestClient {
    pub fn open(home: &TestHome) -> KeeperTestClient {
        let stream = ClientSocket::connect(home.keeper_socket())
            .expect("could not connect to the test keeper");
        stream.set_read_timeout(Some(LOADED_TIMEOUT)).unwrap();
        let (pid, birth) = home
            .lock_record("keeper")
            .expect("the test keeper owns its lock");
        let identity = process_identity(pid);
        assert_eq!(
            identity.birth, birth,
            "the keeper lock names the connected process"
        );
        KeeperTestClient {
            writer: LineSender::new(stream.try_clone().unwrap(), &identity).unwrap(),
            reader: LineReceiver::new(stream),
            next: 0,
        }
    }

    pub fn send(&mut self, method: &str, params: Value, terminal: Option<&PtyMaster>) -> u64 {
        self.next += 1;
        let id = self.next;
        let message = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        self.writer
            .send(format!("{message}\n").as_bytes(), terminal)
            .unwrap();
        id
    }

    pub fn receive(&mut self) -> (Value, Option<PtyMaster>) {
        let (line, terminal) = self
            .reader
            .next_line()
            .expect("could not read the keeper line")
            .expect("the keeper closed the connection");
        (
            serde_json::from_slice(&line).expect("keeper JSON"),
            terminal,
        )
    }

    /// Requires the very next line to be the response, so an early exit notification fails.
    pub fn request(
        &mut self,
        method: &str,
        params: Value,
        terminal: Option<&PtyMaster>,
    ) -> (Value, Option<PtyMaster>) {
        let id = self.send(method, params, terminal);
        let (reply, received) = self.receive();
        assert_eq!(
            reply["id"], id,
            "expected the reply before another frame: {reply}"
        );
        (reply, received)
    }

    pub fn call(
        &mut self,
        op: &str,
        args: Value,
        terminal: Option<&PtyMaster>,
    ) -> (Value, Option<PtyMaster>) {
        self.request("call", json!({ "op": op, "args": args }), terminal)
    }
}

pub fn error_reason(response: &Value) -> &str {
    response["error"]["data"]["reason"]
        .as_str()
        .unwrap_or_default()
}

/// Starts the daemon if needed and connects to it. As `facade` does, it tries until a daemon
/// answers: one that exits while idle between the check and the connection is started anew.
pub fn connect(home: &TestHome) -> DaemonTestClient {
    let until = std::time::Instant::now() + LOADED_TIMEOUT;
    loop {
        if home.hello_result().is_none() {
            home.run_facade_ok(&["daemon", "--detach"]);
            wait_until(secs(10), || home.hello_result().is_some());
        }
        if let Some(mut wire) = DaemonTestClient::try_open(home) {
            let hello = wire.send(
                "hello",
                json!({ "api_versions": DAEMON_API_VERSIONS, "build": "test", "kind": "terminal" }),
            );
            if wire
                .wait_for_response(hello, secs(10))
                .is_some_and(|welcome| welcome["result"]["api_version"] == 1)
            {
                return wire;
            }
        }
        assert!(
            std::time::Instant::now() < until,
            "could not connect to the test daemon: {}",
            home.daemon_log()
        );
    }
}

/// Starts [`shell`], the custom program [`TestHome::shell_cli`], with `script` as agent `name` in
/// the test project. Sets `FACADE_HOME` so cleanup can find the process. Returns the agent ID.
pub fn start_script(
    wire: &mut DaemonTestClient,
    home: &TestHome,
    name: &str,
    script: &str,
) -> String {
    #[cfg(unix)]
    let path = "/usr/bin:/bin".to_string();
    #[cfg(windows)]
    let path = system_folders().join(PATH_SEPARATOR);
    let args = json!({
        "cli": home.shell_cli(), "args": ["-c", script], "name": name, "folder": home.project,
        "env": { "PATH": path, "FACADE_HOME": home.path }, "size": { "cols": 80, "rows": 24 },
    });
    let started = wire.call("agent.start", args);
    started["result"]["agent"]["reference"]["agent_id"]
        .as_str()
        .unwrap_or_else(|| panic!("{name} did not start: {started}"))
        .to_string()
}

/// Sends `keys` as raw bytes, as an attached terminal does, in a call with an ID.
pub fn type_raw(wire: &mut DaemonTestClient, agent: &str, keys: &str) {
    let inspected = wire.call_ok("agent.inspect", json!({ "target": agent }));
    let reference = &inspected["agent"]["reference"];
    let typed = wire.call(
        "agent.type",
        json!({ "target": reference, "input": { "kind": "raw", "raw": facade_base::base64::encode(keys.as_bytes()) } }),
    );
    assert!(typed["result"].is_object(), "{typed}");
}

pub fn wait_for_screen_text(home: &TestHome, agent: &str, text: &str) -> bool {
    wait_until(secs(30), || home.screen(agent).contains(text))
}

/// A connection read only when the test requests the next line.
pub struct ManualReadClient {
    pub writer: ClientSocket,
    reader: BufReader<ClientSocket>,
    /// Keeps the agents this client starts inside the test.
    isolation: Isolation,
}

impl ManualReadClient {
    pub fn open(home: &TestHome) -> ManualReadClient {
        let stream = ClientSocket::connect(home.daemon_socket())
            .expect("could not connect to the test daemon");
        stream.set_read_timeout(Some(LOADED_TIMEOUT)).unwrap();
        let mut raw = ManualReadClient {
            writer: stream.try_clone().unwrap(),
            reader: BufReader::new(stream),
            isolation: home.isolation(),
        };
        raw.send(
            0,
            "hello",
            json!({ "api_versions": DAEMON_API_VERSIONS, "build": "test", "kind": "terminal" }),
        );
        assert!(
            raw.read_message()
                .is_some_and(|response| response["result"]["api_version"] == 1)
        );
        raw
    }

    pub fn send(&mut self, id: u64, method: &str, params: Value) {
        let mut message = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        self.isolation.apply(&mut message);
        self.writer
            .write_all(format!("{message}\n").as_bytes())
            .unwrap();
    }

    pub fn set_read_timeout(&mut self, timeout: Duration) {
        self.reader
            .get_ref()
            .set_read_timeout(Some(timeout))
            .unwrap();
    }

    /// Returns the next line, or None on disconnect or read timeout.
    pub fn read_message(&mut self) -> Option<Value> {
        let mut line = String::new();
        match self.reader.read_line(&mut line) {
            Ok(0) | Err(_) => None,
            Ok(_) => serde_json::from_str(&line).ok(),
        }
    }
}
