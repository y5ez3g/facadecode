use std::sync::Arc;
use std::time::Duration;

use facade_base::daemon::{
    AgentInfo, DeliveredVia, Delivery, DeliveryFailure, DeliveryStatus, MAX_MESSAGES_LIMIT,
    Message, MessagesSnapshot, MessagesWatchArgs, TextWritten,
};
use facade_base::jsonrpc::Reason;
use tokio::sync::watch;
use tokio::time::Instant;

use super::*;
use crate::store::{AgentRecord, Store};

/// Posts `message` with no request ID, as a new message: its numbered self and the receiver its
/// settlement reaches.
pub(crate) fn post_new(
    messages: &Messages,
    message: Message,
) -> (Message, watch::Receiver<Option<Settled>>) {
    match messages.post(message, None).unwrap() {
        Posted::New(message, settled) => (message, settled),
        Posted::Earlier(_) => unreachable!("a message with no request ID is new"),
    }
}

/// Messages over a store in memory, and that store.
pub(crate) fn messages() -> (Arc<Messages>, Arc<Store>) {
    let store = Store::in_memory();
    (Arc::new(Messages::new(store.message_table())), store)
}

/// A pending message from #a1 Ada to `to`, which the store numbers as it keeps it.
pub(crate) fn message(number: u64, to: &str) -> Message {
    Message {
        message_id: format!("m{number}"),
        from: "a1".into(),
        from_name: Some("Ada".into()),
        to: to.into(),
        text: format!("message {number}"),
        reply_to: None,
        from_window: None,
        call_id: None,
        result: None,
        at: "2026-11-10T00:00:00.000Z".into(),
        delivery: Delivery {
            status: DeliveryStatus::Pending,
            reason: None,
            text_written: TextWritten::None,
            enter_written: Some(false),
            deadline: Some("2026-11-10T00:00:29.500Z".into()),
            delivered_via: None,
            delivered_at: None,
        },
    }
}

/// The message as `settled` says it was settled and kept.
fn kept(settled: &watch::Receiver<Option<Settled>>) -> Message {
    match settled.borrow().clone() {
        Some(Settled::Kept(message)) => *message,
        other => panic!("not settled as kept: {other:?}"),
    }
}

/// The message a failure withdrew, as its send was told.
fn withdrawn(settled: &watch::Receiver<Option<Settled>>) -> Message {
    match settled.borrow().clone() {
        Some(Settled::Withdrawn(message)) => *message,
        other => panic!("not withdrawn: {other:?}"),
    }
}

/// Posts message `number`, which must be the next number the store gives.
fn post(messages: &Messages, number: u64, to: &str) -> watch::Receiver<Option<Settled>> {
    let (posted, settled) = post_new(messages, message(number, to));
    assert_eq!(
        posted.message_id,
        format!("m{number}"),
        "the store numbers messages in order"
    );
    settled
}

fn ids(snapshot: &MessagesSnapshot) -> Vec<&str> {
    snapshot
        .messages
        .iter()
        .map(|message| message.message_id.as_str())
        .collect()
}

/// A message with a request ID is posted once: the same sender's same ID within the hour finds
/// it, while it is delivered and once it is settled, and keeps nothing more.
#[test]
fn a_request_id_posts_one_message_found_while_delivered_and_once_settled() {
    let (post, _store) = messages();
    let now = facade_base::time::iso_now();
    let fresh = |to: &str| Message {
        at: now.clone(),
        ..message(0, to)
    };
    let Posted::New(first, _) = post.post(fresh("a2"), Some("r1")).unwrap() else {
        panic!("a new message")
    };
    let again = post.post(fresh("a3"), Some("r1")).unwrap();
    assert!(
        matches!(&again, Posted::Earlier(Earlier::Delivering(message, _)) if *message == first),
        "it joins the first"
    );
    assert!(matches!(
        post.find_request("a1", "r1").unwrap(),
        Some(Earlier::Delivering(..))
    ));
    post.settle(&[1], Outcome::Typed);
    let settled = post.find_request("a1", "r1").unwrap();
    assert!(matches!(
        settled,
        Some(Earlier::Settled(message)) if message.delivery.status == DeliveryStatus::Success
    ));
    assert!(
        post.find_request("a1", "r2").unwrap().is_none()
            && post.find_request("a4", "r1").unwrap().is_none()
    );
    assert_eq!(
        post_new(&post, fresh("a2")).0.message_id,
        "m2",
        "the repeat took no number"
    );
}

