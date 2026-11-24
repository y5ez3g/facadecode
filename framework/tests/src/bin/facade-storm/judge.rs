//! Reconciles four accounts of one storm, message by message: what the senders were told, what the
//! store keeps, what each CLI submitted, and the bytes each CLI read. Each rule it judges is named
//! as the storm's specification names it, I1 to I15.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use facade_scenarios::serde_json::{Value, json};

use crate::lab::Row;
use crate::person::Did;
use crate::tape::{Piece, Submission, Tape, Token, is_facades};

/// One send as its sender saw it.
#[derive(Clone, Debug)]
pub struct Sent {
    pub seq: usize,
    pub from: String,
    /// Its sender is a fake CLI, which shows its notices as submissions.
    pub from_managed: bool,
    pub to: String,
    pub text: String,
    /// The wait it asked for: `inbox`, `delivery` or `result`.
    pub wait: &'static str,
    pub called_us: u64,
    /// When its answer was read; none came where 0.
    pub answered_us: u64,
    pub took_ms: f64,
    pub number: Option<u64>,
    pub succeeded: bool,
    pub said: String,
    /// The whole answer where it was not a success.
    pub failure: Option<String>,
    /// How long it had to be delivered, where its caller gave it less.
    pub limit_us: u64,
}

#[derive(Clone, Debug)]
pub struct Violation {
    pub rule: &'static str,
    pub what: String,
    /// What already explains it, such as another violation in the same window.
    pub class: Option<&'static str>,
}

impl Sent {
    pub fn to_json(&self) -> Value {
        json!({
            "seq": self.seq, "from": self.from, "to": self.to, "number": self.number,
            "wait": self.wait, "called_us": self.called_us, "answered_us": self.answered_us,
            "took_ms": self.took_ms, "said": self.said, "failure": self.failure,
            "text": self.text,
        })
    }
}

impl Violation {
    pub fn to_json(&self) -> Value {
        json!({ "rule": self.rule, "what": self.what, "class": self.class })
    }
}

/// What one submission held.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Kind {
    /// One message alone, with its number and body.
    Message(u64, String),
    /// One notice of Facade's alone.
    Notice(String),
    /// Nothing of Facade's.
    Person(String),
    /// Facade's text with other text, or two of Facade's texts.
    Mixed(Vec<u64>, String),
}

/// `text` with the line ends a CLI shows.
pub fn plain(text: &str) -> String {
    text.replace("\r\n", "\n").replace('\r', "\n")
}

/// The numbers of the messages whose headers `text` holds.
pub fn headers(text: &str) -> Vec<u64> {
    text.split("📨 Message m")
        .skip(1)
        .filter_map(|rest| {
            let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
            let after = &rest[digits.len()..];
            (after.starts_with(" from ") || after.starts_with('@'))
                .then(|| digits.parse().ok())
                .flatten()
        })
        .collect()
}

fn message_of(text: &str) -> Option<(u64, String)> {
    let rest = text.strip_prefix("📨 Message m")?;
    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
    let (_, body) = text.split_once('\n')?;
    Some((digits.parse().ok()?, body.to_string()))
}

pub fn kind(submission: &Submission) -> Kind {
    let all: String = submission
        .pieces
        .iter()
        .map(|piece| match piece {
            Piece::Typed(text) | Piece::Pasted(text) => plain(text),
        })
        .collect();
    // A message may quote another's header in its body.
    let opens = all.starts_with("📨 Message m");
    let numbers: Vec<u64> = match opens {
        true if !all.contains("\n\n📨 Message m") => {
            headers(all.lines().next().unwrap_or_default())
        }
        _ => headers(&all),
    };
    let notices = match opens {
        true => 0,
        false => all.matches("🔔 ").count(),
    };
    // Facade pastes its text whole: a second piece is someone else's.
    let alone = submission.pieces.len() == 1;
    match (numbers.len(), notices) {
        (0, 0) => Kind::Person(all),
        (1, 0) if alone && all.starts_with("📨 Message m") => match message_of(&all) {
            Some((number, body)) => Kind::Message(number, body),
            None => Kind::Mixed(numbers, all),
        },
        (0, 1) if alone && all.starts_with("🔔 ") => Kind::Notice(all),
        _ => Kind::Mixed(numbers, all),
    }
}

/// One agent whose input the storm watched, and the person in its window, if any.
pub struct Window {
    pub agent: String,
    pub tape: Tape,
    pub person: Option<Did>,
    /// The state of its input at the end, as the daemon reads it.
    pub end_state: String,
    /// How long its CLI takes to draw what it read.
    pub draw_ms: u64,
    /// The least time one message takes in its input.
    pub service_ms: u64,
    /// Times a viewer the storm did not open was seen.
    pub strangers: usize,
    /// When the storm ended it, if it did.
    pub ended_us: Option<u64>,
    /// For a CLI without a tape, what its input read as over time, and its state.
    pub timeline: Option<Vec<(u64, String, String)>>,
    /// Nothing says what it submitted.
    pub unsaved: bool,
    /// Texts its CLI put back into its input by itself, with words of its own error on the screen.
    pub returned: Vec<Returned>,
}

