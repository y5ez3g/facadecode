//! The help lint: groups, summaries, examples and words of every public help page, from the
//! command definitions.

use crate::cli::cli;
use crate::help::{GROUPS, PAGES, Page};

/// Every public page under the root, by its command path: the visible commands and their visible
/// subcommands, without `help`.
fn pages() -> Vec<(String, clap::Command)> {
    fn visible(command: &clap::Command) -> impl Iterator<Item = &clap::Command> {
        command
            .get_subcommands()
            .filter(|sub| !sub.is_hide_set() && sub.get_name() != "help")
    }
    let root = cli();
    let mut pages = Vec::new();
    for command in visible(&root) {
        pages.push((command.get_name().to_string(), command.clone()));
        for sub in visible(command) {
            pages.push((
                format!("{} {}", command.get_name(), sub.get_name()),
                sub.clone(),
            ));
        }
    }
    pages
}

/// The page as `facade <path> --help` prints it, or the root page for an empty path.
fn rendered(path: &str) -> String {
    let argv = std::iter::once("facade")
        .chain(path.split_whitespace())
        .chain(["--help"]);
    match cli().try_get_matches_from(argv) {
        Err(error) if error.kind() == clap::error::ErrorKind::DisplayHelp => error.to_string(),
        other => panic!("facade {path} --help printed no help: {other:?}"),
    }
}

/// A command line split as a shell splits it: at spaces outside double quotes, the quotes
/// removed.
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
            c => (word, any) = (word + &c.to_string(), true),
        }
    }
    if any {
        words.push(word);
    }
    words
}

#[test]
fn every_visible_root_command_is_in_exactly_one_group() {
    let root = cli();
    let commands: Vec<&str> = root
        .get_subcommands()
        .filter(|sub| !sub.is_hide_set() && sub.get_name() != "help")
        .map(|sub| sub.get_name())
        .collect();
    let grouped: Vec<&str> = GROUPS
        .iter()
        .flat_map(|(_, names)| names.iter().copied())
        .collect();
    for command in &commands {
        assert_eq!(
            grouped.iter().filter(|name| *name == command).count(),
            1,
            "{command} must be in exactly one group: {GROUPS:?}"
        );
    }
    for name in &grouped {
        assert!(
            commands.contains(name),
            "group entry {name} is no visible command"
        );
    }
}

#[test]
fn every_summary_is_short_with_no_period_or_backtick() {
    for (path, command) in pages() {
        let about = command
            .get_about()
            .map(|about| about.to_string())
            .unwrap_or_default();
        assert!(
            !about.is_empty()
                && about.chars().count() <= 50
                && !about.ends_with('.')
                && !about.contains('`')
                && about.starts_with(|c: char| c.is_uppercase()),
            "{path}: {about:?}"
        );
    }
}

#[test]
fn every_page_has_commented_examples_that_start_plain() {
    let paths: Vec<String> = pages().into_iter().map(|(path, _)| path).collect();
    for path in &paths {
        let examples = PAGES
            .iter()
            .find(|page| page.path == path)
            .map(|page| page.examples)
            .unwrap_or_else(|| panic!("{path} has no examples"));
        assert!(!examples.is_empty(), "{path} has no examples");
        assert!(
            !examples[0].line.contains("--json"),
            "{path}'s first example uses --json: {}",
            examples[0].line
        );
        for example in examples {
            let comment = example.comment;
            assert!(
                comment.starts_with(|c: char| c.is_uppercase())
                    && !comment.ends_with('.')
                    && !comment.starts_with('#'),
                "{path}: comment {comment:?}"
            );
            // A direct example is a facade command line; one with shell operators runs facade
            // inside them, as `source <(facade completion bash)`.
            let shown = match example.argv {
                Some(_) => example.line.starts_with("facade "),
                None => example.line.contains("facade "),
            };
            assert!(shown, "{path}: {}", example.line);
        }
        let page = rendered(path);
        let shown = page
            .split_once("\nExamples:\n")
            .unwrap_or_else(|| panic!("{path} shows no Examples section:\n{page}"))
            .1;
        // Compared without line breaks, which the terminal's width may move.
        let flat = |text: &str| text.split_whitespace().collect::<Vec<_>>().join(" ");
        let shown = flat(shown);
        for example in examples {
            assert!(
                shown.contains(&flat(&format!("# {} {}", example.comment, example.line))),
                "{path} does not show {example:?}:\n{shown}",
                example = (example.comment, example.line)
            );
        }
    }
    for page in PAGES {
        let page = page.path;
        assert!(
            paths.iter().any(|path| path == page),
            "a page of no command: {page}"
        );
    }
}

