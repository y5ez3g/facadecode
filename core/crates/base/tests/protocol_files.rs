//! Checks the published schemas, references, and TypeScript against the typed registries.
//! Regenerate with FACADE_REGENERATE=1 cargo test -p facade-base --test protocol_files.

use std::path::PathBuf;

use serde_json::json;

#[path = "support/codegen.rs"]
mod codegen;

#[test]
fn generated_protocol_files_match_rust_definitions() {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../protocol");
    let extension_ts = dir.join("../../extension/src/base/coreProtocol.ts");
    let files = codegen::generate_daemon_files()
        .into_iter()
        .chain(codegen::generate_keeper_files());
    let regenerate = std::env::var_os("FACADE_REGENERATE").is_some();
    for (name, text) in files {
        let expected = text.replace("\r\n", "\n");
        if regenerate {
            std::fs::write(dir.join(name), &expected).unwrap();
            if name == "protocol.ts" {
                std::fs::write(&extension_ts, &expected).unwrap();
            }
        }
        let kept = std::fs::read(dir.join(name)).unwrap_or_default();
        assert!(
            std::str::from_utf8(&kept).unwrap().replace("\r\n", "\n") == expected,
            "core/protocol/{name} differs from the Rust definitions. Run \
             FACADE_REGENERATE=1 cargo test -p facade-base --test protocol_files"
        );
        if name == "protocol.ts" {
            assert_eq!(
                kept,
                std::fs::read(&extension_ts).unwrap(),
                "the generated TypeScript copies must match byte for byte",
            );
        }
    }
}

#[test]
fn typescript_types_match_json_schemas() {
    use codegen::typescript_type;
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
    assert_eq!(
        typescript_type(&json!({
            "type": "object",
            "properties": { "cols": { "type": "integer" }, "report_activity": { "type": "boolean", "default": false } },
            "required": ["cols"],
            "oneOf": [
                { "type": "object", "properties": { "agent": { "type": "string" }, "reference": false },
                  "required": ["agent"] },
                { "type": "object", "properties": { "agent": false, "reference": { "$ref": "#/$defs/AgentRef" } },
                  "required": ["reference"] }
            ]
        })),
        "{ readonly cols: number; readonly report_activity?: boolean } & ({ readonly agent: string; readonly reference?: never } | \
         { readonly agent?: never; readonly reference: AgentRef })"
    );
}