/// A message OpenCode had taken and put back into its input: L7.
#[derive(Clone, Copy, Debug)]
pub struct Returned {
    /// The message, where its header shows.
    pub number: Option<u64>,
    /// When the input was empty of it.
    pub emptied_us: u64,
    /// When it held it again, and until when.
    pub from_us: u64,
    pub until_us: u64,
}

impl Window {
    /// How long its input read as one of `states` between two times, in milliseconds.
    fn read_as_ms(&self, states: &[&str], from: u64, to: u64) -> u64 {
        let Some(timeline) = &self.timeline else {
            return 0;
        };
        let mut total = 0;
        for (at, (us, input, _)) in timeline.iter().enumerate() {
            let until = timeline.get(at + 1).map_or(to, |next| next.0);
            if states.contains(&input.as_str()) {
                total += until.min(to).saturating_sub((*us).max(from));
            }
        }
        total / 1000
    }
}

/// One `read_messages` call of an agent's or guest's.
#[derive(Clone, Debug)]
pub struct Read {
    pub agent: String,
    pub began_us: u64,
    pub ended_us: u64,
    /// It asked for replies to one message alone.
    pub filtered: bool,
    /// The messages it returned for the first time: those waiting, and no page of earlier ones.
    pub numbers: Vec<u64>,
    /// Each returned message's text.
    pub texts: Vec<String>,
}

pub struct Case<'a> {
    pub sent: &'a [Sent],
    pub rows: &'a BTreeMap<u64, Row>,
    pub windows: &'a [Window],
    pub reads: &'a [Read],
    /// Lines of the daemon's and keeper's logs that are warnings or worse.
    pub warnings: &'a [String],
    pub ended_us: u64,
}

#[derive(Default)]
pub struct Verdict {
    pub violations: Vec<Violation>,
    /// Failures the storm proved to be reasonable, by their kind, L1 to L5.
    pub reasonable: BTreeMap<&'static str, usize>,
    pub stats: Value,
    /// Agents a person other than the storm's was in.
    pub strangers: Vec<String>,
}

/// How long a message has to be delivered.
pub const LIMIT_US: u64 = 29_500_000;
/// How long a message's own text may stay in an input beyond what its CLI takes to draw it.
const STAYS_MS: u64 = 1000;
/// What the typist takes by itself: the paste's delay and the fake CLI's settle time.
const TYPIST_MS: u64 = 180;

