"""Discover standalone Extension interfaces from shipped declarations and handlers."""

import json
import re
from pathlib import Path


MANIFEST = "extension/package.json"
COMMANDS = "extension/src/ui/catalog.ts"
UI = "extension/src/ui/commands/index.ts"
AGENT_UI = "extension/src/ui/commands/agent.ts"
WINDOW = "extension/src/host/window.ts"
WINDOW_CLIENT = "extension/src/host/client.ts"
WINDOW_IDENTITY = "extension/src/base/windowIdentity.ts"
WINDOW_NETWORK = "extension/src/base/windowNetwork.ts"
WINDOW_SOCKET = "extension/src/host/windowNetwork.ts"
WINDOW_ROUTES = "extension/src/contract/network.ts"
PTYD = "extension/src/ptyd/protocol.ts"
PANEL_HOST = "extension/src/ui/panel.ts"
PANEL_PAGE = "extension/src/webview/panel.ts"
SETTINGS_SCHEMA = "extension/media/settings.schema.json"
CORE_SETTINGS = "core/crates/base/src/settings.rs"
CORE_CLI_ENTRIES = "core/crates/rules/src/command_line/entries.rs"
OLD_MCP = "extension/src/transport/mcpServer.ts"
OLD_TOOLS = "extension/src/schema/tools.ts"
RUST_MCP = "core/crates/daemon/src/mcp/lines.rs"
RUST_TOOLS = "core/crates/base/src/texts/tools.json"

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


def _serving_registrations(path: str, source: str, engine: str) -> list[str]:
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
            raise ValueError(f"{path}: cannot resolve {engine} command helper on")
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
            raise ValueError(f"{path}: unrecognized {engine} serving command registration {excerpt!r}")
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
    handlers = {
        "old": [
            (UI, _function(root, UI, "registerUi")),
            (AGENT_UI, _function(root, AGENT_UI, "registerAgentCommands")),
            ("extension/src/ui/commands/worktree.ts", _read(root, "extension/src/ui/commands/worktree.ts")),
            ("extension/src/host/showLaunch.ts", _read(root, "extension/src/host/showLaunch.ts")),
            ("extension/src/host/agentsLog.ts", _read(root, "extension/src/host/agentsLog.ts")),
            ("extension/src/host/service.ts", _function(root, "extension/src/host/service.ts", "registerOpenSettingsFile")),
        ],
        "rust": [
            (UI, _function(root, UI, "registerOrchestratorUi")),
            (AGENT_UI, _function(root, AGENT_UI, "registerRustAgentCommands")),
            ("extension/src/host/rust/settings.ts", _read(root, "extension/src/host/rust/settings.ts")),
            ("extension/src/host/orchestrator/index.ts", _read(root, "extension/src/host/orchestrator/index.ts")),
        ],
    }
    registered = set()
    for engine, sources in handlers.items():
        seen = set()
        for path, source in sources:
            names = _serving_registrations(path, source, engine)
            if not names or set(names) - symbols.keys() or seen.intersection(names):
                raise ValueError(f"{path}: invalid {engine} command registration {names!r}")
            seen.update(names)
            _add(rows, f"vscode-{engine}", "command", [symbols[name] for name in names], path)
        registered.update(symbols[name] for name in seen)
    if registered != declared:
        raise ValueError(f"{MANIFEST}: contributed commands without a serving handler: {sorted(declared - registered)}")


