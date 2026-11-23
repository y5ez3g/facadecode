#!/usr/bin/env python3
"""Replay a refused Core takeover with digest-pinned Linux x64 QA builds."""

import argparse
from contextlib import closing
from hashlib import sha256
import json
import os
from pathlib import Path
import re
import shutil
import signal
import socket
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
import time

from catalog import AcceptanceError, NATIVE_INCOMPATIBLE_CASE
from check_native_install import ASSET, PROGRAMS, install_tree, installer_args, validate_inputs
from check_real_ssh_route import SSHD, machine, ssh_configs
from evidence import digest, run_identity
from native_core import (
    ROOT, SYSTEM_PATH, clean_native_scope, hash_file, interrupted, process_identity, query,
    source_identity, verify_native_cleanup, wait_for, write_receipt,
)


ABI_PATCH = ROOT / "ci/fixtures/core-keeper-api2.patch"
INSTALLER = ROOT / "core/install.sh"
SUCCESS = "Facade native incompatible build test "
REQUEST = "qa-incompatible-original"
SESSION = "0ad87ed7-4a37-4a9a-89bd-6bd8a1debae2"
ORIGINAL = "original delivery before incompatible takeover"
FRESH = "fresh delivery after rejecting the incompatible installation"


def fixture(scope, label, sockets, bin_dir):
    root = scope / label
    home, state, tmp, runtime, project = (root / name for name in ("home", "state", "tmp", "runtime", "project"))
    root.mkdir(mode=0o700)
    for folder in (home, state, tmp, runtime, project):
        folder.mkdir(mode=0o700)
    key = sha256(os.fsencode(state)).hexdigest()[:10]
    for role in ("daemon", "keeper"):
        endpoint = Path(f"/tmp/facade-core-{os.getuid()}/{role}-{key}.sock")
        assert not os.path.lexists(endpoint), endpoint
        sockets[f"{label}-{role}"] = endpoint
    env = {
        "PATH": f"{bin_dir}:{SYSTEM_PATH}", "CI_ACCEPTANCE_ROOT": str(scope),
        "HOME": str(home), "FACADE_HOME": str(state), "TMPDIR": str(tmp), "XDG_RUNTIME_DIR": str(runtime),
        "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null", "LC_ALL": "C.UTF-8",
        "FAKECLI_SESSION": SESSION, "FAKECLI_STATUS": "1",
        "FAKECLI_LOG": str(project / "fake.log"), "FAKECLI_KEYS": str(project / "keys"),
        "FAKECLI_STARTS": str(project / "starts"),
    }
    return env, state, project


def verified_archive(archive, manifest, fake):
    build, digests, expected, sidecar = validate_inputs(archive, manifest, fake, local=True)
    return {"archive": str(archive), "manifest": str(manifest), "build": build,
            "version": build.split("+", 1)[0], "program_sha256": digests,
            "archive_sha256": expected, "manifest_sha256": sidecar}


def stage_archive(directory, package):
    directory.mkdir(mode=0o700)
    archive, manifest = directory / ASSET, directory / "SHA256SUMS"
    shutil.copyfile(package["archive"], archive)
    shutil.copyfile(package["manifest"], manifest)
    if hash_file(archive) != package["archive_sha256"] or hash_file(manifest) != package["manifest_sha256"]:
        raise AcceptanceError("the QA archive or checksum changed while staging")
    return archive


def launcher_snapshot(location):
    return {name: {"link": str(path.readlink()), "resolved": str(path.resolve(strict=True)),
                   "sha256": hash_file(path)}
            for name in PROGRAMS if (path := location / name).exists()}


def durable_state(state):
    with closing(sqlite3.connect((state / "core/facade.db").as_uri() + "?mode=ro", uri=True)) as database:
        database.row_factory = sqlite3.Row
        tables = {
            "agents": 'SELECT agent_id, name, cli, cwd, pid, created_at, exit_at FROM agents',
            "message": 'SELECT number, "from", "to", text, status, text_written, enter_written, request_id '
                       'FROM messages WHERE request_id = ?',
            "send_route": 'SELECT sender, target, machine_id, agent_id, reply_message_id, reply_machine_id, at '
                          'FROM send_routes WHERE request_id = ?',
        }
        return {table: [dict(row) for row in database.execute(sql, (REQUEST,) if "?" in sql else ())]
                for table, sql in tables.items()}


