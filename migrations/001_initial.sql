CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL
);

CREATE TABLE repositories (
    repository_id TEXT PRIMARY KEY,
    workspace TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    remote_fingerprint TEXT,
    binding_schema_version INTEGER NOT NULL,
    agent_template_version INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    last_used_at TEXT NOT NULL
);

CREATE TABLE repository_locations (
    repository_id TEXT NOT NULL REFERENCES repositories(repository_id),
    canonical_root TEXT NOT NULL UNIQUE,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    PRIMARY KEY (repository_id, canonical_root)
);

CREATE TABLE entries (
    id TEXT PRIMARY KEY,
    workspace TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (
        kind IN ('fact', 'decision', 'lesson', 'preference', 'reference')
    ),
    status TEXT NOT NULL CHECK (
        status IN ('candidate', 'verified', 'superseded')
    ),
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    summary TEXT,
    scope_json TEXT NOT NULL DEFAULT '{}',
    provenance_json TEXT NOT NULL DEFAULT '{}',
    trust_level TEXT NOT NULL DEFAULT 'user_asserted' CHECK (
        trust_level IN ('untrusted', 'user_asserted', 'source_verified', 'system_verified')
    ),
    confidence REAL NOT NULL CHECK (confidence >= 0.0 AND confidence <= 1.0),
    content_hash TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1,
    superseded_by TEXT REFERENCES entries(id),
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    verified_at TEXT,
    CHECK (status != 'superseded' OR superseded_by IS NOT NULL)
);

CREATE UNIQUE INDEX idx_entries_workspace_hash
    ON entries(workspace, content_hash);
CREATE INDEX idx_entries_workspace_status
    ON entries(workspace, status, updated_at DESC);
CREATE INDEX idx_entries_workspace_kind
    ON entries(workspace, kind, updated_at DESC);

CREATE TABLE tags (
    entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
    tag TEXT NOT NULL,
    PRIMARY KEY (entry_id, tag)
);

CREATE TABLE entry_links (
    from_entry_id TEXT NOT NULL REFERENCES entries(id),
    to_entry_id TEXT NOT NULL REFERENCES entries(id),
    relation TEXT NOT NULL CHECK (
        relation IN ('supports', 'contradicts', 'derived_from', 'related_to')
    ),
    created_at TEXT NOT NULL,
    created_by TEXT NOT NULL,
    PRIMARY KEY (from_entry_id, to_entry_id, relation)
);

CREATE TABLE audit_events (
    event_id TEXT PRIMARY KEY,
    entry_id TEXT REFERENCES entries(id),
    workspace TEXT NOT NULL,
    operation TEXT NOT NULL CHECK (
        operation IN ('record', 'promote', 'supersede', 'link', 'import', 'purge')
    ),
    actor TEXT NOT NULL,
    details_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
);
