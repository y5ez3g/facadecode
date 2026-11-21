//! The blocking daemon client against stand-in daemons on the system's own socket.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use facade_base::daemon::{ClientKind, DAEMON_PROTOCOL_VERSION, ScreenTopic, ScreenWatchArgs};
use facade_base::daemon_client::{DaemonClient, Identity, UpgradeClient};
use facade_base::jsonrpc::{ErrorBody, Notification, Reason, Request, Response, encode_line};
use facade_base::sockets::{DaemonListener, ServerSocket};
use facade_base::v3;
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

fn terminal() -> Identity {
    Identity {
        kind: ClientKind::Terminal,
        agent: None,
        sessions: Vec::new(),
    }
}

/// Reads the client's hello, and returns the rest of the connection.
async fn read_hello(connection: ServerSocket) -> BufReader<ServerSocket> {
    let mut connection = BufReader::new(connection);
    let mut hello = String::new();
    connection.read_line(&mut hello).await.unwrap();
    connection
}

/// A daemon whose answer to hello this build cannot read is another protocol's: the client says
/// so, naming both builds, and panics at nothing a peer sends.
#[test]
fn an_answer_to_hello_this_build_cannot_read_is_another_protocol_s() {
    let legacy_range = [DAEMON_PROTOCOL_VERSION; 2];
    for (range, selected) in [
        (legacy_range, 9),
        (v3::DAEMON_PROTOCOL_RANGE, DAEMON_PROTOCOL_VERSION),
        (v3::TAKEOVER_DAEMON_PROTOCOL_RANGE, 9),
    ] {
        let socket = TestSocket::new(&format!("hello-unread-{}-{}", range[0], range[1]));
        let mut identity = terminal();
        identity.agent = Some("a1".into());
        identity.sessions = vec!["session-1".into()];
        let daemon = stand_in(&socket.0, move |connection| async move {
            let mut connection = BufReader::new(connection);
            let mut line = String::new();
            connection.read_line(&mut line).await.unwrap();
            let request: Request = serde_json::from_str(&line).unwrap();
            assert_eq!(request.method, "hello");
            let mut expected =
                json!({ "protocol": range, "build": facade_base::build_id(), "kind": "terminal" });
            if range == legacy_range {
                expected["agent"] = json!("a1");
                expected["sessions"] = json!(["session-1"]);
            }
            let result = if range == v3::DAEMON_PROTOCOL_RANGE {
                expected["capabilities"] = json!([
                    v3::CAP_MACHINE_DISCONNECTED,
                    v3::CAP_ATTACH,
                    v3::CAP_MACHINE_CONNECT_EXPECTED_ID,
                    v3::CAP_RESUME_LIST_LOCAL
                ]);
                json!({
                    "protocol": selected, "build": "9.9.9", "pid": 1, "agents": 0,
                    "machine_id": "3f2504e0-4f89-41d3-9a0c-0305e82c3301", "topics": [], "ops": [],
                })
            } else {
                json!({ "protocol": selected, "build": "9.9.9" })
            };
            assert_eq!(request.params, expected);
            let answer = Response::ok(request.id.unwrap(), result);
            connection.write_all(&encode_line(&answer)).await.unwrap();
            // Hold the connection open until the client read the answer.
            line.clear();
            let _ = connection.read_line(&mut line).await;
        });
        let until = Instant::now() + Duration::from_secs(5);
        let err = if range == v3::TAKEOVER_DAEMON_PROTOCOL_RANGE {
            UpgradeClient::connect(&socket.0, until, &mut |_| true).err()
        } else {
            let connect = if range == legacy_range {
                DaemonClient::connect
            } else {
                DaemonClient::connect_v3
            };
            connect(&socket.0, &identity, until, &mut |_| true).err()
        }
        .expect("an incompatible hello must fail");
        daemon.join().unwrap();
        let body = err.downcast_ref::<ErrorBody>().unwrap();
        assert_eq!(
            body.data.reason,
            Reason::IncompatibleProtocol,
            "{}",
            body.message
        );
        assert!(
            body.message
                .contains(&format!("build 9.9.9 and protocol {selected}"))
                && body.message.contains(&facade_base::build_id()),
            "{}",
            body.message
        );
    }
}

