-- Minimal pre-1.0 database identity for refusal tests; not an upgrade fixture.
CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL);
INSERT INTO schema_migrations VALUES (1, '001_initial.sql', 'unsupported-major-checksum', '2026-01-01T00:00:00.000Z');
CREATE TABLE entries(id TEXT PRIMARY KEY, body TEXT NOT NULL);
INSERT INTO entries VALUES ('preserve', 'Existing user memory must remain unchanged.');