/// A withdrawal takes a message whose paste has not begun out of the deliveries and the store:
/// its send learns it was withdrawn, watchers that it is removed, and its paste never begins.
/// One whose paste began, and one settled, stay.
#[test]
fn a_message_whose_paste_has_not_begun_is_withdrawn_and_not_kept() {
    let (post, _store) = messages();
    let typist = post.delivery_handle();
    let settled = self::post(&post, 1, "a2");
    let mut changes = post.subscribe();
    assert!(post.withdraw(1));
    assert!(matches!(*settled.borrow(), Some(Settled::Cancelled)));
    assert!(matches!(
        changes.try_recv(),
        Ok(Change::Removed { message_id, to })
            if message_id == "m1" && to == "a2"
    ));
    assert!(
        post.message("m1").is_none() && !post.withdraw(1),
        "not kept, and withdrawn once"
    );
    assert_eq!(
        typist.begin_paste(&[1]),
        Some(Vec::new()),
        "its paste never begins"
    );
    let _pasting = self::post(&post, 2, "a2");
    assert_eq!(typist.begin_paste(&[2]), Some(vec![2]));
    assert!(!post.withdraw(2), "a message whose paste began goes on");
    let _typed = self::post(&post, 3, "a2");
    post.settle(&[3], Outcome::Typed);
    assert!(!post.withdraw(3), "a settled message stays");
    assert!(post.message("m2").is_some() && post.message("m3").is_some());
}

/// A delivery's deadline is what is left of its send's 30 seconds as it reached the daemon, at
/// most 29.5 seconds (RULES-1.2): no unit test lengthens them.
#[tokio::test(start_paused = true)]
async fn a_delivery_s_deadline_is_what_is_left_of_its_send_at_most_29_5_seconds() {
    let left = |time_left_ms| Due::within(time_left_ms).instant - Instant::now();
    assert_eq!(left(Some(1_200)), Duration::from_millis(1_200));
    assert_eq!(left(Some(60_000)), Duration::from_millis(29_500));
    assert_eq!(left(None), Duration::from_millis(29_500));
    assert_eq!(DELIVERY_TIME, Duration::from_millis(29_500));
}

