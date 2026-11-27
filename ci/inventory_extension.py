"""Discover standalone Extension interfaces from shipped declarations and handlers."""

import json
import re
from pathlib import Path


MANIFEST = "extension/package.json"
COMMANDS = "extension/src/ui/catalog.ts"
UI = "extension/src/ui/commands/index.ts"
AGENT_UI = "extension/src/ui/commands/agent.ts"
WINDOW = "extension/src/host/window.ts"
WINDOW_IDENTITY = "extension/src/base/windowIdentity.ts"
LEGACY_SUPERVISOR = "extension/src/host/migration/supervisor.ts"
PANEL_HOST = "extension/src/ui/panel.ts"
PANEL_PAGE = "extension/src/webview/panel.ts"
SETTINGS_SCHEMA = "extension/media/settings.schema.json"
FRAMEWORK_SETTINGS = "framework/crates/base/src/settings.rs"
FRAMEWORK_CLI_ENTRIES = "framework/crates/rules/src/command_line/entries.rs"
FRAMEWORK_MCP = "framework/crates/daemon/src/mcp/lines.rs"
FRAMEWORK_TOOLS = "framework/crates/base/src/texts/tools.json"

SEGMENT = re.compile(r"[A-Za-z0-9._-]+")


def _read(root: Path, path: str) -> str:
    return (root / path).read_text(encoding="utf-8")


def _json(root: Path, path: str):
    return json.loads(_read(root, path), object_pairs_hook=_unique_object)


def _unique_object(pairs: list[tuple]) -> dict:
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate JSON key {key!r}")
        result[key] = value
    return result


def _section(source: str, start: str, end: str, path: str) -> str:
    sections = re.findall(start + r"(.*?)" + end, source, re.MULTILINE | re.DOTALL)
    if len(sections) != 1:
        raise ValueError(f"{path}: expected one declaration matching {start}")
    return sections[0]


def _names(names, path: str, label: str) -> set[str]:
    entries = list(names)
    if not entries or any(not isinstance(name, str) or not name for name in entries):
        raise ValueError(f"{path}: empty or invalid {label}")
    if len(set(entries)) != len(entries):
        raise ValueError(f"{path}: duplicate entries in {label}")
    return set(entries)


def _literals(source: str) -> list[str]:
    return re.findall(r"""['"]([A-Za-z0-9][\w./-]*)['"]""", source)


def _require(source: str, path: str, *patterns: str) -> None:
    for pattern in patterns:
        if not re.search(pattern, source, re.MULTILINE):
            raise ValueError(f"{path}: cannot find {pattern}")


def _keys(source: str, path: str, label: str) -> set[str]:
    # These registries declare one leading property per line. Failing on unfamiliar
    # active lines prevents a computed or reformatted entry from quietly disappearing.
    source = re.sub(r"/\*.*?\*/", "", source, flags=re.DOTALL)
    names = []
    for line in source.splitlines():
        line = line.strip()
        if not line or line.startswith("//"):
            continue
        if line.startswith("...(typeof FACADE_TEST_MODE ") and label == "Webview frames":
            continue
        match = re.match(r"([\w$]+): ", line)
        if not match:
            raise ValueError(f"{path}: cannot parse {label} entry {line!r}")
        names.append(match[1])
    return _names(names, path, label)


def _add(rows: dict[str, str], boundary: str, kind: str, names, path: str) -> None:
    for name in _names(names, path, f"{boundary}/{kind}"):
        entry = ("extension", boundary, kind, name)
        if not all(SEGMENT.fullmatch(segment) for segment in entry):
            raise ValueError(f"{path}: invalid ID segments {entry!r}")
        key = "/".join(entry)
        if key in rows:
            raise ValueError(f"{path}: duplicate interface {key}")
        rows[key] = path


def _function(root: Path, path: str, name: str) -> str:
    return _section(_read(root, path), rf"^(?:export )?(?:async )?function {name}\(", r"^}$", path)


