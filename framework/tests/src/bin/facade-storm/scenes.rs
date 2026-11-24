//! The storms, by set.

use std::path::Path;
use std::time::Duration;

use crate::person::{Habit, Way};
use crate::storm::{self, Outcome, Pace, Shape, Spec};

/// One storm of a set.
pub enum Storm {
    /// Senders to one recipient.
    Spec(Box<Spec>),
    /// A course of its own.
    Course(&'static str, fn(&str, &Path) -> anyhow::Result<Outcome>),
}

impl Storm {
    pub fn name(&self) -> &str {
        match self {
            Storm::Spec(spec) => &spec.name,
            Storm::Course(name, _) => name,
        }
    }

    /// Runs it under `name`.
    pub fn run(&self, name: &str, out: &Path) -> anyhow::Result<Outcome> {
        match self {
            Storm::Spec(spec) => storm::run(
                &Spec {
                    name: name.into(),
                    ..(**spec).clone()
                },
                out,
            ),
            Storm::Course(_, run) => run(name, out),
        }
    }
}

/// The storms of `set`, with `senders` and `each` in place of their own counts.
pub fn set(name: &str, senders: Option<usize>, each: Option<usize>) -> Option<Vec<Storm>> {
    if let Some(courses) = crate::more::set(name) {
        return Some(
            courses
                .into_iter()
                .map(|(name, run)| Storm::Course(name, run))
                .collect(),
        );
    }
    let mut specs = match name {
        "r0" => r0(),
        "h" => h(),
        "n" => n(),
        "busy" => busy(),
        "looks" => looks(),
        _ => return None,
    };
    for spec in &mut specs {
        if let Some(senders) = senders {
            spec.senders = senders;
        }
        if let Some(each) = each {
            spec.per_sender = each;
        }
    }
    Some(
        specs
            .into_iter()
            .map(|spec| Storm::Spec(Box::new(spec)))
            .collect(),
    )
}

/// Each way a person uses the window, while 50 messages come at one moment and while 20 wait; the
/// ways that type also with nothing coming, and with a CLI slow to draw.
fn h() -> Vec<Spec> {
    let lines = |key_ms| Habit::Lines {
        key_ms,
        chars: 20,
        pause_ms: 1200,
    };
    let paste = |chunk, gap_ms| Habit::Paste {
        chars: 600,
        chunk,
        gap_ms,
        pause_ms: 1500,
    };
    let habits: Vec<(&str, Habit, Way, bool)> = vec![
        ("H1 slow attach", lines(120), Way::Attach, true),
        ("H1 fast attach", lines(25), Way::Attach, true),
        ("H1 fast raw", lines(25), Way::Raw, true),
        ("H1 ime raw", Habit::Ime { pause_ms: 1200 }, Way::Raw, true),
        (
            "H2 half line raw",
            Habit::HalfLine {
                chars: 14,
                left_ms: 3000,
                pause_ms: 1200,
            },
            Way::Raw,
            true,
        ),
        ("H3 paste whole raw", paste(1 << 20, 0), Way::Raw, true),
        ("H3 paste chunked raw", paste(200, 20), Way::Raw, true),
        ("H3 paste slow chunks raw", paste(200, 100), Way::Raw, true),
        ("H3 paste attach", paste(1 << 20, 0), Way::Attach, true),
        (
            "H4 line at once raw",
            Habit::LineAtOnce {
                chars: 20,
                pause_ms: 1200,
            },
            Way::Raw,
            true,
        ),
        (
            "H4 line at once attach",
            Habit::LineAtOnce {
                chars: 20,
                pause_ms: 1200,
            },
            Way::Attach,
            true,
        ),
        (
            "H4 enter alone raw",
            Habit::Enter { every_ms: 370 },
            Way::Raw,
            false,
        ),
        (
            "H5 wheel attach",
            Habit::Wheel { hz: 10 },
            Way::Attach,
            false,
        ),
        (
            "H6 mouse attach",
            Habit::Mouse { hz: 20 },
            Way::Attach,
            false,
        ),
        (
            "H7 mouse focus raw",
            Habit::Mouse { hz: 20 },
            Way::Raw,
            false,
        ),
        (
            "H7 modifiers raw",
            Habit::Modifiers { hz: 10 },
            Way::Raw,
            false,
        ),
        ("H8 keys raw", Habit::Keys { hz: 5 }, Way::Raw, false),
        (
            "H8 backspace raw",
            Habit::Backspace { hz: 5 },
            Way::Raw,
            false,
        ),
        (
            "H9 resize attach",
            Habit::Resize { every_ms: 300 },
            Way::Attach,
            false,
        ),
        (
            "H9 resize editor",
            Habit::Resize { every_ms: 300 },
            Way::Editor,
            false,
        ),
        (
            "H10 reattach",
            Habit::Reattach { every_ms: 700 },
            Way::Attach,
            false,
        ),
        (
            "H13 menu raw",
            Habit::Menu {
                open_ms: 4000,
                pause_ms: 3000,
            },
            Way::Raw,
            true,
        ),
    ];
    let mut specs = Vec::new();
    for (name, habit, way, types) in habits {
        specs.push(with(&format!("{name} N2"), habit, way));
        specs.push(Spec {
            senders: 4,
            per_sender: 5,
            ..with(&format!("{name} queue"), habit, way)
        });
        if types {
            specs.push(Spec {
                senders: 0,
                stay: Duration::from_secs(12),
                ..with(&format!("{name} alone"), habit, way)
            });
            specs.push(Spec {
                draw_ms: 150,
                senders: 10,
                per_sender: 2,
                ..with(&format!("{name} slow draw"), habit, way)
            });
        }
    }
    // Two people of different window sizes.
    specs.push(Spec {
        others: vec![(Habit::Resize { every_ms: 900 }, Way::Editor)],
        ..with("H11 two viewers N2", lines(80), Way::Attach)
    });
    specs
}

/// Ten messages to stand-ins read by a real CLI's rule, idle and printing at each interval.
fn looks() -> Vec<Spec> {
    let mut specs = Vec::new();
    for cli in ["muse", "agy"] {
        specs.push(Spec {
            cli,
            senders: 10,
            ..Spec::new(&format!("{cli} idle"))
        });
        for every in [50u64, 90, 120, 160, 200, 250, 300, 400] {
            specs.push(Spec {
                cli,
                senders: 10,
                env: vec![
                    ("FAKECLI_STATUS", "1".to_string()),
                    ("FAKECLI_TURN_MS", "60000".to_string()),
                    ("FAKECLI_BUSY_MS", "60000".to_string()),
                    ("FAKECLI_BUSY_EVERY_MS", every.to_string()),
                ],
                ..Spec::new(&format!("{cli} busy every {every} ms"))
            });
        }
        // More lines, a longer wait for the key.
        specs.push(Spec {
            cli,
            senders: 5,
            shape: Shape::Lines(40),
            env: vec![
                ("FAKECLI_STATUS", "1".to_string()),
                ("FAKECLI_TURN_MS", "60000".to_string()),
                ("FAKECLI_BUSY_MS", "60000".to_string()),
                ("FAKECLI_BUSY_EVERY_MS", "500".to_string()),
            ],
            ..Spec::new(&format!("{cli} 40 lines busy every 500 ms"))
        });
    }
    specs
}

/// Ten messages to a CLI that prints a line at each interval while it works.
fn busy() -> Vec<Spec> {
    [10u64, 20, 35, 50, 70, 90, 120, 160, 250, 400]
        .into_iter()
        .flat_map(|every| {
            ["1", "0"].map(|sync| Spec {
                senders: 10,
                env: vec![
                    ("FAKECLI_STATUS", "1".to_string()),
                    ("FAKECLI_TURN_MS", "60000".to_string()),
                    ("FAKECLI_BUSY_MS", "60000".to_string()),
                    ("FAKECLI_BUSY_EVERY_MS", every.to_string()),
                    ("FAKECLI_SYNC", sync.to_string()),
                ],
                ..Spec::new(&format!("busy every {every} ms, sync {sync}"))
            })
        })
        .collect()
}

/// Many messages to one recipient: idle or busy, alone or with everything a person can do.
fn n() -> Vec<Spec> {
    let noise = || {
        vec![
            (Habit::Wheel { hz: 10 }, Way::Attach),
            (Habit::Mouse { hz: 15 }, Way::Raw),
            (Habit::Modifiers { hz: 5 }, Way::Raw),
            (Habit::Resize { every_ms: 800 }, Way::Editor),
        ]
    };
    let many = |name: &str, senders: usize, each: usize| Spec {
        senders,
        per_sender: each,
        ..Spec::new(name)
    };
    let base = vec![
        many("N1 10 to 1", 10, 1),
        many("N2 50 to 1", 50, 1),
        many("N3 5 by 20", 5, 20),
        Spec {
            pace: Pace::Every(1000),
            ..many("N4 5 a second for 60 s", 5, 60)
        },
        Spec {
            hogs: 15,
            ..many("N5 50 to 1 busy cores", 50, 1)
        },
        Spec {
            hogs: 15,
            ..many("N5 5 by 20 busy cores", 5, 20)
        },
        Spec {
            shape: Shape::Wide(4000),
            ..many("N6 5 of 4000", 5, 1)
        },
        Spec {
            shape: Shape::Chinese(4000),
            ..many("N6 5 of 4000 Chinese", 5, 1)
        },
        Spec {
            shape: Shape::Lines(500),
            ..many("N6 5 of 500 lines", 5, 1)
        },
        many("N7 100 to 1", 100, 1),
        many("N7 50 by 4", 50, 4),
        Spec {
            draw_ms: 1000,
            ..many("N9 20 to a slow CLI", 20, 1)
        },
        Spec {
            shape: Shape::Chinese(8000),
            ..many("V5 50 of 8000 Chinese", 50, 1)
        },
    ];
    let mut specs = Vec::new();
    for spec in base {
        let busy = vec![
            ("FAKECLI_STATUS", "1".to_string()),
            ("FAKECLI_TURN_MS", "60000".to_string()),
            ("FAKECLI_BUSY_MS", "60000".to_string()),
        ];
        specs.push(Spec {
            name: format!("{} noise", spec.name),
            others: noise(),
            ..spec.clone()
        });
        specs.push(Spec {
            name: format!("{} busy", spec.name),
            env: busy.clone(),
            ..spec.clone()
        });
        specs.push(Spec {
            name: format!("{} busy noise", spec.name),
            env: busy,
            others: noise(),
            ..spec.clone()
        });
        specs.push(spec);
    }
    specs
}

fn with(name: &str, habit: Habit, way: Way) -> Spec {
    Spec {
        person: Some((habit, way)),
        ..Spec::new(name)
    }
}

/// A recipient that prints every 110 ms and takes its input `echo_ms` after it read it.
fn slow_echo(name: &str, echo_ms: u64, habit: Habit) -> Spec {
    Spec {
        senders: 20,
        env: vec![
            ("FAKECLI_STATUS", "1".to_string()),
            ("FAKECLI_BUSY_MS", "60000".to_string()),
            ("FAKECLI_BUSY_EVERY_MS", "110".to_string()),
            ("FAKECLI_ECHO_MS", echo_ms.to_string()),
        ],
        draw_ms: echo_ms,
        ..with(name, habit, Way::Raw)
    }
}

/// Fifty messages at one moment to one recipient, with each way a person's bytes come in.
fn r0() -> Vec<Spec> {
    vec![
        Spec::new("N2 nobody"),
        with("N2 watching", Habit::Watch, Way::Attach),
        with("N2 wheel attach", Habit::Wheel { hz: 10 }, Way::Attach),
        with(
            "N2 typing attach",
            Habit::Lines {
                key_ms: 80,
                chars: 24,
                pause_ms: 400,
            },
            Way::Attach,
        ),
        with("N2 mouse raw", Habit::Mouse { hz: 20 }, Way::Raw),
        with(
            "N2 typing raw",
            Habit::Lines {
                key_ms: 80,
                chars: 24,
                pause_ms: 400,
            },
            Way::Raw,
        ),
        with("N2 modifiers raw", Habit::Modifiers { hz: 10 }, Way::Raw),
        // A waiting message's paste begins as the person's Enter empties the input; the Enter key
        // comes up after that.
        with(
            "N2 records attach",
            Habit::Records {
                hold_ms: 70,
                chars: 16,
                pause_ms: 500,
            },
            Way::Attach,
        ),
        with("N2 started still", Habit::Watch, Way::Started),
        with(
            "N2 started records",
            Habit::Records {
                hold_ms: 70,
                chars: 16,
                pause_ms: 1500,
            },
            Way::Started,
        ),
        with("N2 editor still", Habit::Watch, Way::Editor),
        with(
            "N2 editor resize",
            Habit::Resize { every_ms: 600 },
            Way::Editor,
        ),
        // The person's keys reach a CLI that is drawing something else, the input still the old one.
        slow_echo(
            "B1 typing, echo 200 ms",
            200,
            Habit::Lines {
                key_ms: 60,
                chars: 12,
                pause_ms: 900,
            },
        ),
        slow_echo(
            "B1 typing, echo 1000 ms",
            1000,
            Habit::Lines {
                key_ms: 60,
                chars: 12,
                pause_ms: 2500,
            },
        ),
        slow_echo(
            "B1 paste in chunks, echo 200 ms",
            200,
            Habit::Paste {
                chars: 900,
                chunk: 200,
                gap_ms: 40,
                pause_ms: 1500,
            },
        ),
        // Enter, and at once a key that clears or interrupts.
        with(
            "B2 enter and ctrl-c",
            Habit::EnterThen {
                byte: 0x03,
                every_ms: 430,
            },
            Way::Raw,
        ),
        with(
            "B2 enter and escape",
            Habit::EnterThen {
                byte: 0x1b,
                every_ms: 430,
            },
            Way::Raw,
        ),
        // The window dragged while a synchronized update stays open.
        Spec {
            env: vec![
                ("FAKECLI_STATUS", "1".to_string()),
                ("FAKECLI_BUSY_MS", "60000".to_string()),
                ("FAKECLI_BUSY_EVERY_MS", "110".to_string()),
                ("FAKECLI_OPEN_UPDATES", "1".to_string()),
            ],
            others: vec![(Habit::Resize { every_ms: 150 }, Way::Attach)],
            ..with(
                "B3 dragging, open updates",
                Habit::Resize { every_ms: 180 },
                Way::Editor,
            )
        },
        Spec {
            env: vec![
                ("FAKECLI_STATUS", "1".to_string()),
                ("FAKECLI_BUSY_MS", "60000".to_string()),
                ("FAKECLI_BUSY_EVERY_MS", "110".to_string()),
                ("FAKECLI_OPEN_UPDATES", "1".to_string()),
            ],
            senders: 10,
            ..Spec::new("B3 open updates alone")
        },
    ]
}
