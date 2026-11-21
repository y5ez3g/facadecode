//! Line-by-line daemon and keeper protocol connections for scenario tests.

use facade_base::daemon::WindowRef;
use facade_base::paths::ClientSocket;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};

use crate::*;

/// Ordinary scenario clients use v3. The real v2 fixture negotiates its own range.
pub const DAEMON_RANGE: [u32; 2] = [3, 3];

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

    /// Sends hello with a client kind, version range, and additional fields.
    pub fn hello(&mut self, kind: &str, protocol: [u32; 2], more: Value) -> Value {
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

/// A raw keeper protocol connection to the test's Facade home.
pub struct KeeperTestClient {
    writer: ClientSocket,
    pub reader: BufReader<ClientSocket>,
    next: u64,
}

impl KeeperTestClient {
    pub fn open(home: &TestHome) -> KeeperTestClient {
        let stream = ClientSocket::connect(home.keeper_socket())
            .expect("could not connect to the test keeper");
        stream.set_read_timeout(Some(LOADED_TIMEOUT)).unwrap();
        KeeperTestClient {
            writer: stream.try_clone().unwrap(),
            reader: BufReader::new(stream),
            next: 0,
        }
    }

    /// Sends a request and waits for its response as long as a loaded machine may take.
    pub fn request(&mut self, method: &str, params: Value) -> Value {
        self.next += 1;
        let id = self.next;
        self.writer
            .write_all(
                format!(
                    "{}\n",
                    json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })
                )
                .as_bytes(),
            )
            .unwrap();
        loop {
            let mut line = String::new();
            assert!(
                self.reader
                    .read_line(&mut line)
                    .expect("could not read the keeper response")
                    > 0,
                "the keeper closed the connection"
            );
            let message: Value = serde_json::from_str(&line).expect("JSON");
            if message["id"] == id {
                return message;
            }
        }
    }

    pub fn call(&mut self, op: &str, args: Value) -> Value {
        self.request("call", json!({ "op": op, "args": args }))
    }
}

pub fn error_reason(response: &Value) -> &str {
    response["error"]["data"]["reason"]
        .as_str()
        .unwrap_or_default()
}

/// An editor window's client, describing `window`, with Facade started first where it is not
/// running. The window's description may give its `colors` and `env`.
pub fn ide(home: &TestHome, window: &Value) -> DaemonTestClient {
    ide_with(home, window, json!({}))
}

/// As [`ide`], with more fields of `hello`, such as `numbers_given`.
pub fn ide_with(home: &TestHome, window: &Value, more: Value) -> DaemonTestClient {
    ide_hello(home, window, more).0
}

/// An editor client and the logical window bound by its hello.
pub fn ide_binding(home: &TestHome, window: &Value) -> (DaemonTestClient, WindowRef) {
    let (wire, welcome) = ide_hello(home, window, json!({}));
    let binding: WindowRef = serde_json::from_value(welcome["window"].clone())
        .unwrap_or_else(|error| panic!("hello did not bind a logical window: {error}: {welcome}"));
    assert_eq!(welcome["machine_id"], binding.machine_id, "{welcome}");
    (wire, binding)
}

fn ide_hello(home: &TestHome, window: &Value, more: Value) -> (DaemonTestClient, Value) {
    drop(connect(home));
    let mut wire = DaemonTestClient::open(home);
    let mut params = json!({ "window": window });
    if let (Some(params), Some(more)) = (params.as_object_mut(), more.as_object()) {
        params.extend(more.clone());
    }
    let welcome = wire.hello("ide", DAEMON_RANGE, params);
    assert!(welcome["result"].is_object(), "{welcome}");
    (wire, welcome["result"].clone())
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
                json!({ "protocol": DAEMON_RANGE, "build": "test", "kind": "terminal" }),
            );
            if wire
                .wait_for_response(hello, secs(10))
                .is_some_and(|welcome| welcome["result"].is_object())
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
        "env": { "PATH": path, "FACADE_HOME": home.path }, "cols": 80, "rows": 24,
    });
    let started = wire.call("agent.start", args);
    started["result"]["agent"]["agent_id"]
        .as_str()
        .unwrap_or_else(|| panic!("{name} did not start: {started}"))
        .to_string()
}

/// Sends `keys` as raw bytes, as an attached terminal does, in a call with an ID.
pub fn type_raw(wire: &mut DaemonTestClient, agent: &str, keys: &str) {
    let typed = wire.call(
        "agent.type",
        json!({ "agent": agent, "raw": facade_base::base64::encode(keys.as_bytes()) }),
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
            json!({ "protocol": DAEMON_RANGE, "build": "test", "kind": "terminal" }),
        );
        assert!(
            raw.read_message()
                .is_some_and(|response| response["result"].is_object())
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