def _window(root: Path, rows: dict[str, str]) -> None:
    registrations = []
    for path in (WINDOW, WINDOW_CLIENT):
        registrations.extend(_names(
            re.findall(r"\bregisterCommand\(([A-Z_]+),", _read(root, path)),
            path, "Window Component command registrations",
        ))
    registered = _names(registrations, WINDOW, "combined Window Component command registrations")
    declarations = set()
    rust = "extension/src/host/windowComponent.ts"
    rust_calls = set()
    for function in ("optionalTerminalOwner", "legacyWindowInstance"):
        rust_calls.update(_names(
            re.findall(r"\bexecuteCommand\(([A-Z_]+_COMMAND),", _function(root, rust, function)),
            rust, f"{function} command calls",
        ))
    for path in (WINDOW_IDENTITY, WINDOW_NETWORK):
        pairs = re.findall(r"^export const ([A-Z_]+_COMMAND) = '(facade\.[\w.]+)';$", _read(root, path), re.MULTILINE)
        declarations.update(_names((symbol for symbol, _ in pairs), path, "Window Component command declarations"))
        commands = dict(pairs)
        for engine in ("old", "rust"):
            names = [
                name for symbol, name in commands.items()
                if (symbol in rust_calls) == (engine == "rust") or symbol == "WINDOW_TERMINALS_COMMAND"
            ]
            if names:
                _add(rows, f"window-component-{engine}", "command", names, path)
    if declarations != registered:
        raise ValueError(f"{WINDOW}: Window Component declarations and registrations differ: {sorted(declarations ^ registered)}")
    if rust_calls - declarations:
        raise ValueError(f"{rust}: undeclared Window Component command calls: {sorted(rust_calls - declarations)}")
    registration = _section(_read(root, WINDOW_IDENTITY), r"^export type TerminalRegistration = ", r"^\);", WINDOW_IDENTITY)
    kinds = []
    for values in re.findall(r"\breadonly kind: ((?:'[\w]+'(?: \| )?)+)", registration):
        kinds.extend(_literals(values))
    terminals = "extension/src/host/execution/agentTerminals.ts"
    terminal_kinds = re.findall(r"\bkind: '([\w-]+)'", _read(root, terminals))
    if set(kinds) != set(terminal_kinds):
        raise ValueError(f"{WINDOW_IDENTITY}: terminal registration kinds differ from {terminals}")
    for engine in ("old", "rust"):
        _add(rows, f"window-component-{engine}", "registration", kinds, WINDOW_IDENTITY)


def _window_socket(root: Path, rows: dict[str, str]) -> None:
    source = _read(root, WINDOW_SOCKET)
    network = _read(root, WINDOW_NETWORK)
    _require(network, WINDOW_NETWORK, r"^export const WINDOW_NETWORK_PROTOCOL = \d+;$")
    # Socket envelopes are inline. Check both the writer and the receiving guard.
    for name, patterns in {
        "request": (
            r"JSON.stringify\(\{ id, protocol: WINDOW_NETWORK_PROTOCOL, from, op:",
            r"private accepted\(socket: net.Socket\)",
            r"Number.isSafeInteger\(request.id\)",
        ),
        "response": (
            r"JSON.stringify\(\{ id, \.\.\.response \}\)",
            r"private answered\(line: string\)",
            r"this.pending.get\(message.id as number\)",
        ),
    }.items():
        _require(source, WINDOW_SOCKET, *patterns)
        _add(rows, "window-socket-old", "frame", [name], WINDOW_SOCKET)
    reasons = _section(network, r"^export type RouteFailure = ", r";", WINDOW_NETWORK)
    _add(rows, "window-socket-old", "outcome", _literals(reasons), WINDOW_NETWORK)
    routes = _section(_read(root, WINDOW_ROUTES), r"^export type RouteOp =\n", r";", WINDOW_ROUTES)
    operations = _literals(re.sub(r"/\*.*?\*/", "", routes, flags=re.DOTALL))
    handler = "extension/src/contract/tools.ts"
    dispatch = _section(_read(root, handler), r"switch \(route.op\) {", r"^\t\t}", handler)
    if set(operations) != set(re.findall(r"case '([\w-]+)':", dispatch)):
        raise ValueError(f"{WINDOW_ROUTES}: RouteOp differs from {handler} dispatch")
    _add(rows, "window-socket-old", "operation", operations, WINDOW_ROUTES)


def _ptyd(root: Path, rows: dict[str, str]) -> None:
    source = _read(root, PTYD)
    requests = _section(source, r"^export interface Requests {\n", r"^}", PTYD)
    methods = _keys(requests, PTYD, "supervisor requests")
    handler = "extension/src/ptyd/server.ts"
    dispatch = _section(_read(root, handler), r"switch \(request.method\) {", r"^\t\t}", handler)
    if methods != set(re.findall(r"case '([\w-]+)':", dispatch)):
        raise ValueError(f"{PTYD}: supervisor requests differ from {handler} dispatch")
    _add(rows, "ptyd-old", "request", methods, PTYD)
    events = _section(source, r"^export interface OwnerEvent", r"^export function isPtydEvent", PTYD)
    kinds = re.findall(r"readonly event: '([\w-]+)'", events)
    validator = _function(root, PTYD, "isPtydEvent")
    validated = re.findall(r"(?:case |value\.event === )'([\w-]+)'", validator)
    if set(kinds) != set(validated):
        raise ValueError(f"{PTYD}: supervisor event declarations and validator differ")
    _add(rows, "ptyd-old", "event", kinds, PTYD)
    response = _section(source, r"^export type Response =", r"^\s*};", PTYD)
    _add(rows, "ptyd-old", "response", re.findall(r"readonly id: number; readonly (result|error):", response), PTYD)


