use std::sync::Mutex;
use std::time::Duration;

use facade_base::daemon::{DAEMON_PROTOCOL_VERSION, HelloResult, MIN_DAEMON_PROTOCOL_VERSION};
use facade_base::daemon_client::Identity;
use facade_base::jsonrpc::Reason;
use facade_base::paths::ClientSocket;
use serde_json::json;
use std::io::{BufRead, BufReader, Write};

use super::*;

/// A service that only says hello, and takes over when told.
struct Hellos {
    closing: watch::Sender<Option<String>>,
    draining: Mutex<bool>,
}

impl Service for Hellos {
    type Hold = ();
    type Work = ();

    async fn hello(
        self: &Arc<Self>,
        hello: HelloParams,
        _: Option<u32>,
    ) -> Result<(HelloResult, Client, ()), ErrorBody> {
        let result = HelloResult {
            protocol: DAEMON_PROTOCOL_VERSION,
            build: "test".into(),
            machine_id: String::new(),
            window: None,
            pid: std::process::id(),
            agent: None,
            agents: 0,
            keeper: None,
            topics: Vec::new(),
            ops: Vec::new(),
        };
        let identity = Identity {
            kind: hello.kind,
            agent: None,
            sessions: Vec::new(),
        };
        let client = Client {
            identity,
            window: None,
            agent: None,
        };
        Ok((result, client, ()))
    }

    async fn call(
        self: &Arc<Self>,
        _: &Client,
        _: &str,
        _: Value,
        _: WhenFull,
        _: Cancel,
    ) -> Result<Value, ErrorBody> {
        Ok(json!({}))
    }

    async fn watch(
        self: &Arc<Self>,
        _: &Client,
        _: &str,
        _: Value,
        _: u64,
    ) -> Result<Watch, ErrorBody> {
        Err(ErrorBody::invalid_argument("no topics"))
    }

    async fn unwatch(self: &Arc<Self>, _: &Client, _: &str, _: u64) {}

    async fn relay(
        self: &Arc<Self>,
        _: Value,
        _: Option<u32>,
    ) -> Result<(Value, Arc<dyn RelayLines>), ErrorBody> {
        Err(ErrorBody::invalid_argument("no relays"))
    }

    fn closing(&self) -> watch::Receiver<Option<String>> {
        self.closing.subscribe()
    }

    fn draining(&self) -> Option<ErrorBody> {
        let refused = ErrorBody::new(Reason::Upgrading, "a newer Facade is taking over");
        self.draining.lock().unwrap().then_some(refused)
    }

    fn work(&self) -> Option<()> {
        Some(())
    }
}

fn send(writer: &mut ClientSocket, message: Value) {
    let line = format!("{message}\n");
    writer.write_all(line.as_bytes()).unwrap();
}

fn receive(reader: &mut BufReader<ClientSocket>) -> Value {
    let mut line = String::new();
    reader.read_line(&mut line).unwrap();
    serde_json::from_str(&line).unwrap()
}

fn open(service: &Arc<Hellos>) -> (BufReader<ClientSocket>, ClientSocket) {
    let (client, server) = facade_base::sockets::pair().unwrap();
    tokio::spawn(serve_connection(service.clone(), server));
    let writer = client.try_clone().unwrap();
    (BufReader::new(client), writer)
}

fn hello() -> Value {
    json!({
        "jsonrpc": "2.0", "id": 1, "method": "hello",
        "params": {
            "protocol": [MIN_DAEMON_PROTOCOL_VERSION, DAEMON_PROTOCOL_VERSION],
            "build": "test", "kind": "terminal"
        },
    })
}

#[tokio::test(flavor = "multi_thread")]
async fn a_connection_made_while_a_newer_facade_takes_over_is_sent_only_its_hello_s_answer() {
    let service = Arc::new(Hellos {
        closing: watch::channel(None).0,
        draining: Mutex::new(false),
    });
    let (mut before, mut writer) = open(&service);
    send(&mut writer, hello());
    assert!(receive(&mut before)["result"].is_object());
    *service.draining.lock().unwrap() = true;
    service.closing.send_replace(Some("0.2.1".into()));
    assert_eq!(
        receive(&mut before)["method"],
        "closing",
        "a connection past hello is told"
    );
    let (mut reader, mut writer) = open(&service);
    let mut early = String::new();
    let socket = reader.get_ref();
    socket
        .set_read_timeout(Some(Duration::from_millis(300)))
        .unwrap();
    let sent = reader.read_line(&mut early);
    assert!(sent.is_err(), "sent before hello: {early}");
    reader.get_ref().set_read_timeout(None).unwrap();
    send(&mut writer, hello());
    let answer = receive(&mut reader);
    assert_eq!(answer["error"]["data"]["reason"], "upgrading", "{answer}");
}
