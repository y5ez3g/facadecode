"""Discover the Rust Core interfaces that the CI case catalog must cover."""

import json
import re
import tomllib
from pathlib import Path


BASE = Path("core/crates/base/src")
WIRE = BASE / "protocol/api_v1"
SHELL = Path("core/crates/facade/src")
RELAY = Path("core/crates/relay")
MCP = Path("core/crates/daemon/src/mcp")
RULES = Path("core/crates/rules/src/command_line")
SEGMENT = r"[A-Za-z0-9._-]+"
RUST_STRING = r'"(?:[^"\\]|\\[\s\S])*"'


def require(condition, source, reason):
    if not condition:
        raise ValueError(f"{source}: {reason}")


def match_one(text, pattern, source):
    matches = re.findall(pattern, text, re.MULTILINE)
    require(len(matches) == 1, source, f"expected one declaration matching {pattern}")
    return matches[0]


def distinct(names, source, label):
    seen = set()
    for name in names:
        require(name not in seen, source, f"duplicate {label} {name!r}")
        seen.add(name)
    require(seen, source, f"empty {label}")
    return seen


def load_json(root, source):
    def unique_members(pairs):
        members = dict(pairs)
        require(len(members) == len(pairs), source, "duplicate JSON object member")
        return members

    try:
        return json.loads((root / source).read_text(encoding="utf-8"), object_pairs_hook=unique_members)
    except json.JSONDecodeError as error:
        raise ValueError(f"{source}: {error}") from error


def reconcile(actual, expected, source, label):
    require(actual == expected, source, (
        f"{label} differ (only in source: {sorted(actual - expected)}, "
        f"only in comparison: {sorted(expected - actual)})"
    ))


def kebab(variant):
    return re.sub(r"(?<!^)(?=[A-Z])", "-", variant).lower()


