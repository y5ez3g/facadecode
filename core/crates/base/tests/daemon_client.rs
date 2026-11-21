//! The blocking daemon client against stand-in daemons on the system's own socket.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use facade_base::api_v1::daemon::{AgentTarget, AttachArgs, AttachTopic};
use facade_base::api_v1::daemon_client::DaemonClient;
use facade_base::api_v1::{ErrorBody, ErrorData, Notification, Request, Response, encode_line};
use facade_base::sockets::{DaemonListener, ServerSocket};
use serde_json::json;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

/// A stand-in daemon's socket, for a home named after the test and this process: a file in this
/// user's socket folder on Unix, removed when the test ends, or a named pipe on Windows.
struct TestSocket(PathBuf);

impl TestSocket {
    fn new(name: &str) -> TestSocket {
        let home = std::env::temp_dir().join(format!("facade-{name}-{}", std::process::id()));
        let path = facade_base::paths::daemon_socket_for(&home).unwrap();
        let _ = std::fs::remove_file(&path);
        TestSocket(path)
    }
}

impl Drop for TestSocket {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// Serves one connection on `socket` with `serve`, on a thread of its own, once it listens.
fn stand_in<F, Fut>(socket: &Path, serve: F) -> std::thread::JoinHandle<()>
where
    F: FnOnce(ServerSocket) -> Fut + Send + 'static,
    Fut: Future<Output = ()>,
{
    let socket = socket.to_owned();
    let (listening, listens) = std::sync::mpsc::channel();
    let daemon = std::thread::spawn(move || {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async move {
            let mut listener = DaemonListener::bind(&socket).unwrap();
            listening.send(()).unwrap();
            serve(listener.accept().await.unwrap()).await;
        });
    });
    listens.recv().unwrap();
    daemon
}

/// Reads the client's hello, and returns the rest of the connection.
async fn read_hello(connection: ServerSocket) -> BufReader<ServerSocket> {
    let mut connection = BufReader::new(connection);
    let mut hello = String::new();
    connection.read_line(&mut hello).await.unwrap();
    connection
}

/// A peer may close as soon as it writes a valid hello, even before the client can reset the
/// socket timeout. Connecting must still return normally.
#[test]
fn a_daemon_that_closes_right_after_hello_does_not_fail_connection() {
    let socket = TestSocket::new("hello-closed");
    let daemon = stand_in(&socket.0, |connection| async move {
        let mut connection = read_hello(connection).await;
        let answer = Response::ok(1, api_v1_hello_result(1));
        connection.write_all(&encode_line(&answer)).await.unwrap();
    });
    let connected = DaemonClient::connect(
        &socket.0,
        Instant::now() + Duration::from_secs(5),
        &mut |_| true,
    );
    daemon.join().unwrap();
    assert!(connected.is_ok(), "{:?}", connected.err());
}

/// A daemon that closes the connection before hello is no daemon yet.
#[test]
fn a_daemon_that_closed_the_connection_before_hello_is_no_daemon_yet() {
    let socket = TestSocket::new("hello-unanswered");
    let mut daemon = Some(stand_in(&socket.0, |connection| async move {
        drop(connection);
    }));
    let connected = DaemonClient::connect(
        &socket.0,
        Instant::now() + Duration::from_secs(5),
        &mut |_| {
            daemon.take().unwrap().join().unwrap();
            true
        },
    );
    assert!(daemon.is_none(), "the peer must close before hello");
    assert!(
        matches!(connected, Ok(None)),
        "{:?}",
        connected.map(|client| client.is_some())
    );
}

#[test]
fn a_caller_that_manages_reconnection_receives_the_upgrading_refusal() {
    let socket = TestSocket::new("watch-upgrading");
    let refusal = ErrorBody {
        code: -32000,
        message: "a newer daemon is taking over".into(),
        data: ErrorData {
            reason: "upgrading".into(),
            details: None,
        },
    };
    let response_error = refusal.clone();
    let daemon = stand_in(&socket.0, move |connection| async move {
        let mut connection = read_hello(connection).await;
        let mut hello = api_v1_hello_result(1);
        hello["build"] = json!("0.2.0");
        hello["topics"] = json!(["attach"]);
        let mut greeting = encode_line(&Response::ok(1, hello));
        greeting.extend(encode_line(&Notification::new(
            "closing",
            json!({ "build": "0.2.1" }),
        )));
        connection.write_all(&greeting).await.unwrap();

        let mut line = String::new();
        connection.read_line(&mut line).await.unwrap();
        let watch: Request = serde_json::from_str(&line).unwrap();
        assert_eq!(watch.method, "watch");
        assert_eq!(
            watch.params,
            json!({
                "topic": "attach",
                "args": { "target": "a1", "keep_scrollback": true, "include_scrollback": false },
            })
        );
        let id = watch.id.expect("the watch request ID");
        let answer = Response::failed(Some(id), response_error);
        connection.write_all(&encode_line(&answer)).await.unwrap();
        line.clear();
        connection.read_line(&mut line).await.unwrap();
        let closing: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(
            closing,
            json!({ "jsonrpc": "2.0", "method": "closing", "params": {} })
        );
        line.clear();
        assert_eq!(connection.read_line(&mut line).await.unwrap(), 0);
    });
    let mut client = DaemonClient::connect(
        &socket.0,
        Instant::now() + Duration::from_secs(5),
        &mut |_| true,
    )
    .unwrap()
    .unwrap();
    client.disable_auto_reconnect();
    let err = client
        .watch::<AttachTopic>(AttachArgs {
            target: AgentTarget::Selector("a1".into()),
            size: None,
            viewer: None,
            keep_scrollback: true,
            include_scrollback: false,
            allow_ended: false,
            report_activity: false,
        })
        .unwrap_err();
    assert_eq!(err.downcast_ref::<ErrorBody>(), Some(&refusal));
    assert_eq!(client.closing.as_deref(), Some("0.2.1"));
    drop(client);
    daemon.join().unwrap();
}