def _panel(root: Path, rows: dict[str, str]) -> None:
    for path, table, direction in [
        (PANEL_HOST, "MESSAGES", "page-to-host"),
        (PANEL_PAGE, "INCOMING", "host-to-page"),
    ]:
        messages = _section(_read(root, path), rf"^const {table}: [^\n]+ = {{\n", r"^};", path)
        names = _keys(messages, path, "Webview frames")
        for engine in ("old", "rust"):
            _add(rows, f"webview-{engine}", direction, names, path)
    actions = _section(_read(root, PANEL_HOST), r"^const ACTS: [^\n]+ = {\n", r"^};", PANEL_HOST)
    actions = _keys(actions, PANEL_HOST, "Webview actions")
    protocol = "extension/src/webview/protocol.ts"
    command_source = _read(root, protocol)
    shared = set(_literals(_section(command_source, r"^export type Act = ", r";", protocol)))
    direct = set(_literals(_section(command_source, r"^export type PageAct = Act \| ", r";", protocol)))
    if actions != shared | direct:
        raise ValueError(f"{PANEL_HOST}: Webview dispatch differs from {protocol}")
    _add(rows, "webview-old", "action", shared, PANEL_HOST)
    _add(rows, "webview-rust", "action", actions, PANEL_HOST)


def _mcp(root: Path, rows: dict[str, str]) -> None:
    old_tools = _read(root, OLD_TOOLS)
    catalog = _section(old_tools, r"^export const TOOLS: [^\n]+ = \[\n", r"^\];", OLD_TOOLS)
    names = _names(re.findall(r"^\s*name: '([a-z_]+)',", catalog, re.MULTILINE), OLD_TOOLS, "advertised tools")
    declared = _section(old_tools, r"^export type ToolName = ", r";", OLD_TOOLS)
    if names != set(_literals(declared)):
        raise ValueError(f"{OLD_TOOLS}: ToolName and advertised tool catalog differ")
    service = "extension/src/contract/tools.ts"
    handlers = _section(_read(root, service), r"^\tprivate readonly handlers: [^\n]+ = {\n", r"^\t};", service)
    if names != _keys(handlers, service, "MCP tool dispatch"):
        raise ValueError(f"{OLD_TOOLS}: advertised tools differ from {service} dispatch")
    _add(rows, "mcp-old", "tool", names, OLD_TOOLS)
    _add(rows, "mcp-rust", "tool", [entry["name"] for entry in _json(root, RUST_TOOLS)], RUST_TOOLS)

    source = _read(root, OLD_MCP)
    dispatch = _section(source, r"\bswitch \(method\) {", r"^\t\t}", OLD_MCP)
    _add(rows, "mcp-old", "request", [name.replace("/", ".") for name in re.findall(r"^\s*case '([\w./-]+)':", dispatch, re.MULTILINE)], OLD_MCP)
    _require(source, OLD_MCP, r"if \(id === undefined\)", r"A notification - initialized, cancelled")
    _add(rows, "mcp-old", "notification", ["notifications.initialized"], OLD_MCP)

    source = _read(root, RUST_MCP)
    dispatch = _section(source, r"\bmatch method {", r"^    };", RUST_MCP)
    _add(rows, "mcp-rust", "request", [name.replace("/", ".") for name in re.findall(r'^\s*"([\w./-]+)" =>', dispatch, re.MULTILINE)], RUST_MCP)
    notify = _section(source, r"^fn notice_message\(", r"^}", RUST_MCP)
    methods = re.findall(r'Some\("(notifications/[\w./-]+)"\)', notify)
    # Initialization is a standard no-response notification, handled by the generic guard.
    _require(source, RUST_MCP, r"if !message.contains_key\(\"id\"\)", r"`notifications/initialized`")
    _add(rows, "mcp-rust", "notification", ["notifications.initialized", *(method.replace("/", ".") for method in methods)], RUST_MCP)
    if not methods:
        raise ValueError(f"{RUST_MCP}: no explicit notification dispatch found")