def shell(root, add):
    cli = SHELL / "cli.rs"
    hooks = SHELL / "hooks.rs"
    cli_text = (root / cli).read_text(encoding="utf-8")
    # Lexical commands are parsed before their validated Command variants are dispatched.
    lexical_body = match_one(cli_text, r"^enum LexicalCommand \{\n([\s\S]*?)^\}", cli)
    flatten = "    #[command(flatten)]\n    Other(Command),\n"
    require(lexical_body.endswith(flatten), cli, "LexicalCommand must flatten Command")
    lexical_entries = lexical_body.removesuffix(flatten).splitlines()
    lexical_pattern = r"    ([A-Z][A-Za-z0-9]*)\([A-Z][A-Za-z0-9]*\),"
    require(all(re.fullmatch(lexical_pattern, line) for line in lexical_entries), cli,
            "unrecognized lexical subcommand")
    lexical = distinct((kebab(re.fullmatch(lexical_pattern, line)[1]) for line in lexical_entries),
                       cli, "lexical subcommand")

    public = set()
    for source, text, enum, parent in (
        (cli, cli_text, "Command", ""),
        (cli, cli_text, "MachineAction", "machine "),
        (hooks, (root / hooks).read_text(encoding="utf-8"), "HookEvent", "hook "),
    ):
        body = match_one(text, rf"^pub\(crate\) enum {enum} \{{\n([\s\S]*?)^\}}", source)
        variants = {}
        attribute = None
        for line in body.splitlines():
            if not line.startswith("    ") or line.startswith(("     ", "    //", "    }")):
                require(not line or line.startswith("    "), source, f"unexpected {enum} line {line!r}")
                continue
            if line in ("    #[command(hide = true)]", "    #[command(skip)]",
                        "    #[command(disable_help_subcommand = true)]"):
                require(attribute is None, source, f"multiple command attributes in {enum}")
                attribute = line.strip()
                continue
            entry = re.fullmatch(r"    ([A-Z][A-Za-z0-9]*)(?:,|\([^()]*\),| \{)", line)
            require(entry, source, f"unrecognized {enum} entry {line!r}")
            name = parent + kebab(entry[1])
            require(name not in variants, source, f"duplicate {enum} variant {name}")
            variants[name] = attribute
            attribute = None
        require(variants and attribute is None, source, f"incomplete {enum} declaration")
        hidden = {name for name, attr in variants.items() if attr == "#[command(hide = true)]"}
        skipped = {name for name, attr in variants.items() if attr == "#[command(skip)]"}
        for name in variants.keys() - skipped:
            if name == "hook":  # The invoked entry points are the individual HookEvent variants.
                continue
            if parent == "hook " or name in hidden:
                add("shell", "process", name.replace(" ", "."), source)
            else:
                public.add(name)
                add("shell", "command", name.replace(" ", "."), source)
        if enum == "Command":
            dispatch = dict(re.findall(
                r"ErrorKind::Display(Help|Version)\) => return selected\(Command::([A-Za-z]+)",
                cli_text,
            ))
            options = {kebab(name) for name in dispatch.values()}
            reconcile(lexical | options, skipped, source, "skipped command dispatch")
            public.update(lexical)
            for name in lexical:
                add("shell", "command", name, source)
            for name in dispatch:
                add("shell", "option", name.lower(), source)

    help_source = SHELL / "help.rs"
    pages = distinct(re.findall(r'^ +path: "([^"]*)",$', (root / help_source).read_text(
        encoding="utf-8"), re.MULTILINE), help_source, "help path")
    require("" in pages, help_source, "missing root help page")
    reconcile(public, pages - {""}, cli, "public Clap commands and Shell help pages")

    # These flags select separate execution paths, unlike ordinary options on a command.
    for variant in ("Start", "Resume"):
        fields = match_one(cli_text, rf"^    {variant} \{{\n([\s\S]*?)^    \}},", cli)
        require(re.search(r"^        detach: bool,$", fields, re.MULTILINE), cli, f"missing {variant} detach flag")
        for mode in ("foreground", "detached"):
            add("shell", "mode", f"{variant.lower()}.{mode}", cli)
    manifest = RELAY / "Cargo.toml"
    binaries = tomllib.loads((root / manifest).read_text(encoding="utf-8")).get("bin")
    require(binaries, manifest, "no relay executable declared")
    for binary in binaries:
        source = RELAY / binary["path"]
        require((root / source).is_file(), manifest, f"missing entry point {source}")
        add("shell", "process", binary["name"], source)


def rust_entries(text, macro, entry, source):
    body = match_one(text, rf"^{macro}! \{{\n([\s\S]*?)^\}}", source)
    rows = list(re.finditer(entry, body, re.MULTILINE))
    require(not re.sub(entry, "", body, flags=re.MULTILINE).strip(),
            source, f"unrecognized syntax in {macro}! registry")
    return distinct((row["name"] for row in rows), source, macro)


def frame_branches(root, boundary):
    source = Path("core/crates/base/tests/support/codegen.rs")
    text = (root / source).read_text(encoding="utf-8")
    body = match_one(text, rf'^    let schema = schema_file\(\n        "Facade {boundary} API",\n'
                     rf"        {boundary}::SUPPORTED_API_VERSIONS,\n        &\[\n([\s\S]*?)^        \],",
                     source)
    row = r'^ +"([A-Z][A-Za-z0-9]+)",$'
    require(not re.sub(row, "", body, flags=re.MULTILINE).strip(),
            source, f"unrecognized {boundary} frame declaration")
    return distinct(re.findall(row, body, re.MULTILINE), source, f"{boundary} frame declaration")


