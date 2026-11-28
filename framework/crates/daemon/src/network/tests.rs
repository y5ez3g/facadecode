use facade_base::api_v1::daemon::SshTransport;
use facade_base::api_v1::{MachineMessage, Response};
use tokio::io::{BufReader, duplex, split};

use super::*;

fn machine(name: &str, id: u32) -> (Network, mpsc::UnboundedReceiver<Event>) {
    let (events, receiver) = mpsc::unbounded_channel();
    let network = Network::new(
        ConnectedMachine {
            machine_id: format!("{id:08x}-0000-4000-8000-000000000000"),
            boot_id: format!("{id:08x}-0000-4000-8000-000000000001"),
            name: name.into(),
            build: "test".into(),
            ssh_cleans_processes: None,
        },
        None,
        events,
    );
    (network, receiver)
}

fn foreground(destination: &str) -> Origin {
    Origin::Front(FrontConnection {
        transport: MachineTransport::Ssh(SshTransport {
            ssh_destination: destination.into(),
            ssh_args: vec![destination.into()],
            remote_home: None,
        }),
        expected_machine_id: None,
        kind: ConnectionKind::Temporary,
    })
}

fn activate(
    local: &Network,
    remote: &Network,
    origin: Origin,
) -> (Registered, mpsc::UnboundedReceiver<Output>) {
    let greeting = MachineGreeting {
        machine: remote.local_hello(),
        api_version: ApiVersion::MIN,
        foreground: true,
    };
    let (link, output) = local
        .reserve(greeting, origin, advertise::encode(remote.machines()))
        .unwrap();
    link.activate().unwrap();
    (link, output)
}

fn mirror(link: &Registered, remote: &Network) {
    link.network
        .replace_table(
            link.id,
            serde_json::to_value(advertise::encode(remote.machines())).unwrap(),
        )
        .unwrap();
}

fn direct(local: &Network, remote: &Network) -> Option<Arc<Peer>> {
    let remote_id = remote.local_hello().machine_id;
    local.0.state.lock().unwrap().direct(&remote_id).cloned()
}

#[tokio::test]
async fn reconnect_does_not_route_to_a_disconnected_stream() {
    for standby_destination in [None, Some("standby")] {
        let (local, _) = machine("local", 1);
        let (remote, _) = machine("remote", 2);
        let (original, _stalled_stream) = activate(&local, &remote, foreground("primary"));
        let (incoming, _) = activate(&remote, &local, Origin::Incoming);
        mirror(&original, &remote);

        let standby = standby_destination.map(|destination| {
            let (link, output) = activate(&local, &remote, foreground(destination));
            let (incoming, _) = activate(&remote, &local, Origin::Incoming);
            (link, output, incoming)
        });

        // Shut only the peer's end, as when the local SSH process still holds its old pipe open.
        drop(incoming);
        if let Some((link, _, _)) = &standby {
            mirror(link, &remote);
        }
        let (replacement, _stream) = activate(&local, &remote, foreground("primary"));
        let current = direct(&local, &remote).unwrap();
        assert!(
            !Arc::ptr_eq(&current, &original.peer),
            "the route should leave the disconnected stream with standby {standby_destination:?}"
        );
        drop(replacement);
        if let Some((link, _, _)) = &standby {
            let fallback = direct(&local, &remote).unwrap();
            assert!(Arc::ptr_eq(&fallback, &link.peer));
        }
        drop(standby);
        assert!(direct(&local, &remote).is_none());
    }
}

#[tokio::test]
async fn a_parallel_foreground_link_remains_a_fallback_after_its_reply() {
    let (local, mut events) = machine("local", 1);
    let (remote, _) = machine("remote", 2);
    let (original, output) = activate(&local, &remote, foreground("primary"));
    let (_incoming, _) = activate(&remote, &local, Origin::Incoming);
    mirror(&original, &remote);
    let first_peer = original.peer.clone();
    let (session, tester) = duplex(4096);
    let (read, write) = split(session);
    let (tester_read, mut tester_write) = split(tester);
    let session = tokio::spawn(async move {
        original
            .run(Reader::new(BufReader::new(read)), write, output)
            .await
            .unwrap();
    });

    let (parallel, _stream) = activate(&local, &remote, foreground("primary"));
    let selected = direct(&local, &remote).unwrap();
    assert!(Arc::ptr_eq(&selected, &parallel.peer));

    tokio::time::timeout(Duration::from_secs(5), async {
        let mut frames = Reader::new(BufReader::new(tester_read));
        let id = loop {
            let frame = frames.next().await.unwrap().unwrap();
            if let MachineMessage::Request(request) = frame
                && request.method == methods::FORWARD
                && let Some(id) = request.id
            {
                assert_eq!(request.params["params"]["op"], "internal.ensure_route");
                assert_eq!(request.params["params"]["args"]["wake"], false);
                break id;
            }
        };
        wire::send(&mut tester_write, &Response::ok(id, EmptyResult {}))
            .await
            .unwrap();
        drop(parallel);
        loop {
            let fallback = direct(&local, &remote);
            if fallback
                .as_ref()
                .is_some_and(|peer| Arc::ptr_eq(peer, &first_peer))
            {
                break;
            }
            events.recv().await.unwrap();
        }
    })
    .await
    .unwrap();
    drop(tester_write);
    session.await.unwrap();
}
