use facade_base::api_v1::Request;
use facade_base::api_v1::daemon::{AdvertiseParams, MachineInfo, MachineState, WatchResult};
use serde_json::json;
use tokio::io::{BufReader, duplex, split};

use super::*;

#[derive(Clone)]
struct Handler {
    tables: mpsc::UnboundedSender<AdvertiseParams>,
    forwarded: mpsc::UnboundedSender<Forwarded>,
}

struct Forwarded {
    forward: ForwardParams,
    deadline: Deadline,
    cancelled: watch::Receiver<bool>,
    answer: oneshot::Sender<Result<Delivery, ErrorBody>>,
}

impl SessionHandler for Handler {
    fn replace_table(&self, table: Value) -> Result<(), ErrorBody> {
        assert!(self.tables.send(decode_arguments(table)?).is_ok());
        Ok(())
    }

    fn sleeping(&self) {
        panic!("unexpected sleep notice");
    }

    fn identity(&self, machine_id: &str) -> MachineIdentity {
        MachineIdentity {
            machine_id: machine_id.into(),
            name: machine_id.into(),
        }
    }

    async fn receive(
        &self,
        forward: ForwardParams,
        deadline: Deadline,
        cancelled: watch::Receiver<bool>,
        _resize_route: Option<&WatchRoute>,
    ) -> Result<Delivery, ErrorBody> {
        let (answer, result) = oneshot::channel();
        assert!(
            self.forwarded
                .send(Forwarded {
                    forward,
                    deadline,
                    cancelled,
                    answer
                })
                .is_ok()
        );
        result.await.unwrap()
    }
}

async fn watch_snapshot(from_peer: &mut Reader<impl AsyncBufRead + Unpin>, id: u64) -> Value {
    let Some(MachineMessage::Response(response)) = from_peer.next().await.unwrap() else {
        panic!("expected a watch response");
    };
    assert_eq!(response.id, Some(id));
    let ResponseBody::Result(result) = response.body else {
        panic!("expected a successful watch");
    };
    let result: WatchResult = decode_arguments(result).unwrap();
    assert_eq!(result.watch, id);
    result.snapshot
}