def wire(root, add):
    for boundary, schema_file, method_file in (
        ("daemon", "protocol.schema.json", WIRE / "daemon.rs"),
        ("keeper", "keeper.schema.json", WIRE / "keeper.rs"),
    ):
        source = Path("core/protocol") / schema_file
        schema = load_json(root, source)
        require(schema.get("api_versions") == [1], source, "expected one v1 registry")
        catalog = schema["x-facade"]
        definitions = schema["$defs"]
        method_body = match_one((root / method_file).read_text(encoding="utf-8"),
                                r"^pub mod methods \{\n([\s\S]*?)^\}", method_file)
        methods = r'^\s*pub const [A-Z0-9_]+: &str = "(' + SEGMENT + r')";'
        rust_methods = distinct(re.findall(methods, method_body, re.MULTILINE), method_file, "wire method")
        require(not re.sub(methods, "", method_body, flags=re.MULTILINE).strip(),
                method_file, "unrecognized syntax in method registry")
        reconcile(rust_methods, distinct(catalog["methods"], source, "schema method"), source, "wire methods")

        if boundary == "daemon":
            registry = WIRE / "daemon/registry.rs"
            operation = r"[A-Za-z0-9_]+"
            topic = rf"{operation} / {operation}"
            start = rf'^[ \t]*(?:{{marker}}): "(?P<name>{SEGMENT})", {RUST_STRING}, '
            entries = (
                ("operation", registry, "operations", start.replace("{marker}", operation)
                 + r"[A-Za-z0-9_<>]+ => [A-Za-z0-9_<>]+, (?:ALL|PEOPLE|TERMINAL|PEER), (?:true|false);"),
                ("topic", registry, "topics", start.replace("{marker}", topic)
                 + r"[A-Za-z0-9_<>]+ => \([A-Za-z0-9_<>]+, [A-Za-z0-9_<>]+\), (?:ALL|PEOPLE|TERMINAL|PEER), (?:true|false);"),
            )
        else:
            entries = (("operation", method_file, "keeper_operations",
                        rf'^[ \t]*[A-Za-z0-9_]+: "(?P<name>{SEGMENT})",\s*{RUST_STRING},\s*'
                        r"[A-Za-z0-9_]+\([A-Za-z0-9_]+\) -> [A-Za-z0-9_]+;"),)
        for kind, registry, macro, pattern in entries:
            names = rust_entries((root / registry).read_text(encoding="utf-8"), macro, pattern, registry)
            reconcile(names, set(catalog[kind + "s"]), source, f"{kind} names")
            for name in names:
                add(boundary, kind, name, registry)

        registered = set()
        branches = distinct((entry["$ref"].removeprefix("#/$defs/") for entry in schema["anyOf"]),
                            source, "top-level frame schema")
        reconcile(frame_branches(root, boundary), branches, source, "generator and published frame branches")
        for branch in sorted(branches):
            shape = definitions[branch]
            frames = shape.get("oneOf", [shape])
            require(frames, source, f"no frames in {branch}")
            for frame in frames:
                properties = frame["properties"]
                if branch.startswith("Relay"):
                    continue  # Parsed against the relay's contract separately.
                method = properties.get("method", {}).get("const")
                if method is not None:
                    registered.add(method)
                if branch in ("SuccessResponse", "ErrorResponse"):
                    member = "result" if branch == "SuccessResponse" else "error"
                    require(member in frame["required"] and "id" in frame["required"], source,
                            f"missing {member} or response id in {branch}")
                    add(boundary, "response", member, source)
                elif boundary == "keeper" and branch.startswith("Windows"):
                    require("terminal" in frame["required"], source, f"missing native terminal in {branch}")
                    add(boundary, "native-frame", kebab(branch.removeprefix("Windows")), source)
                else:
                    kind = kebab(branch)
                    require(method is not None and kind.endswith(("-request", "-notification")),
                            source, f"unrecognized top-level frame {branch}")
                    require(("id" in frame["required"]) == kind.endswith("-request"), source,
                            f"{branch} has wrong request id requirement")
                    add(boundary, kind, method, source)
        reconcile(registered, rust_methods, source, "registered methods and top-level frames")
        require({"SuccessResponse", "ErrorResponse"} <= branches, source, "missing response schemas")
        if boundary == "daemon":
            relay(root, add, schema, branches, source)