def _serving_registrations(path: str, source: str, implementation: str) -> list[str]:
    # Normalize literal member access before masking strings. Keep offsets for diagnostics.
    member = r"""(?P<member>\[\s*(?P<quote>['"])registerCommand(?P=quote)\s*\])"""
    non_code = r"""//[^\n]*|/\*[\s\S]*?\*/|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`"""

    def normalize(match: re.Match) -> str:
        replacement = ".registerCommand" if match["member"] else ""
        return replacement.ljust(len(match[0]))

    code = re.sub(member + "|" + non_code, normalize, source)
    forwarding = None
    if path == AGENT_UI:
        # The local on helper forwards its id parameter. Enumerate its call sites instead.
        forwards = list(re.finditer(
            r"\bconst\s+on\s*=\s*\(\s*id\s*:\s*string\b[^\n]*?=>\s*"
            r"vscode\s*\.\s*commands\s*\.\s*(?P<callee>registerCommand)\s*\(\s*id\s*,",
            code,
        ))
        if len(forwards) != 1:
            raise ValueError(f"{path}: cannot resolve {implementation} command helper on")
        forwarding = forwards[0].start("callee")

    calls = re.finditer(r"(\bregisterCommand|(?<![\w$.])on)\s*(\(|(?=[<?]))", code)
    command = re.compile(r"\s*COMMANDS\s*\.\s*(\w+)\s*,")
    names = []
    for call in calls:
        if call.start() == forwarding:
            continue
        supported = call[2] == "(" and (call[1] == "registerCommand" or forwarding is not None)
        name = command.match(code, call.end()) if supported else None
        if not name:
            excerpt = source[call.start():].strip().splitlines()[0][:100]
            raise ValueError(f"{path}: unrecognized {implementation} serving command registration {excerpt!r}")
        names.append(name[1])
    return names


def _commands(root: Path, rows: dict[str, str]) -> None:
    manifest = _json(root, MANIFEST)["contributes"]
    declared = _names((entry["command"] for entry in manifest["commands"]), MANIFEST, "command contributions")
    catalog = _section(_read(root, COMMANDS), r"^export const COMMANDS = {\n", r"^} as const;", COMMANDS)
    symbols = dict(re.findall(r"^\s*(\w+): '(facade\.[\w.]+)',?$", catalog, re.MULTILINE))
    if symbols.keys() != _keys(catalog, COMMANDS, "command catalog") or set(symbols.values()) != declared:
        raise ValueError(f"{MANIFEST}: contributed command IDs differ from {COMMANDS}")

    # The test-only TEST_COMMANDS live in the separate registerTestUi function.
    # Activation-error stubs also live outside the serving scopes listed here.
    handlers = [
        (UI, _function(root, UI, "registerFrameworkUi")),
        (AGENT_UI, _function(root, AGENT_UI, "registerFrameworkAgentCommands")),
        ("extension/src/ui/commands/worktree.ts", _read(root, "extension/src/ui/commands/worktree.ts")),
        ("extension/src/host/framework/settings.ts", _read(root, "extension/src/host/framework/settings.ts")),
        ("extension/src/host/framework/index.ts", _read(root, "extension/src/host/framework/index.ts")),
    ]
    registered = set()
    for path, source in handlers:
        names = _serving_registrations(path, source, "framework")
        if not names or set(names) - symbols.keys() or registered.intersection(symbols[name] for name in names):
            raise ValueError(f"{path}: invalid Facade Code Framework command registration {names!r}")
        commands = [symbols[name] for name in names]
        registered.update(commands)
        _add(rows, "vscode-framework", "command", commands, path)
    retired = declared - registered
    hidden = {entry["command"] for entry in manifest["menus"]["commandPalette"] if entry.get("when") == "false"}
    retained_ids = {"facade.continueSession", "facade.dismissAgent", "facade.showAgentLaunch"}
    if retired - (retained_ids & hidden):
        raise ValueError(f"{MANIFEST}: commands without a serving handler: {sorted(retired - (retained_ids & hidden))}")