/// The default read returns what was not delivered, delivers it, and never returns it again;
/// `all` pages everything; `ids` rereads by ID within the inbox only.
#[test]
fn reading_delivers_what_it_returns_and_only_from_the_reader_s_inbox() {
    let (post, _store) = messages();
    let typist = post.delivery_handle();
    let mut settled = Vec::new();
    for number in 1..=5 {
        settled.push(self::post(
            &post,
            number,
            if number == 4 { "a3" } else { "a2" },
        ));
    }
    post.settle(&[2], Outcome::Typed);
    // A failure that is no timeout's keeps its message: a timeout withdraws it.
    post.settle(&[3], Outcome::untyped(DeliveryFailure::Unsupported));
    let delivered_at = |id| post.message(id).unwrap().delivery.delivered_at;
    assert!(
        delivered_at("m2").is_some() && delivered_at("m3").is_none(),
        "a failed message was not delivered"
    );
    let first = post
        .read(
            "a2",
            &MessagesWatchArgs {
                limit: Some(1),
                ..MessagesWatchArgs::default()
            },
        )
        .unwrap();
    assert_eq!(
        (ids(&first), first.next_cursor.as_deref()),
        (vec!["m1"], Some("m1")),
        "what was not delivered, a page at a time"
    );
    assert_eq!(
        typist.begin_paste(&[1]),
        Some(Vec::new()),
        "a message read before its paste is never typed"
    );
    let next = post
        .read(
            "a2",
            &MessagesWatchArgs {
                cursor: first.next_cursor.clone(),
                ..MessagesWatchArgs::default()
            },
        )
        .unwrap();
    assert_eq!(
        (ids(&next), next.next_cursor.clone()),
        (vec!["m3", "m5"], None),
        "a failed message is not delivered yet"
    );
    assert!(
        next.messages
            .iter()
            .all(|message| message.delivery.delivered_via == Some(DeliveredVia::Read))
    );
    assert_eq!(
        kept(&settled[4]).delivery.delivered_via,
        Some(DeliveredVia::Read),
        "the sender learns the message was read"
    );
    assert!(
        ids(&post.read("a2", &MessagesWatchArgs::default()).unwrap()).is_empty(),
        "nothing is returned twice"
    );
    let all = post
        .read(
            "a2",
            &MessagesWatchArgs {
                all: true,
                ..MessagesWatchArgs::default()
            },
        )
        .unwrap();
    assert_eq!(ids(&all), ["m1", "m2", "m3", "m5"]);
    assert_eq!(
        all.messages[1].delivery.delivered_via,
        Some(DeliveredVia::Terminal),
        "delivered messages keep how"
    );
    let by_id = post
        .read(
            "a2",
            &MessagesWatchArgs {
                ids: Some(vec!["#m2".into(), "m4".into(), "m9".into()]),
                ..MessagesWatchArgs::default()
            },
        )
        .unwrap();
    assert_eq!(
        (ids(&by_id), by_id.not_found.clone()),
        (vec!["m2"], vec!["m4".to_string(), "m9".into()]),
        "another inbox's message is not found"
    );
    let none = post
        .read(
            "a2",
            &MessagesWatchArgs {
                ids: Some(vec!["m4".into()]),
                ..MessagesWatchArgs::default()
            },
        )
        .unwrap_err();
    assert_eq!(none.data.reason, Reason::NotFound);
    post.settle(&[5], Outcome::Typed);
    assert_eq!(
        post.message("m5").unwrap().delivery.delivered_via,
        Some(DeliveredVia::Read),
        "the first settlement stays"
    );
    let inbox: Vec<String> = post
        .inbox("a2")
        .into_iter()
        .map(|message| message.message_id)
        .collect();
    assert_eq!(
        inbox,
        ["m1", "m2", "m3", "m5"],
        "the whole inbox, delivering nothing"
    );
}

/// A message whose paste began is delivered by a read too, and its typist finishes it: what
/// reached the terminal is not known. A failed message keeps what was written.
#[test]
fn a_read_during_typing_delivers_the_message_with_its_effects_unknown() {
    let (post, _store) = messages();
    let typist = post.delivery_handle();
    let settled = self::post(&post, 1, "a2");
    self::post(&post, 2, "a2");
    assert_eq!(typist.begin_paste(&[1, 2]), Some(vec![1, 2]));
    typist.settle(
        &[2],
        Outcome::Failed {
            reason: DeliveryFailure::SubmissionUnconfirmed,
            text_written: TextWritten::Full,
            enter_written: Some(true),
        },
    );
    let read = post.read("a2", &MessagesWatchArgs::default()).unwrap();
    let delivery = |at: usize| &read.messages[at].delivery;
    assert_eq!(
        (
            delivery(0).status,
            delivery(0).text_written,
            delivery(0).enter_written
        ),
        (DeliveryStatus::Success, TextWritten::Unknown, None)
    );
    assert!(settled.borrow().is_some(), "its sender learns it was read");
    assert_eq!(
        (delivery(1).text_written, delivery(1).enter_written),
        (TextWritten::Full, Some(true))
    );
    typist.settle(&[1], Outcome::Typed);
    assert_eq!(
        post.message("m1").unwrap().delivery.delivered_via,
        Some(DeliveredVia::Read)
    );
}

