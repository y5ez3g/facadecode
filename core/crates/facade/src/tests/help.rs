//! Public help pages, routing and the argv of the examples they show.

use std::ffi::OsString;

use crate::cli::{Command, parse_from};
use crate::help::{PAGES, Page, page};

const MACHINE: &str = "laptop";

fn asking_for(words: &[&str]) -> &'static Page {
    let argv: Vec<_> = std::iter::once("facade")
        .chain(words.iter().copied())
        .map(OsString::from)
        .collect();
    let parsed = parse_from(&argv).unwrap_or_else(|error| panic!("{words:?}: {error:?}"));
    let Some(Command::Help(page)) = parsed.command else {
        panic!("{words:?}: expected a help page");
    };
    page
}

/// Splits the documented examples at spaces outside double quotes.
fn words(line: &str) -> Vec<String> {
    let (mut words, mut word, mut quoted, mut any) = (Vec::new(), String::new(), false, false);
    for c in line.chars() {
        match c {
            '"' => (quoted, any) = (!quoted, true),
            ' ' if !quoted => {
                if any {
                    words.push(std::mem::take(&mut word));
                }
                any = false;
            }
            c => {
                word.push(c);
                any = true;
            }
        }
    }
    if any {
        words.push(word);
    }
    words
}

#[test]
fn every_visible_root_command_is_in_exactly_one_group() {
    let rendered = page("").unwrap().render(MACHINE);
    let groups = rendered.split_once("\nAgents\n").unwrap().1;
    let groups = groups.split_once("\nOptions\n").unwrap().0;
    let names: Vec<_> = groups
        .lines()
        .filter_map(|line| {
            let item = line.strip_prefix("  ")?;
            let (name, summary) = item.split_once("  ")?;
            let summary = summary.trim();
            assert!(
                !summary.is_empty()
                    && summary.chars().count() <= 50
                    && !summary.ends_with('.')
                    && !summary.contains('`')
                    && summary.starts_with(char::is_uppercase),
                "{name}: {summary:?}"
            );
            Some(name)
        })
        .collect();
    let commands: Vec<_> = PAGES
        .iter()
        .map(|page| page.path)
        .filter(|path| !path.is_empty() && !path.contains(' '))
        .collect();
    assert_eq!(names.len(), commands.len(), "{names:?}");
    assert_eq!(names[..5], ["start", "stop", "list", "resume", "rename"]);
    for command in commands {
        assert_eq!(names.iter().filter(|name| **name == command).count(), 1);
    }
}

#[test]
fn every_page_has_examples_that_parse() {
    for page in PAGES {
        let rendered = page.render(MACHINE);
        let examples = rendered
            .split_once("\nExamples\n")
            .unwrap_or_else(|| panic!("missing examples in {rendered}"))
            .1
            .split_once("\n\n")
            .unwrap()
            .0;
        let first = examples.lines().next().unwrap().trim();
        assert_eq!(first, page.first_example(), "{rendered}");
        for example in examples.lines() {
            let argv: Vec<_> = words(example.trim())
                .into_iter()
                .map(OsString::from)
                .collect();
            assert_eq!(argv.first().unwrap(), "facade", "{example}");
            assert!(
                !example.contains("--json"),
                "an example uses the retired JSON option: {example}"
            );
            let parsed = parse_from(&argv).unwrap_or_else(|error| panic!("{example}: {error:?}"));
            assert!(
                !matches!(
                    parsed.command,
                    None | Some(Command::Help(_) | Command::PrintVersion)
                ),
                "{example}: expected a command"
            );
        }
    }
}

#[test]
fn every_way_of_asking_prints_one_page() {
    for page in PAGES {
        let parts: Vec<_> = page.path.split_whitespace().collect();
        let expected = page.render(MACHINE);
        for option in ["-h", "--help"] {
            let args = [parts.as_slice(), &[option]].concat();
            assert_eq!(asking_for(&args).render(MACHINE), expected, "{args:?}");
        }
        let args = [&["help"][..], parts.as_slice()].concat();
        assert_eq!(asking_for(&args).render(MACHINE), expected, "{args:?}");
    }
    assert_eq!(asking_for(&["stop"]).path, "stop");
    assert_eq!(asking_for(&["machine"]).path, "machine");
    assert_eq!(
        asking_for(&["machine", "help", "list"]).path,
        "machine list"
    );
    for hidden in ["link", "serve", "ssh-admin"] {
        assert!(page(&format!("machine {hidden}")).is_none());
    }
}

#[test]
fn help_uses_public_terms_and_spellings() {
    for page in PAGES {
        let rendered = page.render(MACHINE);
        let forbidden = [
            "typist",
            "island",
            "islands",
            "protocol",
            "submission",
            "facade.exe",
        ];
        let found: Vec<_> = rendered
            .split(|c: char| !(c.is_alphanumeric() || matches!(c, '_' | '.')))
            .map(|word| word.trim_end_matches('.'))
            .filter(|word| {
                forbidden.contains(word)
                    || (word.contains('_')
                        && word.chars().all(|c| c == '_' || c.is_ascii_lowercase()))
            })
            .collect();
        assert!(found.is_empty(), "{}: {found:?}", page.path);
    }
}

#[test]
fn the_shell_splits_example_lines_as_written() {
    assert_eq!(
        words(r#"facade rename a3 " ""#),
        ["facade", "rename", "a3", " "]
    );
    assert_eq!(
        words(r#"facade send a3 "Please review it""#),
        ["facade", "send", "a3", "Please review it"]
    );
}
