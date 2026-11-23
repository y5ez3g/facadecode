use std::convert::Infallible;
use std::sync::Mutex;
use std::time::Duration;

use facade_base::api_v1::daemon::SUPPORTED_API_VERSIONS;
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
    type Machine = Infallible;

    async fn hello(
        self: &Arc<Self>,
        hello: HelloParams,
        api_version: ApiVersion,
        _: Option<u32>,
    ) -> Result<(HelloResult, Client, ()), ErrorBody> {
        let result = HelloResult {
            machine: None,
            api_version,
            build: "test".into(),
            machine_id: String::new(),
            pid: std::process::id(),
            agent_count: 0,
            keeper: None,
            topics: Vec::new(),
            ops: Vec::new(),
        };
        let client = Client {
            kind: hello.kind,
            api_version,
            verified_actor: None,
        };
        Ok((result, client, ()))
    }

    async fn machine_hello(
        self: &Arc<Self>,
        _: HelloParams,
        _: ApiVersion,
        _: Option<u32>,
    ) -> Result<(HelloResult, Self::Machine), ErrorBody> {
        Err(ErrorBody::invalid_argument("no machine sessions"))
    }

    async fn machine_connect(
        self: &Arc<Self>,
        _: &Client,
        _: MachineConnectArgs,
    ) -> Result<(MachineConnectResult, Self::Machine), ErrorBody> {
        Err(ErrorBody::invalid_argument("no machine sessions"))
    }

    async fn serve_machine(
        self: &Arc<Self>,
        machine: Self::Machine,
        _: tokio::io::BufReader<ServerReader>,
        _: ServerWriter,
    ) -> anyhow::Result<()> {
        match machine {}
    }

    async fn call(
        self: &Arc<Self>,
        _: &Client,
        _: DaemonCall,
        _: WhenFull,
        _: Cancel,
    ) -> Result<Value, ErrorBody> {
        Ok(json!({}))
    }

    async fn watch(
        self: &Arc<Self>,
        _: &Client,
        _: DaemonWatch,
        _: u64,
    ) -> Result<Watch, ErrorBody> {
        Err(ErrorBody::invalid_argument("no topics"))
    }

    async fn resize_viewer(
        self: &Arc<Self>,
        _: &Client,
        _: u64,
        _: Size,
        _: Option<TerminalColors>,
    ) -> Result<(), ErrorBody> {
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
        let refused = operation_error("upgrading", "a newer Facade is taking over");
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
            "api_versions": SUPPORTED_API_VERSIONS,
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
    assert_eq!(receive(&mut before)["result"]["api_version"], 1);
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

#[tokio::test(start_paused = true)]
async fn an_idless_closing_ends_the_stream_before_the_fallback() {
    let service = Arc::new(Hellos {
        closing: watch::channel(None).0,
        draining: Mutex::new(false),
    });
    let (mut acknowledged, mut ack_writer) = open(&service);
    let (mut unacknowledged, mut control_writer) = open(&service);
    let mut unacknowledged = tokio::task::spawn_blocking(move || {
        // Blocking I/O prevents the paused Tokio clock from auto-advancing.
        for (reader, writer) in [
            (&mut acknowledged, &mut ack_writer),
            (&mut unacknowledged, &mut control_writer),
        ] {
            reader
                .get_ref()
                .set_read_timeout(Some(Duration::from_secs(10)))
                .unwrap();
            send(writer, hello());
            assert_eq!(receive(reader)["result"]["api_version"], 1);
        }
        let before_fallback = tokio::time::Instant::now();
        *service.draining.lock().unwrap() = true;
        service.closing.send_replace(Some("0.2.1".into()));
        let announcement = json!({
            "jsonrpc": "2.0", "method": "closing", "params": { "build": "0.2.1" }
        });
        assert_eq!(receive(&mut acknowledged), announcement);
        assert_eq!(receive(&mut unacknowledged), announcement);

        send(
            &mut ack_writer,
            json!({ "jsonrpc": "2.0", "method": "closing", "params": {} }),
        );
        assert_eq!(
            acknowledged
                .read_line(&mut String::new())
                .expect("the id-less acknowledgment closes the stream with the clock paused"),
            0
        );

        send(
            &mut control_writer,
            json!({ "jsonrpc": "2.0", "id": 2, "method": "closing", "params": {} }),
        );
        let rejected = receive(&mut unacknowledged);
        assert_eq!(rejected["id"], 2, "{rejected}");
        assert_eq!(
            rejected["error"]["message"], "closing is a notification",
            "{rejected}"
        );
        assert_eq!(tokio::time::Instant::now(), before_fallback);
        unacknowledged
    })
    .await
    .unwrap();

    // Without an accepted acknowledgment the same server eventually closes its control stream.
    tokio::time::advance(Duration::from_secs(1)).await;
    tokio::task::spawn_blocking(move || {
        assert_eq!(unacknowledged.read_line(&mut String::new()).unwrap(), 0);
    })
    .await
    .unwrap();
}