pub fn judge(case: &Case<'_>) -> Verdict {
    let mut verdict = Verdict::default();
    let mut reasonable: BTreeMap<&'static str, usize> = BTreeMap::new();
    let mut say = |rule: &'static str, what: String, class: Option<&'static str>| {
        verdict.violations.push(Violation { rule, what, class });
    };
    // Where each message was submitted: (agent, when, body).
    let mut arrived: HashMap<u64, Vec<(String, u64, String)>> = HashMap::new();
    // Each agent's notices.
    let mut notices: HashMap<String, Vec<String>> = HashMap::new();
    for window in case.windows {
        for submission in &window.tape.submissions {
            match kind(submission) {
                Kind::Message(number, body) => arrived.entry(number).or_default().push((
                    window.agent.clone(),
                    submission.us,
                    body,
                )),
                Kind::Notice(text) => notices.entry(window.agent.clone()).or_default().push(text),
                Kind::Person(_) => {}
                Kind::Mixed(numbers, text) => {
                    say(
                        "I4",
                        format!(
                            "{} submitted Facade's text with {}, messages {numbers:?}: {}",
                            window.agent,
                            match (submission.pieces.first(), submission.pieces.len()) {
                                (Some(Piece::Typed(_)), _) => "text typed before it",
                                (_, 2..) => "text after it",
                                _ => "other text in one paste",
                            },
                            short(&text)
                        ),
                        None,
                    );
                    for number in numbers {
                        arrived.entry(number).or_default().push((
                            window.agent.clone(),
                            submission.us,
                            "<mixed>".into(),
                        ));
                    }
                }
            }
        }
    }

    // Windows Facade's own text stayed in: what waited behind it failed because of that.
    let mut stays: HashMap<&str, u64> = HashMap::new();
    let mut stuck: BTreeSet<&str> = BTreeSet::new();
    for window in case.windows {
        let (longest, kept) = leftovers(case, window, &mut say);
        stays.insert(&window.agent, longest);
        if kept {
            stuck.insert(&window.agent);
        }
    }

    let mut delivered = 0usize;
    let mut failed: BTreeMap<String, usize> = BTreeMap::new();
    let mut waits: Vec<f64> = Vec::new();
    for sent in case.sent {
        let Some(number) = sent.number else {
            failed
                .entry(format!("refused: {}", sent.said))
                .and_modify(|count| *count += 1)
                .or_insert(1);
            // Nothing was kept: nothing of it may arrive.
            if case.windows.iter().any(|window| {
                window.tape.submissions.iter().any(|submission| {
                    matches!(kind(submission), Kind::Message(_, body) if body == plain(&sent.text))
                })
            }) {
                say(
                    "I3",
                    format!(
                        "send {} from {} was refused ({}) and its text arrived",
                        sent.seq,
                        sent.from,
                        sent.failure.as_deref().unwrap_or(&sent.said)
                    ),
                    None,
                );
            }
            continue;
        };
        let row = case.rows.get(&number);
        let here = arrived.get(&number).map_or(&[][..], Vec::as_slice);
        let status = row.map_or("gone", |row| {
            if row.withdrawn {
                "withdrawn"
            } else {
                row.status.as_str()
            }
        });
        let read = row.is_some_and(|row| row.delivered_via.as_deref() == Some("read"));
        let who = format!("m{number} ({} to {})", sent.from, sent.to);
        if here.len() > 1 {
            say(
                "I2",
                format!("{who} was submitted {} times", here.len()),
                None,
            );
        }
        if let Some((agent, _, _)) = here.iter().find(|(agent, _, _)| *agent != sent.to) {
            say("I4", format!("{who} was submitted by {agent}"), None);
        }
        match status {
            "success" if read => {
                delivered += 1;
                // Read, and so never typed; and returned by one read of its own recipient's.
                if !here.is_empty() {
                    say("I2", format!("{who} was read and also submitted"), None);
                }
                let reads: Vec<&Read> = case
                    .reads
                    .iter()
                    .filter(|read| read.numbers.contains(&number))
                    .collect();
                if case.reads.iter().any(|read| read.agent == sent.to) && reads.len() != 1 {
                    say(
                        if reads.is_empty() { "I1" } else { "I2" },
                        format!(
                            "{who} is recorded as read and {} reads returned it",
                            reads.len()
                        ),
                        None,
                    );
                }
                for read in reads {
                    let text = read
                        .numbers
                        .iter()
                        .position(|each| *each == number)
                        .and_then(|at| read.texts.get(at));
                    if read.agent != sent.to
                        || text.is_none_or(|text| plain(text) != plain(&sent.text))
                    {
                        say(
                            "I1",
                            format!("{who} was returned to {} as {text:?}", read.agent),
                            None,
                        );
                    }
                }
            }
            "success" => {
                delivered += 1;
                let unsaved = case
                    .windows
                    .iter()
                    .any(|window| window.agent == sent.to && window.unsaved);
                let gave_back = case.windows.iter().any(|window| {
                    window.agent == sent.to
                        && window.returned.iter().any(|one| match one.number {
                            Some(back) => back == number,
                            // The last one delivered before its input was empty.
                            None => {
                                let last = case
                                    .rows
                                    .values()
                                    .filter(|row| row.to == sent.to)
                                    .filter(|row| {
                                        row.delivered_ms
                                            .is_some_and(|ms| ms * 1000 <= one.emptied_us + 1000)
                                    })
                                    .max_by_key(|row| row.delivered_ms);
                                last.is_some_and(|row| row.number == number)
                            }
                        })
                });
                match here {
                    [] if unsaved => {}
                    [] if gave_back => {
                        *reasonable.entry("L7").or_default() += 1;
                    }
                    [] => say(
                        "I1",
                        format!("{who} is recorded as delivered and was never submitted"),
                        None,
                    ),
                    [(agent, us, body), ..] => {
                        // A saved session drops the line end a message ends in.
                        let saved = case
                            .windows
                            .iter()
                            .any(|window| window.agent == *agent && window.timeline.is_some());
                        let same = match saved {
                            true => body.trim_end() == plain(&sent.text).trim_end(),
                            false => *body == plain(&sent.text),
                        };
                        if !same && body != "<mixed>" {
                            say(
                                "I1",
                                format!(
                                    "{who} arrived changed: sent {}, arrived {}",
                                    short(&sent.text),
                                    short(body)
                                ),
                                None,
                            );
                        }
                        waits.push((us.saturating_sub(sent.called_us)) as f64 / 1000.0);
                    }
                }
            }
            "pending" => say("I15", format!("{who} is still pending at the end"), None),
            _ => {
                let reason = row
                    .and_then(|row| row.reason.clone())
                    .unwrap_or_else(|| status.to_string());
                let row_says = row.map_or_else(String::new, |row| {
                    format!(
                        " text_written={} enter_written={:?}",
                        row.text_written, row.enter_written
                    )
                });
                failed
                    .entry(reason.clone())
                    .and_modify(|count| *count += 1)
                    .or_insert(1);
                if !here.is_empty() {
                    say(
                        "I3",
                        format!(
                            "{who} is recorded as failed ({reason}{row_says}) and was submitted"
                        ),
                        None,
                    );
                }
                // Reasonable only where what is not Facade's held the input for so long that what
                // was left could not take this message and those before it (L1, L2).
                let window = case.windows.iter().find(|window| window.agent == sent.to);
                let held = window.map_or(0, |window| {
                    let (from, to) = (sent.called_us, sent.called_us + sent.limit_us);
                    match &window.timeline {
                        // Nobody else types there: a draft is Facade's own.
                        Some(_) if window.person.is_none() => {
                            window.read_as_ms(&["interaction"], from, to)
                        }
                        Some(_) => window.read_as_ms(&["interaction", "draft"], from, to),
                        None if window.person.is_some() => window.tape.held_with_keys_ms(from, to),
                        None => window.tape.held_ms(from, to),
                    }
                });
                // Behind a text OpenCode put back by itself (L7).
                let back = window.map_or(0, |window| {
                    let (from, to) = (sent.called_us, sent.called_us + sent.limit_us);
                    window
                        .returned
                        .iter()
                        .map(|one| one.until_us.min(to).saturating_sub(one.from_us.max(from)))
                        .sum::<u64>()
                        / 1000
                });
                let held = held + back;
                let free = (sent.limit_us / 1000).saturating_sub(held);
                let ahead = case
                    .sent
                    .iter()
                    .filter(|other| {
                        other.to == sent.to
                            && other.number.is_some_and(|other| other < number)
                            && still_waiting(other, sent.called_us, &arrived)
                    })
                    .count() as u64;
                let service = window.map_or(0, |window| window.service_ms);
                let needed = (ahead + 1) * service * 12 / 10;
                let ended = window.and_then(|window| window.ended_us);
                let unread = window.is_none()
                    && !case.reads.iter().any(|read| {
                        read.agent == sent.to
                            && !read.filtered
                            && read.began_us < sent.called_us + sent.limit_us
                            && read.ended_us > sent.called_us
                    });
                if ended.is_some_and(|us| us < sent.called_us + sent.limit_us + 1_000_000) {
                    *reasonable.entry("L4").or_default() += 1;
                } else if unread {
                    *reasonable.entry("L3").or_default() += 1;
                } else if window.is_some_and(|window| removed_by_person(window, number)) {
                    *reasonable.entry("L6").or_default() += 1;
                } else if held > 0 && free < needed {
                    let kind = if back > 0 {
                        "L7"
                    } else if reason == "input_interaction" {
                        "L2"
                    } else {
                        "L1"
                    };
                    *reasonable.entry(kind).or_default() += 1;
                } else {
                    say(
                        "I15",
                        format!(
                            "{who} was not delivered: {reason}{row_says}; the input was free for \
                             {free} ms of its 29.5 s and {ahead} before it and itself need \
                             {needed} ms"
                        ),
                        stuck
                            .contains(sent.to.as_str())
                            .then_some("behind Facade's own text"),
                    );
                }
            }
        }
        // What the caller was told agrees with the store.
        if sent.wait == "delivery" && sent.succeeded != (status == "success") {
            say(
                "I3",
                format!(
                    "{who}: its sender was told {} and the store says {status}",
                    sent.said
                ),
                None,
            );
        }
        if sent.wait == "inbox" && sent.from_managed {
            let named = notices.get(&sent.from).map_or(0, |texts| {
                texts
                    .iter()
                    .filter(|text| {
                        text.contains(&format!("Message m{number}@"))
                            || text.contains(&format!("Message m{number} "))
                    })
                    .count()
            });
            let expected = usize::from(!matches!(status, "success" | "pending"));
            // A notice that failed for a reason of its own is judged with the notices.
            let failed_notice = case.rows.values().any(|row| {
                row.from == "facade"
                    && row.to == sent.from
                    && (row.withdrawn || row.status == "failure")
            });
            // Where the person's draft held the sender's own input all the while, the notice has no
            // way in either (L1).
            let unreachable = expected == 1
                && named == 0
                && case
                    .windows
                    .iter()
                    .find(|window| window.agent == sent.from)
                    .is_some_and(|window| {
                        let from = sent.called_us + sent.limit_us;
                        let held = window.tape.held_ms(from, from + LIMIT_US);
                        (LIMIT_US / 1000).saturating_sub(held) < window.service_ms * 12 / 10
                    });
            if unreachable {
                *reasonable.entry("L1 notice").or_default() += 1;
            } else if named != expected && !failed_notice {
                say(
                    "I8",
                    format!("{who} ended as {status}; its sender got {named} notices"),
                    None,
                );
            }
        }
    }

    // A notice of a failure is a message too.
    for row in case.rows.values().filter(|row| row.from == "facade") {
        if row.withdrawn || row.status == "failure" {
            // Reasonable where the one it tells held their input, or ended (L1, L4).
            let window = case.windows.iter().find(|window| window.agent == row.to);
            if window.is_some_and(|window| window.ended_us.is_some()) {
                *reasonable.entry("L4").or_default() += 1;
                continue;
            }
            if window.is_some_and(|window| {
                let from = row.at_ms * 1000;
                let free =
                    (LIMIT_US / 1000).saturating_sub(window.tape.held_ms(from, from + LIMIT_US));
                free < window.service_ms * 12 / 10
            }) {
                *reasonable.entry("L1").or_default() += 1;
                continue;
            }
            say(
                "I8",
                format!(
                    "m{}, a notice to {}, was not delivered: {:?}: {}",
                    row.number,
                    row.to,
                    row.reason,
                    short(&row.text)
                ),
                stuck
                    .contains(row.to.as_str())
                    .then_some("behind Facade's own text"),
            );
        }
    }
    // Messages the storm did not send through a call it kept, such as a start's first.
    let known: BTreeSet<u64> = case.sent.iter().filter_map(|sent| sent.number).collect();
    for row in case.rows.values() {
        let Some(window) = case
            .windows
            .iter()
            .find(|window| window.agent == row.to && window.ended_us.is_none())
        else {
            continue;
        };
        if known.contains(&row.number) || row.from == "facade" || window.unsaved {
            continue;
        }
        let times = arrived.get(&row.number).map_or(0, Vec::len);
        let typed = row.delivered_via.as_deref() != Some("read");
        match (row.status.as_str(), times) {
            ("success", 1) => {}
            ("success", 0) if !typed => {}
            ("success", 0) => say(
                "I1",
                format!(
                    "m{} ({} to {}) is recorded as delivered and was never submitted",
                    row.number, row.from, row.to
                ),
                None,
            ),
            ("success", _) => say(
                "I2",
                format!("m{} was submitted {times} times", row.number),
                None,
            ),
            (_, 0) => {}
            _ => say(
                "I3",
                format!(
                    "m{} ({} to {}) is recorded as {} and was submitted",
                    row.number, row.from, row.to, row.status
                ),
                None,
            ),
        }
    }
    // Submissions no send accounts for.
    for number in arrived.keys().filter(|number| !known.contains(number)) {
        let expected = case.rows.contains_key(number);
        if !expected {
            say(
                "I3",
                format!("m{number} was submitted and neither a send nor the store names it"),
                None,
            );
        }
    }

    order(case, &arrived, &mut say);
    let mut people = Vec::new();
    for window in case.windows {
        let keys = keys(window, &mut say);
        let [drawn, key, emptied, next] = window.tape.segments();
        let segments = match key.len() {
            0..5 => Value::Null,
            _ => json!({
                "paste_to_drawn": summary(drawn), "drawn_to_key": summary(key),
                "key_to_emptied": summary(emptied), "emptied_to_next_paste": summary(next),
            }),
        };
        people.push(json!({
            "agent": window.agent, "longest_stay_ms": stays[window.agent.as_str()], "keys": keys,
            "segments_ms": segments,
        }));
    }
    for line in case.warnings {
        say("I12", format!("the log: {line}"), None);
    }

    // From a message's keeping to its delivery, by the store's own times.
    let kept_to_delivered: Vec<f64> = case
        .rows
        .values()
        .filter(|row| row.status == "success")
        .filter_map(|row| Some(row.delivered_ms?.saturating_sub(row.at_ms) as f64))
        .collect();
    // How long each recipient took between one delivery and the next.
    let mut gaps: BTreeMap<String, Vec<u64>> = BTreeMap::new();
    for row in case.rows.values().filter(|row| row.status == "success") {
        if let Some(ms) = row.delivered_ms {
            gaps.entry(row.to.clone()).or_default().push(ms);
        }
    }
    let gaps: BTreeMap<String, Value> = gaps
        .into_iter()
        .filter(|(_, at)| at.len() > 1)
        .map(|(to, mut at)| {
            at.sort_unstable();
            let between = at
                .windows(2)
                .map(|pair| (pair[1] - pair[0]) as f64)
                .collect();
            (to, summary(between))
        })
        .collect();
    verdict.reasonable = reasonable.clone();
    verdict.strangers = case
        .windows
        .iter()
        .filter(|window| window.strangers > 0)
        .map(|window| window.agent.clone())
        .collect();
    verdict.stats = json!({
        "sent": case.sent.len(),
        "delivered": delivered,
        "failed": failed,
        "called_to_submitted_ms": summary(waits),
        "send_call_ms": summary(case.sent.iter().map(|sent| sent.took_ms).collect()),
        "reasonable": reasonable,
        "kept_to_delivered_ms": summary(kept_to_delivered),
        "between_deliveries_ms": gaps,
        "notices": notices.values().map(Vec::len).sum::<usize>(),
        "windows": people.into_iter().filter(|window| {
            window["longest_stay_ms"].as_u64().is_some_and(|stay| stay > 0)
                || !window["keys"].is_null()
        }).collect::<Vec<_>>(),
    });
    verdict
}

