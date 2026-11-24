-- Storage schema 4, as of e79cd893^, added to the original pre-snapshot schema.
ALTER TABLE guests ADD COLUMN yolo INTEGER;
ALTER TABLE messages ADD COLUMN withdrawn INTEGER NOT NULL DEFAULT 0;
DROP INDEX messages_request;
CREATE INDEX messages_request ON messages
    ("from", from_machine_id, "to", request_id, at) WHERE request_id IS NOT NULL;
ALTER TABLE messages ADD COLUMN private_receipt INTEGER NOT NULL DEFAULT 0;
CREATE TABLE send_routes (
    sender TEXT NOT NULL, request_id TEXT NOT NULL, target TEXT NOT NULL,
    machine_id TEXT NOT NULL, agent_id TEXT NOT NULL, reply_message_id TEXT,
    reply_machine_id TEXT, at TEXT NOT NULL, PRIMARY KEY (sender, request_id, target)
);
CREATE TABLE legacy_machines (machine_id TEXT PRIMARY KEY, name TEXT NOT NULL);
ALTER TABLE saved_connections ADD COLUMN ssh_args TEXT;
ALTER TABLE known_machines ADD COLUMN last_seen TEXT;
CREATE TABLE remembered_routes (machine_id TEXT PRIMARY KEY, route TEXT NOT NULL);
ALTER TABLE agents ADD COLUMN started_at TEXT;
ALTER TABLE agents ADD COLUMN run_auth_version INTEGER;
ALTER TABLE agents ADD COLUMN run_auth_birth TEXT;
ALTER TABLE agents ADD COLUMN run_credential_digest BLOB;
ALTER TABLE agents ADD COLUMN creation_source TEXT;
ALTER TABLE agents ADD COLUMN launch_options TEXT;
CREATE TABLE agent_removals (agent_id TEXT PRIMARY KEY, expired INTEGER NOT NULL);
ALTER TABLE agents ADD COLUMN launch_command TEXT;
PRAGMA user_version = 4;
