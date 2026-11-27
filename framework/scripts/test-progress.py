"""Streams libtest start and end events and keeps the test-all report readable."""

import json
import os
import subprocess
import sys


def show_event(text, log):
    try:
        record = json.loads(text)
    except json.JSONDecodeError:
        return text.rstrip("\n")
    if not isinstance(record, dict):
        return text.rstrip("\n")

    kind, event = record.get("type"), record.get("event")
    if kind == "test":
        name = record["name"]
        if event == "started":
            return f"test {name} ... started"
        if event == "timeout":
            return f"test {name} ... still running"
        if event == "failed":
            print(f"---- {name} stdout ----", file=log)
            print(record.get("stdout", "").rstrip("\n"), file=log)
        return f"test {name} ... {event}"
    if kind == "suite":
        if event == "started":
            return f"running {record['test_count']} tests"
        return (
            f"test result: {event}. {record['passed']} passed; {record['failed']} failed; "
            f"{record['ignored']} ignored; {record['measured']} measured; "
            f"{record['filtered_out']} filtered out; finished in {record['exec_time']:.2f}s"
        )
    return text.rstrip("\n")


def main():
    _, log_path, *cargo = sys.argv
    # The pinned compiler's libtest JSON format needs unstable options.
    env = dict(os.environ, RUSTC_BOOTSTRAP="1")
    with open(log_path, "w", encoding="utf-8", buffering=1) as log:
        with subprocess.Popen(
            cargo, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, encoding="utf-8", errors="replace",
        ) as tests:
            assert tests.stdout is not None
            for raw in tests.stdout:
                line = show_event(raw, log)
                print(line, flush=True)
                print(line, file=log)
            status = tests.wait()
    return status if status >= 0 else 128 - status


if __name__ == "__main__":
    sys.exit(main())
