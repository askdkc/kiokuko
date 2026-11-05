CREATE TABLE codex_desktop_replay_bindings (
  run_id TEXT PRIMARY KEY NOT NULL,
  identity_digest TEXT NOT NULL UNIQUE REFERENCES codex_hook_requests(identity_digest) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  transcript_path TEXT NOT NULL
);