#[tokio::test(start_paused = true)]
async fn a_session_hands_its_frames_to_the_handler_and_settles_its_watches() {
    let (peer, output) = Peer::new(None);
    let (peer_stream, client_stream) = duplex(4096);
    let (read, write) = split(peer_stream);
    let (client_read, mut to_peer) = split(client_stream);
    let mut from_peer = Reader::new(BufReader::new(client_read));
    let (tables, mut advertised) = mpsc::unbounded_channel();
    let (forwarded, mut requests) = mpsc::unbounded_channel();
    let session = peer.clone();
    let running = tokio::spawn(async move {
        let handler = Handler { tables, forwarded };
        let result = session
            .run(handler, Reader::new(BufReader::new(read)), write, output)
            .await;
        session.close();
        result
    });

    tokio::time::timeout(Duration::from_secs(5), async {
        let table = AdvertiseParams {
            machines: vec![MachineInfo {
                machine_id: "origin".into(),
                short_id: "origin".into(),
                selector: "@origin".into(),
                state: MachineState::Online,
                last_seen: None,
                ssh_error: None,
                name: "Origin".into(),
                boot_id: Some("origin-start".into()),
                build: Some("test-build".into()),
                route: Some(Vec::new()),
                connections: Vec::new(),
            }],
        };
        wire::send(&mut to_peer, &Notification::new(methods::ADVERTISE, &table))
            .await
            .unwrap();
        assert_eq!(json!(advertised.recv().await.unwrap()), json!(table));

        let params = json!({
            "route": ["receiver", "destination"], "time_left_ms": 1_000,
            "caller": { "kind": "terminal", "machine_id": "origin" },
            "method": methods::WATCH, "params": { "topic": "agents", "args": {} },
        });
        let id = wire::FIRST_REQUEST_ID;
        let sent = Instant::now();
        wire::send(
            &mut to_peer,
            &Request::new(Some(id), methods::FORWARD, &params),
        )
        .await
        .unwrap();
        let mut received = requests.recv().await.unwrap();
        assert_eq!(json!(received.forward), params);
        assert_eq!(received.deadline, Some(sent + Duration::from_secs(1)));
        assert!(!*received.cancelled.borrow());

        let destination = MachineIdentity {
            machine_id: "destination".into(),
            name: "Destination".into(),
        };
        let (downstream, mut downstream_output) = Peer::new(None);
        let mut pending = downstream
            .request(
                decode_arguments(params.clone()).unwrap(),
                received.deadline,
                destination.clone(),
            )
            .unwrap();
        assert!(matches!(
            downstream_output.recv().await,
            Some(Output::Forward { .. })
        ));
        let downstream_watch = 42;
        let snapshot = json!({ "agents": [] });
        downstream
            .response(Response::ok(
                pending.id,
                WatchResult {
                    watch: downstream_watch,
                    snapshot: snapshot.clone(),
                },
            ))
            .unwrap();
        let reply = pending.answer(received.deadline).await.unwrap();
        assert!(
            received
                .answer
                .send(Ok(Delivery::Relayed(pending, reply)))
                .is_ok()
        );
        assert_eq!(watch_snapshot(&mut from_peer, id).await, snapshot);

        wire::send(
            &mut to_peer,
            &Notification::new(methods::UNWATCH, UnwatchParams { watch: id }),
        )
        .await
        .unwrap();
        assert!(
            *received
                .cancelled
                .wait_for(|cancelled| *cancelled)
                .await
                .unwrap()
        );
        let Some(Output::Notification(unwatch, None)) = downstream_output.recv().await else {
            panic!("expected the downstream watch to be released");
        };
        assert_eq!(unwatch.method, methods::UNWATCH);
        assert_eq!(unwatch.params, json!({ "watch": downstream_watch }));

        let next_id = id + 1;
        wire::send(
            &mut to_peer,
            &Request::new(Some(next_id), methods::FORWARD, &params),
        )
        .await
        .unwrap();
        let (send, changes) = mpsc::channel(1);
        let received = requests.recv().await.unwrap();
        assert!(
            received
                .answer
                .send(Ok(Delivery::Local(TargetReply::Watch {
                    snapshot: snapshot.clone(),
                    changes,
                    view: None,
                })))
                .is_ok()
        );
        assert_eq!(watch_snapshot(&mut from_peer, next_id).await, snapshot);
        let error = wire::error("unavailable", "The provider ended the watch.");
        let expected = json!({ "watch": next_id, "error": &error });
        send.send(Err(error)).await.unwrap();
        let Some(MachineMessage::Request(ended)) = from_peer.next().await.unwrap() else {
            panic!("expected a watch-ended notification");
        };
        assert_eq!(ended.id, None);
        assert_eq!(ended.method, methods::WATCH_ENDED);
        assert_eq!(ended.params, expected);

        let mut waiting = peer
            .request(decode_arguments(params).unwrap(), None, destination)
            .unwrap();
        to_peer.shutdown().await.unwrap();
        running.await.unwrap().unwrap();
        let error = waiting
            .answer(None)
            .await
            .err()
            .expect("the closed session ends the wait");
        assert!(matches!(error, RequestFailure::Unreachable(_)));
        assert_eq!(ErrorBody::from(error).data.reason, "unavailable");
    })
    .await
    .expect("the session exchanges its frames");
}