def relay(root, add, schema, branches, source):
    relay_source = RELAY / "src/daemon.rs"
    daemon_source = MCP / "mod.rs"
    sender = (root / relay_source).read_text(encoding="utf-8")
    receiver = (root / daemon_source).read_text(encoding="utf-8")
    pattern = r"^(?:pub\(crate\) )?const RELAY_CONTRACT: u32 = (\d+);$"
    version = int(match_one(sender, pattern, relay_source))
    require(version == int(match_one(receiver, pattern, daemon_source)), relay_source,
            "relay and daemon disagree about the contract version")
    reconcile({branch for branch in branches if branch.startswith("Relay")},
              {"RelayHelloRequest", "RelayHelloResponse"}, source, "relay frame branches")
    definitions = schema["$defs"]
    hello = definitions["RelayHelloRequest"]["properties"]
    response = definitions["RelayHelloResponse"]["properties"]
    method = hello["method"]["const"]
    require(hello["params"]["properties"]["relay"]["const"] == version
            and response["result"]["properties"]["relay"]["const"] == version,
            source, "relay schemas disagree with the executable contract version")
    require(r'\"method\":\"' + method + r'\"' in sender, relay_source, "relay hello method drift")
    add("relay", "request", method, relay_source)
    add("relay", "response", method, daemon_source)
    closing = match_one(sender, r'^const CLOSING_RESPONSE: &\[u8\] = b"(.*)";$', relay_source)
    frame = json.loads(json.loads(f'"{closing}"'))
    require(frame.get("jsonrpc") == "2.0" and frame.get("params") == {} and "id" not in frame,
            relay_source, "unexpected relay closing acknowledgement")
    add("relay", "notification", frame["method"], relay_source)


def mcp(root, add):
    source = MCP / "lines.rs"
    text = (root / source).read_text(encoding="utf-8")
    respond = match_one(text, r"^    let answered = match method \{\n([\s\S]*?)^    \};", source)
    requests = distinct(re.findall(r'^        "([^"]+)" =>', respond, re.MULTILINE), source, "MCP request")
    require(all(re.match(r'^        (?:"[^"]+"|other) =>', row) for row in respond.splitlines()),
            source, "unrecognized MCP request branch")
    for name in requests:
        add("mcp", "request", name.replace("/", "."), source)
    notice = match_one(text, r'^    match message\["method"\]\.as_str\(\) \{\n([\s\S]*?)^    \}', source)
    incoming = distinct(re.findall(r'^        Some\("([^"]+)"\)', notice, re.MULTILINE), source, "MCP notice")
    require(all(re.match(r'^        (?:Some\("[^"]+"\)|_)', row)
                for row in notice.splitlines() if re.match(r"^        \S", row) and row != "        }"),
            source, "unrecognized MCP notice branch")
    generic_notice = match_one(text, r"^    // A notification, such as `([^\x60]+)`, asks for nothing\.$", source)
    for name in distinct([generic_notice, *(incoming - requests)], source, "MCP notification"):
        require(re.fullmatch(rf"notifications/{SEGMENT}", name), source, f"unexpected notification {name}")
        add("mcp", "notification", name.replace("/", "."), source)

    definitions_source = BASE / "texts/tools.rs"
    catalog = definitions_source.with_name(match_one(
        (root / definitions_source).read_text(encoding="utf-8"),
        r'^pub const DEFINITIONS: &str = include_str!\("([^"]+\.json)"\);$', definitions_source,
    ))
    tools = load_json(root, catalog)
    names = distinct((tool["name"] for tool in tools), catalog, "MCP tool")
    actions = MCP / "mod.rs"
    variants = match_one((root / actions).read_text(encoding="utf-8"),
                         r'^#\[serde\(rename_all = "snake_case"\)\]\nenum Tool \{\n([\s\S]*?)^\}', actions)
    require(all(re.fullmatch(r"    [A-Z][A-Za-z0-9]+,", row) for row in variants.splitlines()),
            actions, "unrecognized MCP tool action")
    reconcile(names, distinct((kebab(row.strip()[:-1]).replace("-", "_")
                              for row in variants.splitlines()), actions, "MCP action"),
              catalog, "MCP definitions and actions")
    for tool in tools:
        require(tool["inputSchema"]["type"] == "object", catalog, f"invalid schema for {tool['name']}")
        add("mcp", "tool", tool["name"], catalog)