def _window(root: Path, rows: dict[str, str]) -> None:
    registered = _names(re.findall(r"\bregisterCommand\(([A-Z_]+),", _read(root, WINDOW)),
                        WINDOW, "Window Component command registrations")
    declarations = dict(re.findall(r"^export const ([A-Z_]+_COMMAND) = '(facade\.[\w.]+)';$",
                                   _read(root, WINDOW_IDENTITY), re.MULTILINE))
    if declarations.keys() != registered:
        raise ValueError(f"{WINDOW}: Window Component declarations and registrations differ: {sorted(declarations.keys() ^ registered)}")
    _add(rows, "window-component-framework", "command", declarations.values(), WINDOW_IDENTITY)
    registration = _section(_read(root, WINDOW_IDENTITY), r"^export type TerminalRegistration = ", r"^\);", WINDOW_IDENTITY)
    kinds = []
    for values in re.findall(r"\breadonly kind: ((?:'[\w]+'(?: \| )?)+)", registration):
        kinds.extend(_literals(values))
    terminals = "extension/src/host/terminal/agentTerminals.ts"
    terminal_kinds = re.findall(r"\bkind: '([\w-]+)'", _read(root, terminals))
    if set(kinds) != set(terminal_kinds):
        raise ValueError(f"{WINDOW_IDENTITY}: terminal registration kinds differ from {terminals}")
    _add(rows, "window-component-framework", "registration", kinds, WINDOW_IDENTITY)


def _legacy_migration(root: Path, rows: dict[str, str]) -> None:
    source = _read(root, LEGACY_SUPERVISOR)
    requests = _section(source, r"^interface Requests {\n", r"^}", LEGACY_SUPERVISOR)
    names = _keys(requests, LEGACY_SUPERVISOR, "legacy migration requests")
    if names != {"hello", "list", "conversations"}:
        raise ValueError(f"{LEGACY_SUPERVISOR}: expected read-only released supervisor requests")
    _add(rows, "legacy-cutover", "request", names, LEGACY_SUPERVISOR)


def _panel(root: Path, rows: dict[str, str]) -> None:
    for path, table, direction in [
        (PANEL_HOST, "MESSAGES", "page-to-host"),
        (PANEL_PAGE, "INCOMING", "host-to-page"),
    ]:
        messages = _section(_read(root, path), rf"^const {table}: [^\n]+ = {{\n", r"^};", path)
        names = _keys(messages, path, "Webview frames")
        _add(rows, "webview-framework", direction, names, path)
    actions = _section(_read(root, PANEL_HOST), r"^const ACTS: [^\n]+ = {\n", r"^};", PANEL_HOST)
    actions = _keys(actions, PANEL_HOST, "Webview actions")
    protocol = "extension/src/webview/protocol.ts"
    declared = set(_literals(_section(_read(root, protocol), r"^export type Act = ", r";", protocol)))
    if actions != declared:
        raise ValueError(f"{PANEL_HOST}: Webview dispatch differs from {protocol}")
    _add(rows, "webview-framework", "action", actions, PANEL_HOST)


def _mcp(root: Path, rows: dict[str, str]) -> None:
    _add(rows, "mcp-framework", "tool", [entry["name"] for entry in _json(root, FRAMEWORK_TOOLS)], FRAMEWORK_TOOLS)
    source = _read(root, FRAMEWORK_MCP)
    dispatch = _section(source, r"\bmatch method {", r"^    };", FRAMEWORK_MCP)
    _add(rows, "mcp-framework", "request", [name.replace("/", ".") for name in re.findall(r'^\s*"([\w./-]+)" =>', dispatch, re.MULTILINE)], FRAMEWORK_MCP)
    notify = _section(source, r"^fn notice_message\(", r"^}", FRAMEWORK_MCP)
    methods = re.findall(r'Some\("(notifications/[\w./-]+)"\)', notify)
    # Initialization is a standard no-response notification, handled by the generic guard.
    _require(source, FRAMEWORK_MCP, r"if !message.contains_key\(\"id\"\)", r"`notifications/initialized`")
    _add(rows, "mcp-framework", "notification", ["notifications.initialized", *(method.replace("/", ".") for method in methods)], FRAMEWORK_MCP)
    if not methods:
        raise ValueError(f"{FRAMEWORK_MCP}: no explicit notification dispatch found")