/// Whether the CLI read message `number`'s paste and then a key of the person's that removes text,
/// before the message was submitted.
fn removed_by_person(window: &Window, number: u64) -> bool {
    let Some(person) = &window.person else {
        return false;
    };
    if !person
        .controls
        .iter()
        .any(|byte| matches!(byte, 0x7f | 0x03 | 0x1b))
    {
        return false;
    }
    let pasted = window.tape.tokens.iter().position(
        |(_, token)| matches!(token, Token::Paste(paste) if headers(&paste.text).contains(&number)),
    );
    pasted.is_some_and(|at| {
        window.tape.tokens[at + 1..]
            .iter()
            .take_while(|(_, token)| !matches!(token, Token::Paste(_)))
            .any(|(_, token)| matches!(token, Token::Control(0x7f | 0x08 | 0x03)))
    })
}

/// Whether `other` was still to be delivered at `us`.
fn still_waiting(
    other: &Sent,
    us: u64,
    arrived: &HashMap<u64, Vec<(String, u64, String)>>,
) -> bool {
    let submitted = other
        .number
        .and_then(|number| arrived.get(&number))
        .and_then(|here| here.first())
        .map(|(_, at, _)| *at);
    other.called_us + other.limit_us > us && submitted.is_none_or(|at| at > us)
}

