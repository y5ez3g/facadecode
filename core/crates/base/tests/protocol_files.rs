//! Checks the generated files in `core/protocol/` against the Rust types: JSON Schema, TypeScript
//! types, and both protocol references. Regenerate with
//! `FACADE_REGENERATE=1 cargo test -p facade-base --test protocol_files`.

use std::path::PathBuf;

use serde_json::json;

#[path = "support/codegen.rs"]
mod codegen;

use codegen::{generate_daemon_files, generate_keeper_reference, typescript_type};

#[test]
fn generated_protocol_files_match_rust_definitions() {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../protocol");
    let mut files = generate_daemon_files();
    files.push(generate_keeper_reference());
    if std::env::var_os("FACADE_REGENERATE").is_some() {
        std::fs::create_dir_all(&dir).unwrap();
        for (name, text) in &files {
            std::fs::write(dir.join(name), text.replace("\r\n", "\n")).unwrap();
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
}