def _settings(root: Path, rows: dict[str, str]) -> None:
    contributions = _json(root, MANIFEST)["contributes"]
    settings = _names(
        (key for section in contributions["configuration"] for key in section["properties"]), MANIFEST, "VS Code settings",
    )
    _add(rows, "configuration-framework", "vscode", settings, MANIFEST)
    schema = _json(root, SETTINGS_SCHEMA)
    properties = schema["properties"]
    framework = _section(_read(root, FRAMEWORK_SETTINGS), r"^const SETTINGS: [^\n]+ = \[\n", r"^\];", FRAMEWORK_SETTINGS)
    framework_fields = set(re.findall(r'^\s*\("([\w$]+)",', framework, re.MULTILINE))
    if framework_fields != set(properties):
        raise ValueError(f"{SETTINGS_SCHEMA}: facade.json keys differ from {FRAMEWORK_SETTINGS}")
    files = _names(re.findall(r'^pub const SETTINGS_FILE: &str = "([\w.]+)";$', _read(root, FRAMEWORK_SETTINGS), re.MULTILINE),
                   FRAMEWORK_SETTINGS, "settings filename")
    schema_path = "./" + SETTINGS_SCHEMA.removeprefix("extension/")
    associations = {
        pattern
        for validation in contributions["jsonValidation"] if validation["url"] == schema_path
        for pattern in validation["fileMatch"]
    }
    if associations != {f"**/{file}" for file in files}:
        raise ValueError(f"{MANIFEST}: facade.json validation does not point to {SETTINGS_SCHEMA}")
    clis = properties["clis"]
    definitions = schema["definitions"]
    built_ins = clis["properties"]
    added = definitions[clis["additionalProperties"]["$ref"].removeprefix("#/definitions/")]
    adapters = added["properties"]["type"]["enum"]
    if {condition["if"]["properties"]["type"]["const"] for condition in added["allOf"] if "if" in condition} != set(adapters):
        raise ValueError(f"{SETTINGS_SCHEMA}: added CLI types and conditional schemas differ")
    variants = [definitions[item["$ref"].removeprefix("#/definitions/")] for item in built_ins.values()]
    variants.extend(
        definitions[rule["then"]["$ref"].removeprefix("#/definitions/")]
        for rule in added["allOf"] if "then" in rule
    )
    cli_fields = {key for variant in variants for key in variant["properties"]}
    framework_entries = _read(root, FRAMEWORK_CLI_ENTRIES)
    framework_cli_fields = set(_literals(_section(framework_entries, r"^const FIELDS: [^\n]+ = \[\n", r"^\];", FRAMEWORK_CLI_ENTRIES)))
    framework_cli_fields.update(re.findall(r'field.key != "(\w+)" && !FIELDS', framework_entries))
    if cli_fields != framework_cli_fields:
        raise ValueError(f"{SETTINGS_SCHEMA}: CLI fields differ from {FRAMEWORK_CLI_ENTRIES}")
    boundary = "configuration-framework"
    _add(rows, boundary, "document", files, FRAMEWORK_SETTINGS)
    _add(rows, boundary, "field", [key.lstrip("$") for key in properties], FRAMEWORK_SETTINGS)
    _add(rows, boundary, "built-in", built_ins, SETTINGS_SCHEMA)
    _add(rows, boundary, "adapter", adapters, SETTINGS_SCHEMA)
    _add(rows, boundary, "cli-field", cli_fields, SETTINGS_SCHEMA)

    paths = "extension/src/record/paths.ts"
    environment = re.findall(r"^export const FACADE_HOME_VARIABLE = '([A-Z_]+)';$", _read(root, paths), re.MULTILINE)
    _add(rows, boundary, "environment", environment, paths)


def discover(root: Path) -> dict[str, str]:
    """Map stable IDs to authoritative repository-relative source paths."""
    rows: dict[str, str] = {}
    for surface in (_commands, _window, _legacy_migration, _panel, _mcp, _settings):
        try:
            surface(root, rows)
        except (OSError, TypeError, KeyError, ValueError) as error:
            raise ValueError(f"Extension inventory {surface.__name__[1:]}: {error}") from error
    return dict(sorted(rows.items()))