/// I5: messages of one sender to one recipient, each called after the last was answered, arrive in
/// that order.
fn order(
    case: &Case<'_>,
    arrived: &HashMap<u64, Vec<(String, u64, String)>>,
    say: &mut dyn FnMut(&'static str, String, Option<&'static str>),
) {
    let mut pairs: HashMap<(&str, &str), Vec<&Sent>> = HashMap::new();
    for sent in case.sent {
        pairs.entry((&sent.from, &sent.to)).or_default().push(sent);
    }
    for ((from, to), mut sends) in pairs {
        sends.sort_by_key(|sent| sent.called_us);
        let mut last: Option<(&Sent, u64)> = None;
        for sent in sends {
            let Some(us) = sent
                .number
                .and_then(|number| arrived.get(&number))
                .and_then(|here| here.first())
                .map(|(_, us, _)| *us)
            else {
                continue;
            };
            if let Some((before, before_us)) = last
                && before.answered_us != 0
                && before.answered_us <= sent.called_us
                && us < before_us
            {
                say(
                    "I5",
                    format!(
                        "{from} to {to}: m{} was sent after m{} was answered and arrived {:.1} ms before it",
                        sent.number.unwrap_or_default(),
                        before.number.unwrap_or_default(),
                        (before_us - us) as f64 / 1000.0
                    ),
                    None,
                );
            }
            if last.is_none_or(|(_, before_us)| us > before_us) {
                last = Some((sent, us));
            }
        }
    }
}