#[test]
fn a_read_takes_ids_or_a_page_and_a_limit_from_1_to_200() {
    let (post, _store) = messages();
    let refused = |args: MessagesWatchArgs| post.read("a2", &args).unwrap_err().message;
    assert!(
        refused(MessagesWatchArgs {
            ids: Some(vec!["m1".into()]),
            all: true,
            ..MessagesWatchArgs::default()
        })
        .starts_with("ids selects messages itself")
    );
    assert!(
        refused(MessagesWatchArgs {
            ids: Some(Vec::new()),
            ..MessagesWatchArgs::default()
        })
        .starts_with("ids takes 1 to 100")
    );
    assert_eq!(
        refused(MessagesWatchArgs {
            limit: Some(201),
            ..MessagesWatchArgs::default()
        }),
        "limit must be between 1 and 200"
    );
    assert_eq!(
        refused(MessagesWatchArgs {
            cursor: Some("next".into()),
            ..MessagesWatchArgs::default()
        }),
        "next is not a cursor this inbox gave"
    );
    assert!(
        refused(MessagesWatchArgs {
            last: Some(1),
            limit: Some(5),
            ..MessagesWatchArgs::default()
        })
        .starts_with("last selects messages itself")
    );
    assert_eq!(
        refused(MessagesWatchArgs {
            last: Some(0),
            ..MessagesWatchArgs::default()
        }),
        "last must be between 1 and 200"
    );
}

/// A read and a paste never both take a message: once its paste began, a read delivers it with
/// what was typed unknown; once a read took it, no paste may type it.
#[test]
fn a_typist_and_a_read_never_both_take_a_message() {
    let (post, _store) = messages();
    let typist = post.delivery_handle();
    self::post(&post, 1, "a2");
    self::post(&post, 2, "a2");
    assert_eq!(typist.begin_paste(&[1]), Some(vec![1]));
    assert!(
        !typist.still_to_type(1),
        "once its paste began, it is not to be typed again"
    );
    post.read("a2", &MessagesWatchArgs::default()).unwrap();
    assert!(!typist.still_to_type(2), "once read, it is never typed");
    assert_eq!(typist.begin_paste(&[2]), Some(Vec::new()));
}

/// Each change is in the store when the call that makes it returns: the message, the beginning
/// of its paste, its settlement, and the read that delivers it.
#[test]
fn every_change_is_in_the_store_when_its_call_returns() {
    let (post, store) = messages();
    let typist = post.delivery_handle();
    for number in 1..=3 {
        self::post(&post, number, "a2");
    }
    let table = store.message_table();
    let kept = |number| table.message(number).unwrap().unwrap();
    assert_eq!(kept(1).delivery.status, DeliveryStatus::Pending);
    assert_eq!(typist.begin_paste(&[2, 1]), Some(vec![2, 1]));
    let pasted: Vec<(String, Option<u64>)> = post
        .pending()
        .unwrap()
        .into_iter()
        .map(|kept| (kept.message.message_id, kept.paste))
        .collect();
    assert_eq!(
        pasted,
        [
            ("m1".into(), Some(2)),
            ("m2".into(), Some(2)),
            ("m3".into(), None)
        ],
        "the paste is named by its first message"
    );
    typist.settle(&[1, 2], Outcome::Typed);
    assert_eq!(
        (
            kept(1).delivery.delivered_via,
            kept(2).delivery.delivered_via
        ),
        (Some(DeliveredVia::Terminal), Some(DeliveredVia::Terminal))
    );
    post.read("a2", &MessagesWatchArgs::default()).unwrap();
    assert_eq!(kept(3).delivery.delivered_via, Some(DeliveredVia::Read));
}

/// A paste whose beginning cannot be recorded is not typed; its messages stay to be typed, and
/// the next try may record it.
#[test]
fn nothing_is_typed_where_a_paste_s_beginning_cannot_be_recorded() {
    let (post, store) = messages();
    let typist = post.delivery_handle();
    self::post(&post, 1, "a2");
    store.set_read_only(true);
    assert_eq!(typist.begin_paste(&[1]), None);
    assert!(typist.still_to_type(1), "it waits to be typed");
    store.set_read_only(false);
    assert_eq!(typist.begin_paste(&[1]), Some(vec![1]));
}