// The v1 hello, authorization and first bytes of the admitted machine stream share one socket.
#[test]
fn api_v1_machine_handoff_preserves_the_buffered_peer_line() {
    use facade_base::api_v1::daemon::{
        ConnectionKind, MachineConnect, MachineConnectArgs, MachineTransport, MachineTransportInput,
    };
    use facade_base::api_v1::daemon_client::DaemonClient as ApiClient;
    use std::io::BufRead as _;

    let socket = TestSocket::new("api-v1-machine-handoff");
    let peer_hello = concat!(
        "{\"jsonrpc\":\"2.0\", \"id\":83, \"method\":\"hello\", \"params\":",
        "{\"api_versions\":[1],\"build\":\"peer-build\",\"kind\":\"machine\",",
        "\"machine\":{\"machine_id\":\"11111111-1111-4111-8111-111111111111\",",
        "\"boot_id\":\"22222222-2222-4222-8222-222222222222\",\"name\":\"peer\"}}}\n",
    );
    let daemon = stand_in(&socket.0, move |connection| async move {
        let mut connection = BufReader::new(connection);
        let mut line = String::new();
        connection.read_line(&mut line).await.unwrap();
        let hello: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(
            hello,
            json!({
                "jsonrpc": "2.0", "id": 1, "method": "hello",
                "params": {
                    "api_versions": [1], "build": facade_base::build_id(), "kind": "terminal"
                }
            }),
        );
        let answer = facade_base::api_v1::Response::ok(1, api_v1_hello_result(1));
        connection
            .write_all(&facade_base::api_v1::encode_line(&answer))
            .await
            .unwrap();

        line.clear();
        connection.read_line(&mut line).await.unwrap();
        let call: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(call["params"]["op"], "machine.connect");
        assert_eq!(
            call["params"]["args"]["transport"],
            json!({"kind":"bridge"})
        );
        let id = call["id"].as_u64().unwrap();
        let answer = facade_base::api_v1::Response::ok(id, json!({"transport":{"kind":"bridge"}}));
        let mut bytes = facade_base::api_v1::encode_line(&answer);
        bytes.extend_from_slice(peer_hello.as_bytes());
        connection.write_all(&bytes).await.unwrap();
        line.clear();
        let _ = connection.read_line(&mut line).await;
    });

    let until = Instant::now() + Duration::from_secs(5);
    let mut client = ApiClient::connect(&socket.0, until, &mut |_| true)
        .unwrap()
        .expect("v1 daemon hello");
    let authorized = client
        .call::<MachineConnect>(MachineConnectArgs {
            transport: MachineTransportInput::Bridge,
            kind: ConnectionKind::Temporary,
            expected_machine_id: None,
        })
        .unwrap();
    assert!(matches!(authorized.transport, MachineTransport::Bridge));
    let (mut reader, writer) = client.into_stream();
    let mut line = String::new();
    reader.read_line(&mut line).unwrap();
    assert_eq!(line, peer_hello);
    drop(reader);
    drop(writer);
    daemon.join().unwrap();
}

#[test]
fn api_v1_client_refuses_a_selected_version_outside_its_offer() {
    use facade_base::api_v1::daemon_client::DaemonClient as ApiClient;
    use facade_base::api_v1::{ErrorBody as ApiError, Response as ApiResponse};

    let socket = TestSocket::new("api-v1-unoffered-version");
    let daemon = stand_in(&socket.0, |connection| async move {
        let mut connection = read_hello(connection).await;
        let answer = ApiResponse::ok(1, api_v1_hello_result(2));
        connection
            .write_all(&facade_base::api_v1::encode_line(&answer))
            .await
            .unwrap();
        let mut ignored = String::new();
        let _ = connection.read_line(&mut ignored).await;
    });

    let until = Instant::now() + Duration::from_secs(5);
    let error = ApiClient::connect(&socket.0, until, &mut |_| true)
        .err()
        .expect("unoffered API selection must fail");
    assert_eq!(
        error.downcast_ref::<ApiError>().unwrap().data.reason,
        "protocol_incompatible",
    );
    daemon.join().unwrap();
}

fn api_v1_hello_result(version: u64) -> serde_json::Value {
    json!({
        "api_version": version, "build": "9.9.9+fixture", "pid": 1, "agent_count": 0,
        "machine_id": "3f2504e0-4f89-41d3-9a0c-0305e82c3301", "topics": [], "ops": []
    })
}