/// A daemon that closes right after it answers hello, as one handing over does, is no daemon
/// yet: the client goes on to the next one, though macOS refuses the options of a socket whose
/// peer closed.
#[test]
fn a_daemon_that_closes_right_after_its_hello_is_no_daemon_yet() {
    let socket = TestSocket::new("hello-closed");
    let daemon = stand_in(&socket.0, |connection| async move {
        let mut connection = read_hello(connection).await;
        let answer = serde_json::json!({
            "jsonrpc": "2.0", "id": 1,
            "result": {
                "protocol": DAEMON_PROTOCOL_VERSION, "build": "0.2.0", "pid": 1, "agents": 0,
                "machine_id": "3f2504e0-4f89-41d3-9a0c-0305e82c3301", "topics": [], "ops": [],
            },
        });
        let answer = format!("{answer}\n");
        connection.write_all(answer.as_bytes()).await.unwrap();
        // The connection closes here, before the client reads the answer.
    });
    let connected = DaemonClient::connect(
        &socket.0,
        &terminal(),
        Instant::now() + Duration::from_secs(5),
        &mut |_| true,
    );
    daemon.join().unwrap();
    assert!(connected.is_ok(), "{:?}", connected.err());
}

/// A daemon that closed the connection before hello, as one that ends before it took the
/// connection does, is no daemon yet.
#[test]
fn a_daemon_that_closed_the_connection_before_hello_is_no_daemon_yet() {
    let socket = TestSocket::new("hello-unanswered");
    let mut daemon = Some(stand_in(&socket.0, |connection| async move {
        drop(connection);
    }));
    // The client goes on once the daemon closed the connection.
    let connected = DaemonClient::connect(
        &socket.0,
        &terminal(),
        Instant::now() + Duration::from_secs(5),
        &mut |_| {
            daemon.take().unwrap().join().unwrap();
            true
        },
    );
    assert!(
        matches!(connected, Ok(None)),
        "{:?}",
        connected.map(|client| client.is_some())
    );
}

#[test]
fn a_caller_that_manages_reconnection_receives_the_upgrading_refusal() {
    let socket = TestSocket::new("watch-upgrading");
    let refusal = ErrorBody::new(Reason::Upgrading, "a newer daemon is taking over");
    let response_error = refusal.clone();
    let daemon = stand_in(&socket.0, |connection| async move {
        let mut connection = read_hello(connection).await;
        let mut greeting = encode_line(&Response::ok(
            1,
            json!({
                "protocol": DAEMON_PROTOCOL_VERSION, "build": "0.2.0", "pid": 1, "agents": 0,
                "machine_id": "3f2504e0-4f89-41d3-9a0c-0305e82c3301", "topics": ["screen"], "ops": [],
            }),
        ));
        greeting.extend(encode_line(&Notification::new(
            "closing",
            json!({"build": "0.2.1"}),
        )));
        connection.write_all(&greeting).await.unwrap();

        let mut line = String::new();
        connection.read_line(&mut line).await.unwrap();
        let watch: Request = serde_json::from_str(&line).unwrap();
        assert_eq!(watch.method, "watch");
        let answer = Response::failed(watch.id, response_error);
        connection.write_all(&encode_line(&answer)).await.unwrap();
        line.clear();
        connection.read_line(&mut line).await.unwrap();
        let closing: Notification = serde_json::from_str(&line).unwrap();
        assert_eq!(closing.method, "closing");
    });
    let mut client = DaemonClient::connect(
        &socket.0,
        &terminal(),
        Instant::now() + Duration::from_secs(5),
        &mut |_| true,
    )
    .unwrap()
    .unwrap();
    client.disable_auto_reconnect();
    let err = client
        .watch::<ScreenTopic>(ScreenWatchArgs {
            agent: "a1".into(),
            keep_scrollback: true,
            include_scrollback: false,
        })
        .unwrap_err();
    assert_eq!(err.downcast_ref::<ErrorBody>(), Some(&refusal));
    assert_eq!(client.closing.as_deref(), Some("0.2.1"));
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