def configuration(root, add):
    source = BASE / "settings.rs"
    text = (root / source).read_text(encoding="utf-8")
    file = match_one(text, r'^pub const SETTINGS_FILE: &str = "([^"]+)";$', source)
    add("configuration", "file", file, source)
    table = match_one(text, r"^const SETTINGS: \[\(&str, &str\); (\d+)\] = \[\n([\s\S]*?)^\];", source)
    # The source uses the first column for errors and the match arms for accepted values.
    row = rf'^\s*\("(\$?{SEGMENT})", (?:{RUST_STRING}|[A-Z_]+)\),'
    keys = distinct(re.findall(row, table[1], re.MULTILINE), source, "setting")
    require(len(keys) == int(table[0]) and not re.sub(row, "", table[1], flags=re.MULTILINE).strip(),
            source, "unrecognized SETTINGS row")
    arms = match_one(text, r"^        match \(key.as_str\(\), value.json\) \{\n([\s\S]*?)^        \}", source)
    reconcile(keys, distinct(re.findall(r'^            \("([^"]+)", Json::', arms, re.MULTILINE),
                             source, "accepted setting"), source, "setting table and reader")
    for key in keys:
        add("configuration", "setting", key.removeprefix("$"), source)

    entries = RULES / "entries.rs"
    text = (root / entries).read_text(encoding="utf-8")
    count, fields = match_one(text, r"^const FIELDS: \[&str; (\d+)\] = \[\n([\s\S]*?)^\];", entries)
    field = rf'"({SEGMENT})",'
    names = distinct(re.findall(field, fields), entries, "CLI entry field")
    require(len(names) == int(count) and not re.sub(field, "", fields).strip(),
            entries, "unrecognized FIELDS entry")
    fill = match_one(text, r"^    fn fill\(\n([\s\S]*?)^    \}", entries)
    compatibility = set(re.findall(r'field\.key != "([^"]+)"', fill))
    uses = set(re.findall(r'\bget\("([^"]+)"\)', fill))
    reconcile(names | compatibility, uses, entries, "accepted fields and reader lookups")
    for name in names | compatibility:
        add("configuration", "cli-field", name, entries)

    paths = BASE / "paths.rs"
    home = match_one((root / paths).read_text(encoding="utf-8"),
                     r'^    match std::env::var_os\("([A-Z_]+)"\)\.map\(PathBuf::from\) \{$', paths)
    add("configuration", "environment", home, paths)


def discover(root: Path) -> dict[str, str]:
    """Return stable IDs and their repository-relative registration sources."""
    inventory = {}

    def add(boundary, kind, name, source):
        stable_id = f"core/{boundary}/{kind}/{name}"
        require(re.fullmatch(rf"core/{SEGMENT}/{SEGMENT}/{SEGMENT}", stable_id), source,
                f"invalid ID {stable_id!r}")
        require(stable_id not in inventory, source, f"duplicate ID {stable_id}")
        inventory[stable_id] = source.as_posix()

    for surface in (shell, wire, mcp, configuration):
        try:
            surface(root, add)
        except (AttributeError, KeyError, TypeError, OSError) as error:
            raise ValueError(f"Core {surface.__name__} inventory: {error}") from error
    return dict(sorted(inventory.items()))