def _settings(root: Path, rows: dict[str, str]) -> None:
    contributions = _json(root, MANIFEST)["contributes"]
    settings = _names(
        (key for section in contributions["configuration"] for key in section["properties"]), MANIFEST, "VS Code settings",
    )
    # Facade: Home is applied by the old engine. The selector is read before the
    # engine branches. Keep other manifest settings visible for catalog review.
    _add(rows, "configuration-old", "vscode", settings & {"facade.home"}, MANIFEST)
    _add(rows, "configuration", "vscode", settings - {"facade.home"}, MANIFEST)
    schema = _json(root, SETTINGS_SCHEMA)
    properties = schema["properties"]
    core = _section(_read(root, CORE_SETTINGS), r"^const SETTINGS: [^\n]+ = \[\n", r"^\];", CORE_SETTINGS)
    core_fields = set(re.findall(r'^\s*\("([\w$]+)",', core, re.MULTILINE))
    if core_fields != set(properties):
        raise ValueError(f"{SETTINGS_SCHEMA}: facade.json keys differ from {CORE_SETTINGS}")
    old = "extension/src/clis/settingsFile.ts"
    file_pattern = r"""^export const SETTINGS_FILE = '([\w.]+)';$"""
    old_settings = _read(root, old)
    files = _names(re.findall(file_pattern, old_settings, re.MULTILINE), old, "settings filename")
    core_files = _names(re.findall(r'^pub const SETTINGS_FILE: &str = "([\w.]+)";$', _read(root, CORE_SETTINGS), re.MULTILINE), CORE_SETTINGS, "settings filename")
    if files != core_files:
        raise ValueError(f"{old}: settings filename differs from {CORE_SETTINGS}")
    schema_path = "./" + SETTINGS_SCHEMA.removeprefix("extension/")
    associations = {
        pattern
        for validation in contributions["jsonValidation"] if validation["url"] == schema_path
        for pattern in validation["fileMatch"]
    }
    if associations != {f"**/{file}" for file in files}:
        raise ValueError(f"{MANIFEST}: facade.json validation does not point to {SETTINGS_SCHEMA}")
    old_fields = set(re.findall(r"\bkey === '([\w$]+)'", _function(root, old, "parseSettings")))
    if old_fields != set(properties):
        raise ValueError(f"{SETTINGS_SCHEMA}: facade.json keys differ from {old}")
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
    core_entries = _read(root, CORE_CLI_ENTRIES)
    core_cli_fields = set(_literals(_section(core_entries, r"^const FIELDS: [^\n]+ = \[\n", r"^\];", CORE_CLI_ENTRIES)))
    core_cli_fields.update(re.findall(r'field.key != "(\w+)" && !FIELDS', core_entries))
    if cli_fields != core_cli_fields:
        raise ValueError(f"{SETTINGS_SCHEMA}: CLI fields differ from {CORE_CLI_ENTRIES}")
    for engine, path in (("old", old), ("rust", CORE_SETTINGS)):
        boundary = f"configuration-{engine}"
        _add(rows, boundary, "document", files, path)
        _add(rows, boundary, "field", [key.lstrip("$") for key in properties], path)
        _add(rows, boundary, "built-in", built_ins, SETTINGS_SCHEMA)
        _add(rows, boundary, "adapter", adapters, SETTINGS_SCHEMA)
        _add(rows, boundary, "cli-field", cli_fields, SETTINGS_SCHEMA)

    paths = "extension/src/record/paths.ts"
    environment = re.findall(r"^export const FACADE_HOME_VARIABLE = '([A-Z_]+)';$", _read(root, paths), re.MULTILINE)
    for engine in ("old", "rust"):
        _add(rows, f"configuration-{engine}", "environment", environment, paths)


def discover(root: Path) -> dict[str, str]:
    """Map stable IDs to authoritative repository-relative source paths."""
    rows: dict[str, str] = {}
    for surface in (_commands, _window, _window_socket, _ptyd, _panel, _mcp, _settings):
        try:
            surface(root, rows)
        except (OSError, TypeError, KeyError, ValueError) as error:
            raise ValueError(f"Extension inventory {surface.__name__[1:]}: {error}") from error
    return dict(sorted(rows.items()))
