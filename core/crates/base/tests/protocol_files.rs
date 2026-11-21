//! Checks the generated files in `core/protocol/` against the Rust types: JSON Schema, TypeScript
//! types, and both protocol references. Regenerate with
//! `FACADE_REGENERATE=1 cargo test -p facade-base --test protocol_files`.

use std::path::PathBuf;

use facade_base::daemon::WatchResult;
use facade_base::jsonrpc::{Reason, decode_arguments};
use facade_base::v3::{
    AgentResizeArgs, AgentTarget, AttachResizeArgs, ForwardAttachResizeArgs, ForwardWatchResult,
    LegacyWorkspaceArgs, MachineConnectArgs, MachineRemoveArgs, ResumeArgs,
};
use serde_json::json;

#[path = "support/codegen.rs"]
mod codegen;

use codegen::{generate_daemon_files, generate_keeper_reference, typescript_type};

#[test]
fn generated_protocol_files_match_rust_definitions() {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../protocol");
    let extension_ts = dir.join("../../extension/src/base/coreProtocol.ts");
    let mut files = generate_daemon_files();
    files.push(generate_keeper_reference());
    if std::env::var_os("FACADE_REGENERATE").is_some() {
        std::fs::create_dir_all(&dir).unwrap();
        for (name, text) in &files {
            let text = text.replace("\r\n", "\n");
            std::fs::write(dir.join(name), &text).unwrap();
            if *name == "protocol.ts" {
                std::fs::write(&extension_ts, text).unwrap();
            }
        }
    }
    for (name, text) in &files {
        // A checkout may turn line endings into CRLF, as Git does on Windows: the files', and the
        // guide's that the generated text takes in.
        let kept = std::fs::read_to_string(dir.join(name))
            .unwrap_or_default()
            .replace("\r\n", "\n");
        assert!(
            kept == text.replace("\r\n", "\n"),
            "core/protocol/{name} differs from the Rust definitions; regenerate with \
             FACADE_REGENERATE=1 cargo test -p facade-base --test protocol_files"
        );
    }
    assert_eq!(
        std::fs::read(dir.join("protocol.ts")).unwrap(),
        std::fs::read(extension_ts).unwrap(),
        "the generated TypeScript copies must match byte for byte",
    );
}

