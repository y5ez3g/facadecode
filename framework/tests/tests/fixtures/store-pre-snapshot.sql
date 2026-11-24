-- Schema written by the pinned protocol-v2 build (1a1e0791), before launch snapshots.
-- Its SQLite user_version is 0. Tests seed IDs, paths, and timestamps separately.
CREATE TABLE numbers (next INTEGER NOT NULL);
CREATE TABLE message_numbers (next INTEGER NOT NULL);
CREATE TABLE machine (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    machine_id TEXT NOT NULL,
    name TEXT NOT NULL
);
CREATE TABLE agents (
    agent_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    cli TEXT NOT NULL,
    cwd TEXT NOT NULL,
    pid INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    exit_code INTEGER,
    exit_signal TEXT,
    exit_at TEXT,
    exit_reason TEXT,
    rule TEXT,
    session TEXT,
    creator TEXT,
    creator_machine_id TEXT,
    start_machine_id TEXT NOT NULL,
    start_window_id TEXT,
    root TEXT NOT NULL,
    root_machine_id TEXT NOT NULL,
    yolo INTEGER NOT NULL,
    request_id TEXT,
    prompt INTEGER,
    result_message_id TEXT,
    result_message_machine_id TEXT,
    location_id TEXT NOT NULL,
    location_machine_id TEXT,
    location_window_id TEXT
);
CREATE TABLE saved_connections (
    machine_id TEXT PRIMARY KEY, ssh_destination TEXT NOT NULL, remote_home TEXT
);
CREATE TABLE known_machines (machine_id TEXT PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE messages (
    number INTEGER PRIMARY KEY,
    "from" TEXT NOT NULL,
    from_name TEXT,
    "to" TEXT NOT NULL,
    text TEXT NOT NULL,
    reply_to INTEGER,
    at TEXT NOT NULL,
    status TEXT NOT NULL,
    reason TEXT,
    text_written TEXT NOT NULL,
    enter_written INTEGER,
    deadline TEXT,
    delivered_via TEXT,
    delivered_at TEXT,
    paste INTEGER,
    from_window TEXT,
    call_id TEXT,
    result_owed INTEGER,
    result_owed_machine_id TEXT,
    result TEXT,
    request_id TEXT,
    request_window_id TEXT,
    human_windows TEXT,
    from_machine_id TEXT,
    reply_to_machine_id TEXT
);
CREATE INDEX messages_inbox ON messages ("to", number);
CREATE INDEX messages_undelivered ON messages ("to", number) WHERE status != 'success';
CREATE INDEX messages_request ON messages
    ("from", from_machine_id, "to", request_window_id, request_id) WHERE request_id IS NOT NULL;
CREATE TABLE windows (
    window_id TEXT PRIMARY KEY, label TEXT NOT NULL, environment TEXT NOT NULL,
    workspace TEXT, folders TEXT NOT NULL, branch_prefix TEXT,
    sequence INTEGER NOT NULL, instance TEXT NOT NULL
);
CREATE TABLE agent_windows (
    agent_id TEXT NOT NULL, machine_id TEXT NOT NULL, window_id TEXT NOT NULL,
    PRIMARY KEY (agent_id, machine_id, window_id)
);
CREATE INDEX agent_windows_by_window ON agent_windows (machine_id, window_id);
CREATE TABLE guests (
    agent_id TEXT PRIMARY KEY, name TEXT NOT NULL, cli TEXT NOT NULL, session TEXT NOT NULL,
    cwd TEXT NOT NULL, created_at TEXT NOT NULL, heard_at TEXT NOT NULL
);
CREATE TABLE integration_files (
    cli TEXT NOT NULL, file TEXT NOT NULL, before BLOB, written BLOB NOT NULL,
    added_at TEXT NOT NULL, PRIMARY KEY (cli, file)
);
