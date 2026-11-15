use std::sync::Mutex;
use std::time::Duration;

use facade_base::daemon::HelloResult;
use facade_base::daemon_client::Identity;
use facade_base::jsonrpc::Reason;
use serde_json::json;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::unix::{OwnedReadHalf, OwnedWriteHalf};

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
            protocol: 1,
            build: "test".into(),
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

async fn send(writer: &mut OwnedWriteHalf, message: Value) {
    let line = format!("{message}\n");
    writer.write_all(line.as_bytes()).await.unwrap();
}

async fn receive(reader: &mut BufReader<OwnedReadHalf>) -> Value {
    let mut line = String::new();
    reader.read_line(&mut line).await.unwrap();
    serde_json::from_str(&line).unwrap()
}

fn open(service: &Arc<Hellos>) -> (BufReader<OwnedReadHalf>, OwnedWriteHalf) {
    let (client, server) = UnixStream::pair().unwrap();
    tokio::spawn(serve_connection(service.clone(), server));
    let (reader, writer) = client.into_split();
    (BufReader::new(reader), writer)
}

fn hello() -> Value {
    json!({
        "jsonrpc": "2.0", "id": 1, "method": "hello",
        "params": { "protocol": [1, 1], "build": "test", "kind": "terminal" },
    })
}

#[tokio::test(flavor = "multi_thread")]
async fn a_connection_made_while_a_newer_facade_takes_over_is_sent_only_its_hello_s_answer() {
    let service = Arc::new(Hellos {
        closing: watch::channel(None).0,
        draining: Mutex::new(false),
    });
    let (mut before, mut writer) = open(&service);
    send(&mut writer, hello()).await;
    assert!(receive(&mut before).await["result"].is_object());
    *service.draining.lock().unwrap() = true;
    service.closing.send_replace(Some("0.2.1".into()));
    assert_eq!(
        receive(&mut before).await["method"],
        "closing",
        "a connection past hello is told"
    );
    let (mut reader, mut writer) = open(&service);
    let mut early = String::new();
    let sent = tokio::time::timeout(Duration::from_millis(300), reader.read_line(&mut early)).await;
    assert!(sent.is_err(), "sent before hello: {early}");
    send(&mut writer, hello()).await;
    let answer = receive(&mut reader).await;
    assert_eq!(answer["error"]["data"]["reason"], "upgrading", "{answer}");
}