/// I6 and I7: nothing of Facade's stays in an input. Returns the longest stay in milliseconds, and
/// whether one was too long.
fn leftovers(
    case: &Case<'_>,
    window: &Window,
    say: &mut dyn FnMut(&'static str, String, Option<&'static str>),
) -> (u64, bool) {
    let mut longest = 0;
    let mut kept = false;
    if let Some(timeline) = &window.timeline {
        // Nobody else types there: each stretch of a draft is one message's of Facade's.
        let allowed = STAYS_MS + 2 * window.service_ms + 200;
        let end = window.ended_us.unwrap_or(case.ended_us);
        for (at, (us, input, _)) in timeline.iter().enumerate() {
            if input != "draft" || window.person.is_some() {
                continue;
            }
            let stay = timeline
                .get(at + 1)
                .map_or(end, |next| next.0)
                .saturating_sub(*us)
                / 1000;
            longest = longest.max(stay);
            if stay > allowed {
                kept = true;
                say(
                    "I7",
                    format!("{}: a draft stayed in the input {stay} ms", window.agent),
                    None,
                );
            }
        }
        if window.ended_us.is_none() && window.end_state == "draft" && window.person.is_none() {
            kept = true;
            say(
                "I6",
                format!("{}'s input ends with a draft", window.agent),
                None,
            );
        }
        return (longest, kept);
    }
    let allowed = STAYS_MS + TYPIST_MS + 4 * window.draw_ms;
    for (us, token) in &window.tape.tokens {
        let Token::Paste(paste) = token else { continue };
        let text = &paste.text;
        if !is_facades(text) {
            continue;
        }
        let submitted = window
            .tape
            .submissions
            .iter()
            .find(|submission| {
                submission.us >= *us
                    && submission.pieces.iter().any(|piece| match piece {
                        Piece::Pasted(pasted) | Piece::Typed(pasted) => {
                            plain(pasted).contains(text)
                        }
                    })
            })
            .map(|submission| submission.us);
        // Until it was submitted, or taken away again.
        let removed = window
            .tape
            .boxes
            .iter()
            .skip_while(|(at, _)| at <= us)
            .skip_while(|(_, shown)| shown.is_empty())
            .find(|(_, shown)| shown.is_empty())
            .map(|(at, _)| *at);
        let end = removed
            .unwrap_or(u64::MAX)
            .min(window.ended_us.unwrap_or(case.ended_us));
        if submitted.is_none() && *us > end {
            continue;
        }
        let stay = submitted.unwrap_or(end).saturating_sub(*us) / 1000;
        longest = longest.max(stay);
        if stay > allowed {
            kept = true;
            let how = match submitted {
                Some(_) => "before it was submitted",
                None => "and was not submitted",
            };
            say(
                "I7",
                format!(
                    "{}: Facade's text stayed in the input {stay} ms {how}: {}",
                    window.agent,
                    short(&text)
                ),
                None,
            );
        }
    }
    if window.ended_us.is_some() {
        return (longest, kept);
    }
    let expected = window
        .person
        .as_ref()
        .map_or("", |person| person.draft.as_str());
    let last = window.tape.last_box();
    if last.trim_end() != expected.trim_end() {
        say(
            "I6",
            format!(
                "{}'s input ends with {:?}, not {expected:?}; the daemon reads it as {}",
                window.agent,
                short(last),
                window.end_state
            ),
            None,
        );
        kept |= headers(last).len() + last.matches("[Pasted ").count() > 0;
    }
    (longest, kept)
}

