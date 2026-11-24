//! The MCP text must fit the clients' model-context limits.

use facade_base::{instructions, tools};
use serde_json::Value;

#[test]
fn model_texts_fit_client_limits() {
    let definitions: Vec<Value> = serde_json::from_str(tools::DEFINITIONS).unwrap();
    for tool in definitions {
        let name = tool["name"].as_str().unwrap();
        let description = tool["description"].as_str().unwrap();
        let first_line = description.lines().next().unwrap();
        assert!(
            first_line.encode_utf16().count() <= 120,
            "{name}'s first line exceeds 120 UTF-16 units"
        );
        assert!(
            description.len() <= 1000,
            "{name}'s description exceeds 1,000 UTF-8 bytes"
        );
    }

    let guest = instructions::for_connection();
    assert!(
        guest.len() <= 1000,
        "the Guest instructions exceed 1,000 UTF-8 bytes"
    );
    assert!(
        guest.lines().next().unwrap().chars().count() <= 250,
        "the Guest instructions' first line exceeds 250 code points"
    );

    let machine = "m🧭".repeat(3000);
    let address = format!("a3@{machine}");
    let folder = format!("/{}", "p🧭".repeat(3000));
    for (yolo, reach) in [
        (
            true,
            "YOLO is on: your tools reach agents on all reachable machines.",
        ),
        (
            false,
            "YOLO is off: your tools reach only your creation tree, its first agent and every agent started under it.",
        ),
    ] {
        let short = instructions::for_managed(
            "a3@devbox",
            &instructions::ManagedRun {
                folder: "/work",
                machine: "devbox",
                creator: Some(instructions::Creator::CommandLine),
                yolo,
            },
        );
        let (fixed, _) = short.rsplit_once('\n').unwrap();
        assert!(
            fixed.lines().next().unwrap().chars().count() <= 250,
            "the managed instructions' first line exceeds 250 code points"
        );

        let long = instructions::for_managed(
            &address,
            &instructions::ManagedRun {
                folder: &folder,
                machine: &machine,
                creator: Some(instructions::Creator::Agent {
                    address: &format!("a1@{machine}"),
                    name: Some(&"Nova🧭".repeat(3000)),
                }),
                yolo,
            },
        );
        assert!(long.encode_utf16().count() > 4096);
        let visible = String::from_utf16_lossy(&long.encode_utf16().take(4096).collect::<Vec<_>>());
        assert!(
            visible.starts_with(&format!("{fixed}\n{reach}")),
            "all fixed instructions and the full reach sentence must fit in 4,096 UTF-16 units with YOLO {yolo}"
        );
    }
}
