-- Additive hybrid-search projections. The original entries_fts index remains
-- intact so databases can be upgraded and rolled back without losing the v1
-- lexical search path.
CREATE VIRTUAL TABLE entries_trigram USING fts5(
    title,
    body,
    summary,
    tags_text,
    tokenize='trigram'
);

CREATE TABLE entry_search_signals (
    entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
    signal_type TEXT NOT NULL CHECK (
        signal_type IN ('language', 'framework', 'runtime', 'database', 'tool',
                        'platform', 'package', 'symbol', 'path', 'error', 'command', 'tag')
    ),
    normalized_value TEXT NOT NULL,
    PRIMARY KEY (entry_id, signal_type, normalized_value)
);

CREATE INDEX idx_entry_search_signals_lookup
    ON entry_search_signals(signal_type, normalized_value);

CREATE TRIGGER entries_trigram_ai AFTER INSERT ON entries BEGIN
    INSERT INTO entries_trigram(rowid, title, body, summary, tags_text)
    VALUES (
        new.rowid,
        new.title,
        new.body,
        COALESCE(new.summary, ''),
        COALESCE((SELECT group_concat(tag, ' ') FROM tags WHERE entry_id = new.id), '')
    );
END;

CREATE TRIGGER entries_trigram_ad AFTER DELETE ON entries BEGIN
    DELETE FROM entries_trigram WHERE rowid = old.rowid;
END;

CREATE TRIGGER entries_trigram_au AFTER UPDATE ON entries BEGIN
    DELETE FROM entries_trigram WHERE rowid = old.rowid;
    INSERT INTO entries_trigram(rowid, title, body, summary, tags_text)
    VALUES (
        new.rowid,
        new.title,
        new.body,
        COALESCE(new.summary, ''),
        COALESCE((SELECT group_concat(tag, ' ') FROM tags WHERE entry_id = new.id), '')
    );
END;

CREATE TRIGGER tags_trigram_ai AFTER INSERT ON tags BEGIN
    DELETE FROM entries_trigram WHERE rowid = (SELECT rowid FROM entries WHERE id = new.entry_id);
    INSERT INTO entries_trigram(rowid, title, body, summary, tags_text)
    SELECT entries.rowid, entries.title, entries.body, COALESCE(entries.summary, ''),
           COALESCE((SELECT group_concat(tag, ' ') FROM tags WHERE entry_id = entries.id), '')
    FROM entries WHERE entries.id = new.entry_id;
END;

CREATE TRIGGER tags_trigram_ad AFTER DELETE ON tags BEGIN
    DELETE FROM entries_trigram WHERE rowid = (SELECT rowid FROM entries WHERE id = old.entry_id);
    INSERT INTO entries_trigram(rowid, title, body, summary, tags_text)
    SELECT entries.rowid, entries.title, entries.body, COALESCE(entries.summary, ''),
           COALESCE((SELECT group_concat(tag, ' ') FROM tags WHERE entry_id = entries.id), '')
    FROM entries WHERE entries.id = old.entry_id;
END;

CREATE TRIGGER tags_trigram_au AFTER UPDATE OF tag ON tags BEGIN
    DELETE FROM entries_trigram WHERE rowid = (SELECT rowid FROM entries WHERE id = old.entry_id);
    INSERT INTO entries_trigram(rowid, title, body, summary, tags_text)
    SELECT entries.rowid, entries.title, entries.body, COALESCE(entries.summary, ''),
           COALESCE((SELECT group_concat(tag, ' ') FROM tags WHERE entry_id = entries.id), '')
    FROM entries WHERE entries.id = new.entry_id;
END;

INSERT INTO entries_trigram(rowid, title, body, summary, tags_text)
SELECT entries.rowid,
       entries.title,
       entries.body,
       COALESCE(entries.summary, ''),
       COALESCE((SELECT group_concat(tag, ' ') FROM tags WHERE entry_id = entries.id), '')
FROM entries;

INSERT INTO entry_search_signals(entry_id, signal_type, normalized_value)
SELECT entry_id, 'tag', lower(trim(tag)) FROM tags WHERE length(trim(tag)) > 0;