/// Dropping an inbox the daemon deleted tells a send waiting on one of its messages that it went,
/// and watchers that each is removed; what its owner sent stays.
#[test]
fn a_removed_inbox_takes_its_messages_and_tells_their_sends() {
    let (post, store) = messages();
    let waiting = self::post(&post, 1, "a2");
    self::post(&post, 2, "a3");
    let mut changes = post.subscribe();
    post.drop_inbox("a2", store.delete("a2").unwrap());
    assert!(post.message("m1").is_none() && post.message("m2").is_some());
    assert!(matches!(
        changes.try_recv(),
        Ok(Change::Removed { message_id, to })
            if message_id == "m1" && to == "a2"
    ));
    assert!(
        changes.try_recv().is_err(),
        "only the removed inbox's message"
    );
    assert!(
        waiting.has_changed().is_err(),
        "the send learns that the message went with its inbox"
    );
    assert!(waiting.borrow().is_none());
    post.settle(&[1], Outcome::Typed);
    assert!(
        post.message("m1").is_none(),
        "a late settlement brings nothing back"
    );
}

/// Messages are kept 30 days from when they were sent; watchers are told each deleted one is
/// removed, and the numbers of deleted ones are never given again.
#[test]
fn messages_older_than_30_days_are_deleted_and_numbers_go_on() {
    let (post, _store) = messages();
    let now = facade_base::time::parse_iso_time("2026-12-10T00:00:00.001Z").unwrap();
    self::post(&post, 1, "a2");
    post_new(
        &post,
        Message {
            at: "2026-11-10T00:00:00.002Z".into(),
            ..message(2, "a2")
        },
    );
    let mut changes = post.subscribe();
    assert_eq!(
        post.expire(now).unwrap(),
        1,
        "only the one sent more than 30 days before"
    );
    assert!(matches!(
        changes.try_recv(),
        Ok(Change::Removed { message_id, to })
            if message_id == "m1" && to == "a2"
    ));
    assert!(
        changes.try_recv().is_err(),
        "watchers are told of the expired one alone"
    );
    assert!(!post.keeps(1) && post.keeps(2));
    assert_eq!(post_new(&post, message(3, "a2")).0.message_id, "m3");
}

/// A message neither its typist nor a read settled by its deadline and a grace is settled here:
/// as `timeout` where its paste had not begun, which withdraws it.
#[tokio::test(start_paused = true)]
async fn a_message_nobody_settled_by_its_deadline_fails_as_timeout() {
    let (post, _store) = messages();
    let mut settled = self::post(&post, 1, "a2");
    let deadline = Instant::now() + Duration::from_secs(1);
    post.settle_by_deadline(1, &mut settled, deadline).await;
    assert_eq!(Instant::now(), deadline + RESPONSE_GRACE);
    let delivery = withdrawn(&settled).delivery;
    assert_eq!(
        (delivery.status, delivery.reason, delivery.text_written),
        (
            DeliveryStatus::Failure,
            Some(DeliveryFailure::Timeout),
            TextWritten::None
        )
    );
}

/// A typist that never settles a message it began typing holds its send no longer than the
/// deadline and two graces: the message fails as unconfirmed, with what reached the terminal
/// unknown.
#[tokio::test(start_paused = true)]
async fn a_send_whose_typist_never_answers_settles_after_the_deadline_and_two_graces() {
    let (post, _store) = messages();
    let mut settled = self::post(&post, 1, "a2");
    assert_eq!(
        post.delivery_handle().begin_paste(&[1]),
        Some(vec![1]),
        "its typist began typing it"
    );
    let deadline = Instant::now() + Duration::from_millis(50);
    tokio::time::timeout(
        Duration::from_secs(5),
        post.settle_by_deadline(1, &mut settled, deadline),
    )
    .await
    .expect("the send is answered");
    let waited = Instant::now() - deadline;
    assert!(
        waited >= RESPONSE_GRACE * 2 && waited < RESPONSE_GRACE * 3,
        "answered {waited:?} after the deadline"
    );
    let delivery = post.message("m1").unwrap().delivery;
    assert_eq!(
        (
            delivery.status,
            delivery.reason,
            delivery.text_written,
            delivery.enter_written
        ),
        (
            DeliveryStatus::Failure,
            Some(DeliveryFailure::SubmissionUnconfirmed),
            TextWritten::Unknown,
            None
        )
    );
}