def exercise(scope, output_dir, fake, sockets, processes, receipt):
    lower, higher = (receipt[role] for role in ("lower", "higher"))
    lower_build, higher_build = lower["build"], higher["build"]
    older_archive = stage_archive(scope / "lower-package", lower)
    higher_archive = stage_archive(scope / "higher-package", higher)

    def command(label, argv, env, cwd, *, status=0, stdin=None):
        args = list(map(str, argv))
        params = {"input": stdin} if stdin is not None else {"stdin": subprocess.DEVNULL}
        result = subprocess.run(args, cwd=cwd, env=env, capture_output=True, text=True, timeout=45, **params)
        receipt["commands"].append({"label": label, "argv": args, "status": result.returncode,
                                    "stdout": result.stdout, "stderr": result.stderr})
        assert result.returncode == status, (label, result)
        return result

    def install(label, archive, build, env, cwd, status=0):
        return command(label, installer_args(INSTALLER, archive, build), env, cwd, status=status)

    control, control_state, control_work = fixture(scope, "higher-only", sockets, fake.parent)
    install("install higher pair in an empty independent home", higher_archive, higher_build,
            control, control_work)
    higher_shell = control_state / "core/bin/facade"
    command("launch the genuine higher Daemon and Keeper", [higher_shell, "daemon", "--detach"],
            control, control_work)
    hello, info = query(sockets["higher-only-daemon"], "daemon.status", {})
    assert hello["build"] == hello["keeper"]["build"] == higher_build, hello
    log = (control_state / "core/logs/daemon.log").read_text()
    keeper = info["keeper_pid"]
    signature = f'daemon[{hello["pid"]}] info: connected to keeper {keeper} (Keeper API 2, build {higher_build})'
    assert signature in log, log
    higher_control = launcher_snapshot(control_state / "core/bin")
    assert {name: value["sha256"] for name, value in higher_control.items()} == higher["program_sha256"]
    receipt["higher_control"] = {"hello": hello, "keeper_handshake": signature, "launchers": higher_control}
    (output_dir / "higher-only-daemon.log").write_text(log)

    origin, state, work = fixture(scope, "origin", sockets, fake.parent)
    install("install older pair with normal default activation", older_archive, lower_build, origin, work)
    bin_dir = state / "core/bin"
    facade = bin_dir / "facade"
    receipt["runtime_baseline"] = command("read installed older Shell version", [facade, "--version"],
                                          origin, work).stdout.strip()
    assert receipt["runtime_baseline"] == f"facade {lower_build}"
    endpoint = sockets["origin-daemon"]
    command("launch the installed older services", [facade, "daemon", "--detach"], origin, work)
    origin_hello, _ = query(endpoint, "daemon.status", {})
    command("give the old origin a distinct machine name", [facade, "machine", "rename",
            origin_hello["machine_id"].replace("-", ""), "qa-origin"], origin, work)
    result = command("start original managed fake", [facade, "start", "-d", "--name", "survivor", "fake"],
                     origin, work)
    address = re.fullmatch(r"Started survivor \((a\d+@[^)]+)\) in the background\.\n", result.stdout)[1]
    _, inspected = query(endpoint, "agent.inspect", {"target": address})
    reference = inspected["agent"]["reference"]
    agent_pid = inspected["agent"]["pid"]
    assert process_identity(agent_pid)["executable"] == str(fake)

    # Use the established private OpenSSH harness to prove that an actual saved transport
    # remains present together with the request's durable recipient route.
    peer, peer_work, _ = machine(scope, "peer", {
        "facade": facade, "facade-mcp": bin_dir / "facade-mcp",
        "facade-fakecli": fake,
    }, sockets)
    with socket.socket() as reservation:
        reservation.bind(("127.0.0.1", 0))
        port = reservation.getsockname()[1]
    server_config, client_config = ssh_configs(
        scope, peer, port, lambda label, args: command(label, args, origin, work))
    ssh_log = scope / "sshd.log"
    with ssh_log.open("w") as output:
        processes.append(subprocess.Popen([SSHD, "-D", "-e", "-f", server_config], cwd=work, env=origin,
                                         stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.STDOUT))
    wait_for("private OpenSSH fixture startup", lambda: "Server listening" in ssh_log.read_text(), seconds=5)
    launched = command("start the old peer through isolated OpenSSH", [
        "/usr/bin/ssh", "-F", client_config, "fixture-peer",
        'printf "%s\\n%s\\n" "$HOME" "$FACADE_HOME"; exec "$FACADE_HOME/core/bin/facade" daemon --detach',
    ], origin, work)
    assert launched.stdout.splitlines()[:2] == [peer["HOME"], peer["FACADE_HOME"]], launched
    peer_hello, _ = query(sockets["peer-daemon"], "daemon.status", {})
    assert peer_hello["build"] == lower_build, peer_hello
    command("give the old peer a distinct machine name", [
        Path(peer["FACADE_HOME"]) / "core/bin/facade", "machine", "rename",
        peer_hello["machine_id"].replace("-", ""), "qa-peer",
    ], peer, peer_work)
    command("save the actual old peer transport", [facade, "machine", "add", "--home", peer["FACADE_HOME"],
                                                    "-F", client_config, "fixture-peer"], origin, work)
    assert ssh_log.read_text().count("Accepted publickey") >= 2
    peer_id = peer_hello["machine_id"]

    def saved_route():
        _, roster = query(endpoint, "machine.list", {})
        local_row = next(row for row in roster["machines"] if row["machine_id"] == reference["machine_id"])
        remote_row = next(row for row in roster["machines"] if row["machine_id"] == peer_id)
        route = next(link for link in local_row["connections"] if link["kind"] == "saved"
                     and link["machine_id"] == peer_id)
        assert route["transport"]["kind"] == "ssh" and route["transport"]["remote_home"] == peer["FACADE_HOME"]
        return {"saved": route, "peer": {"machine_id": peer_id, "route": remote_row.get("route"),
                                          "state": remote_row["state"]}}

    send = {"to": address, "text": ORIGINAL, "request_id": REQUEST}
    _, original = query(endpoint, "agent.send", send)
    assert original["message"]["delivery"]["status"] == "success", original
    assert original["recipient"]["reference"] == reference, original
    receipt["original_receipt"] = original

    def completed_turn():
        _, inspected = query(endpoint, "agent.inspect", {"target": reference})
        agent = inspected["agent"]
        receipt["last_pre_refusal_agent"] = agent
        return agent["state"] in ("idle", "just_done") and agent.get("session") == SESSION

    wait_for("the original fake CLI to complete its first turn", completed_turn)

    def state_now():
        hello, info = query(endpoint, "daemon.status", {})
        _, inspected = query(endpoint, "agent.inspect", {"target": reference})
        agent = inspected["agent"]
        assert agent["session"] == SESSION and agent["pid"] == agent_pid and agent["process"] == "running", agent
        assert hello["build"] == hello["keeper"]["build"] == lower_build, hello
        assert (work / "starts").read_text().splitlines() == [str(agent_pid)]
        return {"processes": {role: process_identity(pid) for role, pid in (
            ("daemon", info["daemon_pid"]), ("keeper", info["keeper_pid"]), ("cli", agent["pid"]))},
            "record": agent, "saved_transport": saved_route(), "durable": durable_state(state),
                    "launchers": launcher_snapshot(bin_dir)}

    before = state_now()
    assert before["saved_transport"]["peer"]["route"] == [peer_id], before
    assert before["durable"]["send_route"][0]["machine_id"] == reference["machine_id"], before
    assert before["durable"]["send_route"][0]["agent_id"] == reference["agent_id"], before
    assert {name: value["sha256"] for name, value in before["launchers"].items()} == lower["program_sha256"]
    initial_runtime = install_tree(bin_dir)
    keys = work / "keys"
    old_keys = keys.read_bytes()
    old_submissions = (work / "fake.log").read_bytes()
    assert old_keys.count(ORIGINAL.encode()) == 1
    receipt["before"] = before

    def confirm_refusal(result):
        assert f"could not upgrade Orchestrator {lower_build} to {higher_build}" in result.stderr, result
        assert (f"{higher_build} supports keeper API versions [2], and the running keeper negotiated version 1"
                in result.stderr
                and f"Stop the running agents {address} and try again" in result.stderr), result
        marker = "facade-upgrade-blockers "
        blockers = [json.loads(line.removeprefix(marker)) for line in result.stdout.splitlines()
                    if line.startswith(marker)]
        assert len(blockers) == 1 and len(blockers[0]) == 1, result
        assert blockers[0][0]["reference"] == reference and blockers[0][0]["address"] == address, result
        assert state_now() == before, "older state changed on refusal"
        assert install_tree(bin_dir) == initial_runtime
        assert keys.read_bytes() == old_keys and (work / "fake.log").read_bytes() == old_submissions
        return blockers[0]

    report = {**origin, "FACADE_UPGRADE_REPORT": "1"}
    incoming = higher_shell.resolve(strict=True)
    direct = command("refuse the actual higher Shell takeover command",
                     [incoming, "daemon", "--takeover"], report, work, status=1)
    direct_blockers = confirm_refusal(direct)
    receipt["direct_offer"] = {"blockers": direct_blockers, "programs_and_state_unchanged": True}

    failed = install("refuse activation through shipped installer", higher_archive, higher_build, report, work, status=1)
    installer_blockers = confirm_refusal(failed)
    receipt["installer_observation"] = {"blockers": installer_blockers, "programs_and_state_unchanged": True}
    receipt["after_refusal"] = state_now()

    _, repeated = query(endpoint, "agent.send", send)
    assert repeated["repeated"] and repeated["id"] == original["id"] and repeated["message"] == original["message"]
    assert keys.read_bytes() == old_keys and (work / "fake.log").read_bytes() == old_submissions
    _, sent = query(endpoint, "agent.send", {"to": reference, "text": FRESH, "request_id": "qa-incompatible-fresh"})
    delivery = sent["message"]["delivery"]
    assert delivery["status"] == "success" and delivery["text_written"] == "full" and delivery["enter_written"]
    assert sent["id"] != original["id"]
    complete = [row["text"] for row in map(json.loads, (work / "fake.log").read_text().splitlines())
                if isinstance(row.get("text"), str)]
    assert complete == [f"📨 Message from the command line · {item['message']['message_id']}\n{body}"
                        for item, body in ((original, ORIGINAL), (sent, FRESH))], complete
    final_keys = keys.read_bytes()
    assert final_keys.startswith(old_keys) and final_keys[len(old_keys):].count(FRESH.encode()) == 1
    assert process_identity(agent_pid) == before["processes"]["cli"]
    assert (work / "starts").read_text().splitlines() == [str(agent_pid)]
    assert saved_route() == before["saved_transport"]
    receipt["input"] = {"before_sha256": sha256(old_keys).hexdigest(),
                        "fresh_suffix_sha256": sha256(final_keys[len(old_keys):]).hexdigest()}
    receipt["repeated_receipt"], receipt["fresh_receipt"], receipt["submissions"] = repeated, sent, complete
    (output_dir / "older-daemon.log").write_bytes((state / "core/logs/daemon.log").read_bytes())