/// Each direct example parses as the command it shows; an example with a pipe, substitution or
/// redirection is run in its shell instead, and says so by having no argv.
#[test]
fn every_direct_example_parses_and_matches_its_argv() {
    for Page {
        path: page,
        examples,
        ..
    } in PAGES
    {
        for example in *examples {
            match example.argv {
                Some(argv) => {
                    assert_eq!(
                        words(example.line)[1..],
                        argv.iter().map(|word| word.to_string()).collect::<Vec<_>>(),
                        "{page}: the argv is not the line's"
                    );
                    let parsed = cli().try_get_matches_from(
                        std::iter::once("facade").chain(argv.iter().copied()),
                    );
                    assert!(
                        parsed.is_ok(),
                        "{page}: {} does not parse: {parsed:?}",
                        example.line
                    );
                }
                None => assert!(
                    ["|", "$(", "<(", ">"]
                        .iter()
                        .any(|operator| example.line.contains(operator)),
                    "{page}: {} has no argv but no shell operator either",
                    example.line
                ),
            }
        }
    }
}

/// No public page holds a word the copy never allows, a reason code, or `facade.exe`.
#[test]
fn no_page_holds_a_word_the_copy_never_allows() {
    const NEVER: &[&str] = &[
        "rule",
        "rules",
        "record",
        "records",
        "typist",
        "island",
        "islands",
        "protocol",
        "submission",
        "reach",
        "reaches",
        "reached",
    ];
    let mut paths: Vec<String> = pages().into_iter().map(|(path, _)| path).collect();
    paths.push(String::new());
    for path in paths {
        let page = rendered(&path);
        let lower = page.to_lowercase();
        let found: Vec<&str> = lower
            .split(|c: char| !(c.is_alphanumeric() || c == '_' || c == '.'))
            .map(|word| word.trim_end_matches('.'))
            .filter(|word| {
                NEVER.contains(word)
                    || *word == "facade.exe"
                    || (word.contains('_')
                        && word.chars().all(|c| c.is_ascii_lowercase() || c == '_'))
            })
            .collect();
        assert!(
            found.is_empty(),
            "facade {path} --help says {found:?}:\n{page}"
        );
        let collapsed = lower.split_whitespace().collect::<Vec<_>>().join(" ");
        assert!(
            !collapsed.contains("take over") && !collapsed.contains("takes over"),
            "facade {path} --help says take over:\n{page}"
        );
    }
}

/// `-h`, `--help` and `help <command>` print one text.
#[test]
fn every_way_of_asking_prints_one_page() {
    for (path, _) in pages() {
        let parts: Vec<&str> = path.split_whitespace().collect();
        let asked = |argv: Vec<&str>| match cli()
            .try_get_matches_from(std::iter::once("facade").chain(argv.iter().copied()))
        {
            Err(error) if error.kind() == clap::error::ErrorKind::DisplayHelp => error.to_string(),
            other => panic!("facade {argv:?} printed no help: {other:?}"),
        };
        let long = asked(parts.iter().copied().chain(["--help"]).collect());
        assert_eq!(
            asked(parts.iter().copied().chain(["-h"]).collect()),
            long,
            "{path}"
        );
        assert_eq!(
            asked(["help"].into_iter().chain(parts.iter().copied()).collect()),
            long,
            "{path}"
        );
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

/// `list` answers to `ls` and `remove` to `rm`, and their pages name the alias; no other page has
/// one.
#[test]
fn aliases_are_named_on_their_pages() {
    let aliases: Vec<(&str, &str)> = PAGES
        .iter()
        .filter_map(|page| Some((page.path, page.alias?)))
        .collect();
    assert_eq!(aliases, [("list", "ls"), ("remove", "rm")]);
    for (path, _) in pages() {
        let alias = PAGES
            .iter()
            .find(|page| page.path == path)
            .and_then(|page| page.alias);
        let named = rendered(&path)
            .lines()
            .find(|line| line.starts_with("Alias:"))
            .map(str::to_string);
        assert_eq!(
            named,
            alias.map(|alias| format!("Alias: facade {alias}")),
            "{path}"
        );
        if let Some(alias) = alias {
            assert_eq!(rendered(alias), rendered(&path), "{alias}");
        }
    }
}