/// I9 and I13: every key of the person's reached the CLI once, in order, and their lines were
/// submitted as they were.
fn keys(window: &Window, say: &mut dyn FnMut(&'static str, String, Option<&'static str>)) -> Value {
    let Some(person) = &window.person else {
        return Value::Null;
    };
    if let Some(failed) = &person.failed {
        say(
            "I13",
            format!("{}: the person's write failed: {failed}", window.agent),
            None,
        );
    }
    let read: Vec<(char, u64)> = window
        .tape
        .tokens
        .iter()
        .filter_map(|(us, token)| match token {
            Token::Char(ch) => Some((*ch, *us)),
            _ => None,
        })
        .collect();
    let given: String = person.chars.iter().map(|(ch, _)| ch).collect();
    let got: String = read.iter().map(|(ch, _)| ch).collect();
    let mut late = Vec::new();
    // The input tape comes from the fake CLI. Use the rule's settle time and measure each paste
    // from its first byte to the frame showing its full draft.
    let fake_rule = facade_rules::find("fake").ok().flatten();
    let pastes: Vec<_> = window
        .tape
        .tokens
        .iter()
        .filter_map(|(us, token)| {
            let Token::Paste(paste) = token else {
                return None;
            };
            if !is_facades(&paste.text) {
                return None;
            }
            let expected = paste.displayed();
            let shown = window
                .tape
                .boxes
                .iter()
                .find(|(at, shown)| *at >= *us && *shown == expected)?
                .0;
            let settle = facade_rules::settle_time(&fake_rule?.paste, &paste.text);
            let ready = shown + settle.as_micros() as u64;
            let submitted = window
                .tape
                .submissions
                .iter()
                .find(|submission| {
                    submission.us >= shown
                        && submission.pieces.iter().any(|piece| match piece {
                            Piece::Pasted(text) | Piece::Typed(text) => *text == paste.text,
                        })
                })
                .map_or(ready, |submission| submission.us);
            Some((paste.began_us, submitted.max(ready), ready - paste.began_us))
        })
        .collect();
    if given == got {
        let mut worst = (0.0, 0.0);
        for ((_, sent), (_, read)) in person.chars.iter().zip(&read) {
            let delay = read.saturating_sub(*sent) as f64 / 1000.0;
            late.push(delay);
            // Only a paste that could have held this key contributes to its allowance.
            let paste_and_settle = pastes
                .iter()
                .filter(|(began, until, _)| *began <= *read && *until >= *sent)
                .map(|(_, _, took)| *took)
                .max()
                .unwrap_or(0) as f64
                / 1000.0;
            let allowed = paste_and_settle + 200.0;
            if delay - allowed > worst.0 - worst.1 {
                worst = (delay, allowed);
            }
        }
        if worst.0 > worst.1 {
            say(
                "I13",
                format!(
                    "{}: a key reached the CLI {:.0} ms late, beyond the {:.0} ms the CLI's reading \
                     of a message, its settle time and 200 ms allow",
                    window.agent, worst.0, worst.1
                ),
                None,
            );
        }
    } else {
        let at = given
            .chars()
            .zip(got.chars())
            .take_while(|(a, b)| a == b)
            .count();
        let near =
            |text: &str| -> String { text.chars().skip(at.saturating_sub(12)).take(40).collect() };
        say(
            "I13",
            format!(
                "{}: the person typed {} characters and the CLI read {}; they part at {at}: typed \
                 {:?}, read {:?}",
                window.agent,
                given.chars().count(),
                got.chars().count(),
                near(&given),
                near(&got)
            ),
            None,
        );
    }
    let pastes: Vec<String> = window
        .tape
        .tokens
        .iter()
        .filter_map(|(_, token)| match token {
            Token::Paste(paste) => Some(paste.text.clone()),
            _ => None,
        })
        .filter(|text| !is_facades(text))
        .collect();
    if pastes != person.pastes {
        say(
            "I13",
            format!(
                "{}: the person pasted {} times and the CLI read {} pastes that are not Facade's; \
                 first unlike: {:?}",
                window.agent,
                person.pastes.len(),
                pastes.len(),
                pastes
                    .iter()
                    .find(|paste| !person.pastes.contains(paste))
                    .map(|paste| short(paste))
            ),
            None,
        );
    }
    // I10: a question stays until the person answers it.
    for (us, open) in &window.tape.menus {
        if !open
            && !person
                .answers
                .iter()
                .any(|at| *us + 5_000 >= *at && *us < *at + 2_000_000)
        {
            say(
                "I10",
                format!(
                    "{}: a question was answered, and not by the person",
                    window.agent
                ),
                None,
            );
        }
    }
    // Keys that type nothing reached the CLI too.
    for (byte, name) in [
        (0x7f, "Backspace"),
        (b'\t', "Tab"),
        (0x1b, "Escape"),
        (0x03, "Ctrl+C"),
    ] {
        let pressed = person.controls.iter().filter(|each| **each == byte).count();
        let read = window
            .tape
            .tokens
            .iter()
            .filter(|(_, token)| match token {
                Token::Control(read) => *read == byte || (byte == 0x7f && *read == 0x08),
                Token::Escape(read) => byte == 0x1b && read.len() == 1,
                _ => false,
            })
            .count();
        if read < pressed {
            say(
                "I13",
                format!(
                    "{}: the person pressed {name} {pressed} times and the CLI read {read}",
                    window.agent
                ),
                None,
            );
        }
    }
    // A line submitted as typed, alone.
    let lines: Vec<String> = window
        .tape
        .submissions
        .iter()
        .filter_map(|submission| match kind(submission) {
            Kind::Person(text) if !text.trim().is_empty() => Some(text),
            _ => None,
        })
        .collect();
    let mut wanted: Vec<String> = person.lines.clone();
    wanted.extend(person.pastes.iter().cloned());
    for line in &wanted {
        let times = lines
            .iter()
            .filter(|got| got.trim_end() == line.trim_end())
            .count();
        if times != 1 {
            say(
                "I9",
                format!(
                    "{}: the person's line {:?} was submitted {times} times as it was",
                    window.agent,
                    short(line)
                ),
                None,
            );
        }
    }
    json!({
        "habit_writes": person.writes, "others": person.others,
        "typed": person.chars.len(), "lines": person.lines.len(), "pastes": person.pastes.len(),
        "key_to_cli_ms": summary(late),
    })
}

pub fn summary(mut values: Vec<f64>) -> Value {
    if values.is_empty() {
        return Value::Null;
    }
    values.sort_by(f64::total_cmp);
    let at = |p: f64| values[((values.len() as f64 * p) as usize).min(values.len() - 1)];
    json!({
        "count": values.len(), "p50": round(at(0.5)), "p95": round(at(0.95)),
        "p99": round(at(0.99)), "max": round(at(1.0)),
    })
}

fn round(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}

pub fn short(text: &str) -> String {
    let mut out: String = text.chars().take(90).collect();
    if text.chars().count() > 90 {
        out.push('…');
    }
    out
}