/// A send whose recipient's inbox goes before its message is settled returns at once, with
/// nothing settled.
#[tokio::test(start_paused = true)]
async fn a_send_whose_inbox_went_returns_at_once() {
    let (post, store) = messages();
    let mut settled = self::post(&post, 1, "a2");
    let started = Instant::now();
    post.drop_inbox("a2", store.delete("a2").unwrap());
    post.settle_by_deadline(1, &mut settled, started + Duration::from_secs(29))
        .await;
    assert_eq!(Instant::now(), started);
    assert!(settled.borrow().is_none());
}

/// Agent `id`'s record, as a result gives it.
fn agent(id: &str) -> AgentInfo {
    serde_json::from_value(serde_json::json!({
        "agent_id": id, "name": "Nova", "cli": "claude", "cwd": "/w",
        "machine_id": "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
        "windows": [{
            "machine_id": "3f2504e0-4f89-41d3-9a0c-0305e82c3301", "window_id": "terminal"
        }],
        "location_id": "loc-1", "pid": 7, "process": "running",
        "cols": 80, "rows": 24, "created_at": "2026-11-11T00:00:00.000Z", "root": "a1",
        "yolo": true, "state": "idle", "tools_state": "available",
    }))
    .unwrap()
}

/// Agent `id`'s stored record.
fn record(id: &str) -> AgentRecord {
    AgentRecord {
        agent_id: id.into(),
        name: "Pixel".into(),
        cli: "claude".into(),
        cwd: "/w".into(),
        pid: 7,
        created_at: "2026-11-11T00:00:00.000Z".into(),
        exit: None,
        rule: None,
        session: None,
        windows: vec![facade_base::daemon::WindowRef {
            machine_id: "test-machine".into(),
            window_id: "terminal".into(),
        }],
        location_source_window: None,
        creator: None,
        root: id.into(),
        yolo: false,
        request_id: None,
        prompt: None,
        location_id: facade_base::daemon::location_id("/w"),
    }
}

/// A start's prompt from `caller` to `to`, kept with `to`'s record and delivered, which owes
/// `caller` a result for call 7. Returns the prompt's number and the result's.
fn prompt(post: &Messages, store: &Store, caller: &str, to: &str) -> (u64, u64) {
    let prompt = Message {
        from: caller.into(),
        call_id: Some("7".into()),
        delivery: Delivery {
            deadline: None,
            ..message(0, to).delivery
        },
        ..message(0, to)
    };
    let (kept, owed) = store
        .insert_with_prompt(&record(to), &prompt, true)
        .unwrap();
    let owed = owed.expect("a prompt from an agent owes it a result");
    let info = agent(to);
    drop(post.deliver_prompt(
        kept.clone(),
        Some(OwedResult {
            number: owed,
            agent: Arc::new(move || info.clone()),
        }),
    ));
    (number(&kept), owed)
}