#[test]
fn typescript_types_match_json_schemas() {
    // Check tuples, typed maps, empty objects, unions, arbitrary JSON, and nullable fields.
    assert_eq!(
        typescript_type(&json!({
            "type": "array", "items": { "type": "integer" }, "minItems": 2, "maxItems": 2,
        })),
        "[number, number]"
    );
    assert_eq!(
        typescript_type(&json!({ "type": "object", "additionalProperties": { "type": "string" } })),
        "{ readonly [key: string]: string }"
    );
    assert_eq!(
        typescript_type(&json!({ "type": "object" })),
        "Record<string, never>"
    );
    assert_eq!(
        typescript_type(&json!({ "type": "string", "enum": ["running", "ended"] })),
        "'running' | 'ended'"
    );
    assert_eq!(typescript_type(&json!(true)), "unknown");
    assert!(
        std::panic::catch_unwind(|| typescript_type(&json!({ "not": {} }))).is_err(),
        "unsupported schema syntax must fail"
    );
    assert_eq!(
        typescript_type(&json!({ "type": ["integer", "null"] })),
        "number | null",
        "a required nullable field must retain null"
    );

    // The flattened target's choices must survive alongside the operation's own fields.
    assert_eq!(
        typescript_type(&json!({
            "type": "object",
            "properties": { "cols": { "type": "integer" } },
            "required": ["cols"],
            "oneOf": [
                { "type": "object", "properties": { "agent": { "type": "string" }, "reference": false },
                  "required": ["agent"] },
                { "type": "object", "properties": { "agent": false, "reference": { "$ref": "#/$defs/AgentRef" } },
                  "required": ["reference"] }
            ]
        })),
        "{ readonly cols: number } & ({ readonly agent: string; readonly reference?: never } | \
         { readonly agent?: never; readonly reference: AgentRef })"
    );
    let reference =
        json!({ "agent_id": "a3", "machine_id": "ea9b4046-77ad-4f4f-b8a9-84bfe619f360" });
    let address = json!({ "agent": "a3@devbox", "cols": 120, "rows": 30 });
    let exact = json!({ "reference": reference, "cols": 120, "rows": 30 });
    for (args, target) in [
        (
            address,
            AgentTarget::Address {
                agent: "a3@devbox".into(),
            },
        ),
        (
            exact,
            AgentTarget::Reference {
                reference: serde_json::from_value(reference.clone()).unwrap(),
            },
        ),
    ] {
        let decoded = decode_arguments::<AgentResizeArgs>(args.clone()).unwrap();
        assert_eq!(decoded.target, target);
        assert_eq!(serde_json::to_value(decoded).unwrap(), args);
    }
    for args in [
        json!({ "cols": 120, "rows": 30 }),
        json!({ "agent": "a3@devbox", "reference": reference, "cols": 120, "rows": 30 }),
        json!({ "agent": "a3@devbox", "reference": null, "cols": 120, "rows": 30 }),
    ] {
        assert_eq!(
            decode_arguments::<AgentResizeArgs>(args)
                .unwrap_err()
                .data
                .reason,
            Reason::InvalidArgument
        );
    }

    // The holder's viewer ID cannot replace the local watch ID in a public resize.
    let forwarded = json!({
        "viewer": 9, "boot_id": "ea9b4046-77ad-4f4f-b8a9-84bfe619f360", "cols": 120, "rows": 30,
    });
    let resize = decode_arguments::<ForwardAttachResizeArgs>(forwarded.clone()).unwrap();
    assert_eq!(serde_json::to_value(resize).unwrap(), forwarded);
    assert_eq!(
        decode_arguments::<AttachResizeArgs>(forwarded)
            .unwrap_err()
            .data
            .reason,
        Reason::InvalidArgument
    );
    let watch = json!({ "watch": 2, "snapshot": {} });
    let legacy_response = decode_arguments::<ForwardWatchResult>(watch.clone()).unwrap();
    assert!(legacy_response.attach.is_none());
    assert_eq!(serde_json::to_value(legacy_response).unwrap(), watch);
    let routed_watch = json!({
        "watch": 2,
        "snapshot": {},
        "attach": { "viewer": 9, "boot_id": "ea9b4046-77ad-4f4f-b8a9-84bfe619f360" },
    });
    let machine_response = decode_arguments::<ForwardWatchResult>(routed_watch.clone()).unwrap();
    assert_eq!(
        serde_json::to_value(machine_response).unwrap(),
        routed_watch
    );
    let public_response = decode_arguments::<WatchResult>(routed_watch).unwrap();
    assert_eq!(serde_json::to_value(public_response).unwrap(), watch);

    // Leave a supplied invalid ID intact for the daemon's saved-connection validation.
    let expected_id = json!({
        "transport": { "kind": "ssh", "ssh_destination": "alice@lab" },
        "kind": "saved",
        "expected_machine_id": "",
    });
    let connect = decode_arguments::<MachineConnectArgs>(expected_id.clone()).unwrap();
    assert_eq!(serde_json::to_value(connect).unwrap(), expected_id);

    let remove = json!({ "machine": "lab", "expected_machine_id": "" });
    let exact_remove = decode_arguments::<MachineRemoveArgs>(remove.clone()).unwrap();
    assert_eq!(serde_json::to_value(exact_remove).unwrap(), remove);
    let published_remove = json!({ "machine": "lab" });
    let legacy_remove =
        decode_arguments::<facade_base::machine::MachineRemoveArgs>(published_remove.clone())
            .unwrap();
    assert_eq!(
        serde_json::to_value(legacy_remove).unwrap(),
        published_remove
    );
    let current_remove = decode_arguments::<MachineRemoveArgs>(published_remove.clone()).unwrap();
    assert_eq!(
        serde_json::to_value(current_remove).unwrap(),
        published_remove
    );

    for args in [
        json!({ "machine_id": "dev-machine" }),
        json!({ "machine_id": "dev-machine", "workspace_key": "workspace", "window_id": "win-2" }),
    ] {
        assert_eq!(
            decode_arguments::<LegacyWorkspaceArgs>(args)
                .unwrap_err()
                .data
                .reason,
            Reason::InvalidArgument
        );
    }
    let conflicting = json!({
        "reference": "a3", "machine": "devbox", "machine_id": "dev-machine", "cols": 120, "rows": 30,
    });
    assert_eq!(
        decode_arguments::<ResumeArgs>(conflicting)
            .unwrap_err()
            .data
            .reason,
        Reason::InvalidArgument
    );
}