def main():
    if not __debug__:
        raise SystemExit("run the incompatible build check with Python assertions enabled")
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("lower-archive", "lower-manifest", "higher-archive", "higher-manifest",
                 "fake-executable", "output-dir"):
        parser.add_argument(f"--{name}", type=lambda path: Path(path).resolve(), required=True)
    parser.add_argument("--run-id", required=True, help="unique local QA attempt")
    args = parser.parse_args()
    if (sys.platform != "linux" or os.uname().machine != "x86_64" or os.getuid() == 0
            or not os.access(SSHD, os.X_OK)):
        parser.error("requires unprivileged Linux x64 with a local OpenSSH server")
    try:
        source = source_identity(run_identity(args.run_id, {}))
        lower = verified_archive(args.lower_archive, args.lower_manifest, args.fake_executable)
        higher = verified_archive(args.higher_archive, args.higher_manifest, args.fake_executable)
        if tuple(map(int, higher["version"].split("."))) <= tuple(map(int, lower["version"].split("."))):
            raise AcceptanceError("the incompatible fixture requires a higher numeric build")
        abi_digest = hash_file(ABI_PATCH)
        fake_digest = hash_file(args.fake_executable)
        installer_digest = hash_file(INSTALLER)
        fixture_digest = hash_file(Path(__file__))
        args.output_dir.mkdir(parents=True)
    except (OSError, ValueError, tarfile.TarError) as error:
        parser.exit(2, f"native incompatible build: {error}\n")

    signal.signal(signal.SIGTERM, interrupted)
    scope = Path(tempfile.mkdtemp(prefix="fci-incompatible-", dir="/tmp"))
    sockets, processes = {}, []
    started = time.monotonic()
    receipt = {"source": source, "scope": str(scope), "lower": lower, "higher": higher, "commands": [],
               "abi_patch_sha256": abi_digest, "installer_sha256": installer_digest,
               "fixture_sha256": fixture_digest, "fake_sha256": fake_digest}
    try:
        bin_dir = scope / "fake-bin"
        bin_dir.mkdir(mode=0o700)
        fake = bin_dir / "facade-fakecli"
        shutil.copy2(args.fake_executable, fake)
        if hash_file(fake) != fake_digest:
            raise AcceptanceError("the fake CLI changed while staging")
        exercise(scope, args.output_dir, fake, sockets, processes, receipt)
    finally:
        try:
            for child in reversed(processes):
                if child.poll() is None:
                    child.terminate()
                try:
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    continue
            if (scope / "sshd.log").is_file():
                (args.output_dir / "sshd.log").write_bytes((scope / "sshd.log").read_bytes())
        finally:
            try:
                clean_native_scope(scope, sockets, receipt)
                verify_native_cleanup(receipt)
            finally:
                receipt["elapsed_seconds"] = round(time.monotonic() - started, 3)
                write_receipt(args.output_dir / "receipt.json", receipt)
    receipt["success"] = {
        "case": NATIVE_INCOMPATIBLE_CASE, "source": source, "target": "linux-x64", "mode": "local-qa",
        "lower_archive_sha256": lower["archive_sha256"], "higher_archive_sha256": higher["archive_sha256"],
        "evidence_sha256": digest(receipt),
    }
    write_receipt(args.output_dir / "receipt.json", receipt)
    print(SUCCESS + json.dumps(receipt["success"], separators=(",", ":")), flush=True)


if __name__ == "__main__":
    main()