/// The settlement of a start's prompt, by its typist or a read, writes the result it owes in
/// the same transaction: from Facade, to the prompt's sender, under the number the prompt
/// keeps, with its call, its facts and their words. The result is handed on for delivery, once;
/// a later read of a prompt that failed writes none. A result for a caller that was removed is
/// not written, and nothing is handed on.
#[test]
fn a_prompt_s_settlement_writes_the_result_it_owes_and_hands_it_on_once() {
    let (post, store) = messages();
    let mut results = post.take_results().unwrap();
    assert!(post.take_results().is_none(), "the results go to one taker");
    for caller in ["a1", "a3", "a5"] {
        store.insert(&record(caller)).unwrap();
    }
    let (typed, owed) = prompt(&post, &store, "a1", "a2");
    let begun = post
        .begin_prompt(typed, "2026-11-11T00:00:29.500Z", None)
        .unwrap();
    assert_eq!(
        begun.delivery.deadline.as_deref(),
        Some("2026-11-11T00:00:29.500Z")
    );
    post.settle(&[typed], Outcome::Typed);
    let posted = results.try_recv().expect("the result is handed on");
    assert_eq!(
        posted.message,
        post.message(&format!("m{owed}")).unwrap(),
        "as it is kept"
    );
    let result = posted.message;
    assert_eq!(
        (
            result.from.as_str(),
            result.to.as_str(),
            result.call_id.as_deref()
        ),
        ("facade", "a1", Some("7"))
    );
    assert_eq!(
        result.text,
        "Nova (#a2) has started.\nYour initial message #m1 has been passed on."
    );
    assert_eq!(
        result.result.unwrap().prompt.delivery.delivered_via,
        Some(DeliveredVia::Terminal)
    );
    assert_eq!(result.delivery.status, DeliveryStatus::Pending);
    assert!(
        post.delivery_handle().still_to_type(owed),
        "its delivery is under way"
    );

    let (read, owed) = prompt(&post, &store, "a3", "a4");
    assert_eq!(
        ids(&post.read("a4", &MessagesWatchArgs::default()).unwrap()),
        [format!("m{read}")]
    );
    let result = results
        .try_recv()
        .expect("a read settles the prompt too")
        .message;
    assert_eq!(
        (result.message_id, result.text.lines().nth(1)),
        (
            format!("m{owed}"),
            Some("Your initial message #m3 has been passed on through read_messages.")
        )
    );

    let (failed, _) = prompt(&post, &store, "a5", "a6");
    post.settle(&[failed], Outcome::untyped(DeliveryFailure::Timeout));
    assert!(results.try_recv().is_ok());
    assert_eq!(
        ids(&post.read("a6", &MessagesWatchArgs::default()).unwrap()),
        [format!("m{failed}")],
        "a read delivers it after all"
    );
    assert!(results.try_recv().is_err(), "with no second result");

    let (orphaned, owed) = prompt(&post, &store, "a7", "a8");
    post.settle(&[orphaned], Outcome::Typed);
    assert!(
        results.try_recv().is_err(),
        "no result for a caller that is not listed"
    );
    assert_eq!(post.message(&format!("m{owed}")), None);
}

/// A prompt read before its delivery begins is no longer delivered: beginning it gives nothing
/// to type.
#[test]
fn a_prompt_read_before_its_delivery_begins_is_not_typed() {
    let (post, store) = messages();
    store.insert(&record("a1")).unwrap();
    let (number, _) = prompt(&post, &store, "a1", "a2");
    post.read("a2", &MessagesWatchArgs::default()).unwrap();
    assert_eq!(
        post.begin_prompt(number, "2026-11-11T00:00:29.500Z", None),
        None
    );
    assert_eq!(
        post.message(&format!("m{number}"))
            .unwrap()
            .delivery
            .deadline,
        None
    );
}

/// A take, as a guest's prompt and turn-end hooks make, hands over every message not yet
/// delivered, page after page, oldest first, and delivers them: the next take finds none.
#[test]
fn a_take_hands_over_every_page_of_what_was_not_delivered() {
    let (post, _store) = messages();
    let count = u64::from(MAX_MESSAGES_LIMIT) * 2 + 1;
    for number in 1..=count {
        self::post(&post, number, "a2");
    }
    self::post(&post, count + 1, "a3");
    let taken: Vec<String> = post
        .take("a2")
        .unwrap()
        .into_iter()
        .map(|message| message.message_id)
        .collect();
    assert_eq!(
        taken,
        (1..=count)
            .map(|number| format!("m{number}"))
            .collect::<Vec<_>>(),
        "three pages, in order"
    );
    assert!(post.take("a2").unwrap().is_empty(), "taking delivered them");
    assert_eq!(
        post.message("m1").unwrap().delivery.delivered_via,
        Some(DeliveredVia::Read)
    );
}

