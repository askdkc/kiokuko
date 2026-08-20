CREATE VIRTUAL TABLE entries_fts USING fts5(
    title,
    body,
    summary,
    tags_text,
    tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER entries_fts_ai AFTER INSERT ON entries BEGIN
    INSERT INTO entries_fts(rowid, title, body, summary, tags_text)
    VALUES (
        new.rowid,
        new.title,
        new.body,
        COALESCE(new.summary, ''),
        COALESCE((SELECT group_concat(tag, ' ') FROM tags WHERE entry_id = new.id), '')
    );
END;

CREATE TRIGGER entries_fts_ad AFTER DELETE ON entries BEGIN
    DELETE FROM entries_fts WHERE rowid = old.rowid;
END;

CREATE TRIGGER entries_fts_au AFTER UPDATE ON entries BEGIN
    DELETE FROM entries_fts WHERE rowid = old.rowid;
    INSERT INTO entries_fts(rowid, title, body, summary, tags_text)
    VALUES (
        new.rowid,
        new.title,
        new.body,
        COALESCE(new.summary, ''),
        COALESCE((SELECT group_concat(tag, ' ') FROM tags WHERE entry_id = new.id), '')
    );
END;

CREATE TRIGGER tags_fts_ai AFTER INSERT ON tags BEGIN
    DELETE FROM entries_fts WHERE rowid = (SELECT rowid FROM entries WHERE id = new.entry_id);
    INSERT INTO entries_fts(rowid, title, body, summary, tags_text)
    SELECT entries.rowid, entries.title, entries.body, COALESCE(entries.summary, ''),
           COALESCE((SELECT group_concat(tag, ' ') FROM tags WHERE entry_id = entries.id), '')
    FROM entries WHERE entries.id = new.entry_id;
END;

CREATE TRIGGER tags_fts_ad AFTER DELETE ON tags BEGIN
    DELETE FROM entries_fts WHERE rowid = (SELECT rowid FROM entries WHERE id = old.entry_id);
    INSERT INTO entries_fts(rowid, title, body, summary, tags_text)
    SELECT entries.rowid, entries.title, entries.body, COALESCE(entries.summary, ''),
           COALESCE((SELECT group_concat(tag, ' ') FROM tags WHERE entry_id = entries.id), '')
    FROM entries WHERE entries.id = old.entry_id;
END;

CREATE TRIGGER tags_fts_au AFTER UPDATE OF tag ON tags BEGIN
    DELETE FROM entries_fts WHERE rowid = (SELECT rowid FROM entries WHERE id = old.entry_id);
    INSERT INTO entries_fts(rowid, title, body, summary, tags_text)
    SELECT entries.rowid, entries.title, entries.body, COALESCE(entries.summary, ''),
           COALESCE((SELECT group_concat(tag, ' ') FROM tags WHERE entry_id = entries.id), '')
    FROM entries WHERE entries.id = new.entry_id;
END;

INSERT INTO entries_fts(rowid, title, body, summary, tags_text)
SELECT entries.rowid,
       entries.title,
       entries.body,
       COALESCE(entries.summary, ''),
       COALESCE((SELECT group_concat(tag, ' ') FROM tags WHERE entry_id = entries.id), '')
FROM entries;
