//! The blocking daemon client against stand-in daemons on the system's own socket.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use facade_base::daemon::{ClientKind, DAEMON_PROTOCOL_VERSION, ScreenTopic, ScreenWatchArgs};
use facade_base::daemon_client::{DaemonClient, Identity};
use facade_base::jsonrpc::{ErrorBody, Notification, Reason, Request, Response, encode_line};
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
    let socket = TestSocket::new("hello-unread");
    let daemon = stand_in(&socket.0, |connection| async move {
        let mut connection = read_hello(connection).await;
        let answer = serde_json::json!({
            "jsonrpc": "2.0", "id": 1, "result": { "protocol": 9, "build": "9.9.9" },
        });
        let answer = format!("{answer}\n");
        connection.write_all(answer.as_bytes()).await.unwrap();
        // Held open until the client read the answer.
        let mut rest = String::new();
        let _ = connection.read_line(&mut rest).await;
    });
    let connected = DaemonClient::connect(
        &socket.0,
        &terminal(),
        Instant::now() + Duration::from_secs(5),
        &mut |_| true,
    );
    let err = connected
        .err()
        .expect("an answer this build cannot read fails");
    daemon.join().unwrap();
    let body = err
        .downcast_ref::<ErrorBody>()
        .unwrap_or_else(|| panic!("not a protocol's error: {err:#}"));
    assert_eq!(
        body.data.reason,
        Reason::ProtocolIncompatible,
        "{}",
        body.message
    );
    assert!(
        body.message.contains("build 9.9.9 and protocol 9")
            && body.message.contains(&facade_base::build_id()),
        "{}",
        body.message
    );
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