#[tokio::test(start_paused = true)]
async fn an_error_reply_has_a_receipt_but_a_local_deadline_does_not() {
    let (peer, _output) = Peer::new(None);
    let machine = MachineIdentity {
        machine_id: "peer".into(),
        name: "peer".into(),
    };
    let forward = || {
        decode_arguments(json!({
            "route": ["peer"],
            "caller": { "kind": "terminal", "machine_id": "origin" },
            "method": methods::CALL, "params": { "op": "daemon.status", "args": {} },
        }))
        .unwrap()
    };
    let deadline = Some(Instant::now() + Duration::from_secs(3));
    let mut answered = peer.request(forward(), deadline, machine.clone()).unwrap();
    let mut unanswered = peer.request(forward(), deadline, machine).unwrap();
    let error = wire::error("unavailable", "the peer refused this operation");
    peer.response(Response::failed(Some(answered.id), error.clone()))
        .unwrap();
    let Ok(Reply::Call {
        result: Err(returned),
        received_at,
    }) = answered.answer(deadline).await
    else {
        panic!("a remote error is still a reply");
    };
    assert_eq!(returned, error);
    assert_eq!(
        RequestFailure::from_reply(returned, received_at).observation(),
        (
            facade_base::machine::MachineResponseState::Failed,
            Some(received_at)
        )
    );
    let timeout = unanswered.answer(deadline).await.err().expect("no reply");
    assert!(matches!(timeout, RequestFailure::TimedOut(_)));
    assert_eq!(
        timeout.observation(),
        (facade_base::machine::MachineResponseState::TimedOut, None)
    );
}

#[test]
fn relayed_deadlines_stay_distinct_from_a_lost_route() {
    use facade_base::machine::MachineResponseState;

    let machine = MachineIdentity {
        machine_id: "target".into(),
        name: "target".into(),
    };
    for (detail, state) in [
        (wire::REQUEST_TIMEOUT, MachineResponseState::TimedOut),
        (wire::TIMEOUT_BEFORE_SEND, MachineResponseState::TimedOut),
        (wire::TIMEOUT_BEFORE_TARGET, MachineResponseState::TimedOut),
        (
            "The machine session closed.",
            MachineResponseState::Unreachable,
        ),
    ] {
        let sent = wire::unavailable(machine.clone(), ExecutionOutcome::OutcomeUnknown, detail);
        let received: ErrorBody =
            serde_json::from_value(serde_json::to_value(&sent).unwrap()).unwrap();
        let failure = RequestFailure::from_reply(received, SystemTime::now());
        assert_eq!(failure.observation(), (state, None));
        assert_eq!(ErrorBody::from(failure), sent);
    }
}

#[tokio::test]
async fn watch_receipts_keep_the_frame_time_when_consumption_is_delayed() {
    use facade_base::machine::MachineResponseState;

    let (peer, _output) = Peer::new(None);
    let machine = MachineIdentity {
        machine_id: "peer".into(),
        name: "peer".into(),
    };
    let forward = decode_arguments(json!({
        "route": ["peer"],
        "caller": { "kind": "terminal", "machine_id": "origin" },
        "method": methods::WATCH, "params": { "topic": "agents", "args": {} },
    }))
    .unwrap();
    let mut pending = peer.request(forward, None, machine).unwrap();
    let watch = 9;
    peer.response(Response::ok(
        pending.id,
        WatchResult {
            watch,
            snapshot: json!({}),
        },
    ))
    .unwrap();
    let Reply::Watch {
        snapshot,
        changes,
        received_at,
        view,
    } = pending.answer(None).await.unwrap()
    else {
        panic!("the peer answered with a watch");
    };
    let mut subscription = pending.watch(snapshot, changes, received_at, view);

    let before = SystemTime::now();
    let change = json!({ "kind": "updated" });
    peer.changed(ChangedParams {
        watch,
        change: change.clone(),
    });
    let error = wire::error("refused", "the peer ended the watch");
    peer.watch_ended(WatchEndedParams {
        watch,
        error: error.clone(),
    });
    let queued = SystemTime::now();
    tokio::time::sleep(Duration::from_millis(25)).await;
    assert!(SystemTime::now() > queued);

    let received = subscription.next_with_receipt().await.unwrap().unwrap();
    assert_eq!(received.value, change);
    assert!((before..=queued).contains(&received.received_at));
    let failed = subscription
        .next_with_receipt()
        .await
        .unwrap()
        .err()
        .expect("the watch ended");
    let (state, at) = failed.observation();
    assert_eq!(state, MachineResponseState::Failed);
    assert!((received.received_at..=queued).contains(&at.expect("an error frame was received")));
    assert_eq!(ErrorBody::from(failed), error);
    assert!(subscription.next_with_receipt().await.is_none());
}