/// A pending message whose deadline is `deadline`.
fn pending(deadline: &str) -> Message {
    let mut message = message(5, "a2");
    message.delivery.deadline = Some(deadline.into());
    message
}

/// A pending message keeps what is left of its deadline, at most a whole delivery's time; where
/// its recipient is decides the rest. A message whose paste began is never typed again: its
/// typist finishes the paste.
#[test]
fn a_pending_message_is_taken_up_by_what_is_left_of_its_deadline_and_where_its_recipient_is() {
    let now = facade_base::time::parse_iso_time("2026-11-11T12:00:00.000Z").unwrap();
    let ten = Duration::from_secs(10);
    let soon = pending("2026-11-11T12:00:10.000Z");
    assert_eq!(
        decide(&soon, None, Recipient::Running, now),
        TakeUp::Type(ten)
    );
    assert_eq!(
        decide(&soon, Some(4), Recipient::Running, now),
        TakeUp::FinishPaste {
            paste: 4,
            left: ten
        }
    );
    assert_eq!(
        decide(&soon, None, Recipient::NotListed, now),
        TakeUp::Wait(ten)
    );
    assert_eq!(
        decide(&soon, Some(4), Recipient::NotListed, now),
        TakeUp::Wait(ten)
    );
    assert_eq!(
        decide(&soon, None, Recipient::Ended, now),
        TakeUp::Settle(Outcome::untyped(DeliveryFailure::Ended))
    );
    let ended_pasted = Outcome::Failed {
        reason: DeliveryFailure::Ended,
        text_written: TextWritten::Unknown,
        enter_written: None,
    };
    assert_eq!(
        decide(&soon, Some(4), Recipient::Ended, now),
        TakeUp::Settle(ended_pasted)
    );
    let past = pending("2026-11-11T11:59:59.999Z");
    assert_eq!(
        decide(&past, None, Recipient::Running, now),
        TakeUp::Settle(Outcome::untyped(DeliveryFailure::Timeout))
    );
    assert_eq!(
        decide(&past, Some(4), Recipient::Running, now),
        TakeUp::Settle(Outcome::UNCONFIRMED)
    );
    assert_eq!(
        decide(&past, None, Recipient::NotListed, now),
        TakeUp::Settle(Outcome::untyped(DeliveryFailure::Timeout))
    );
    let at_deadline = pending("2026-11-11T12:00:00.000Z");
    assert_eq!(
        decide(&at_deadline, None, Recipient::Running, now),
        TakeUp::Settle(Outcome::untyped(DeliveryFailure::Timeout))
    );
    // A deadline far ahead, as a clock set back since leaves it, gives no more than a whole
    // delivery's time.
    assert_eq!(
        decide(
            &pending("2026-11-11T13:00:00.000Z"),
            None,
            Recipient::Running,
            now
        ),
        TakeUp::Type(delivery_limit())
    );
    // A deadline that cannot be read has passed.
    assert_eq!(
        decide(&pending("soon"), None, Recipient::Running, now),
        TakeUp::Settle(Outcome::untyped(DeliveryFailure::Timeout))
    );
    // A start's prompt kept while its CLI's tools connected has no deadline yet: its whole
    // delivery time begins now.
    let held = Message {
        delivery: Delivery {
            deadline: None,
            ..pending("soon").delivery
        },
        ..pending("soon")
    };
    assert_eq!(
        decide(&held, None, Recipient::Running, now),
        TakeUp::Type(delivery_limit())
    );
    assert_eq!(
        decide(&held, None, Recipient::NotListed, now),
        TakeUp::Wait(delivery_limit())
    );
    assert_eq!(
        decide(&held, None, Recipient::Ended, now),
        TakeUp::Settle(Outcome::untyped(DeliveryFailure::Ended))
    );
}
