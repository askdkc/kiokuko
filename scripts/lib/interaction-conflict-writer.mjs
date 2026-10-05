// Separate real writer used only against the live harness's disposable DB.
import { openConnection } from '../../dist/db/connection.js';
import { getGlobalDatabasePath } from '../../dist/config/paths.js';
import { readEntry, updateCandidateEntry } from '../../dist/memory/entries.js';
const database = openConnection(getGlobalDatabasePath());
try {
  const entry = readEntry(database, { workspace: 'global', entryId: process.argv[2] });
  const revised = updateCandidateEntry(database, { workspace: entry.workspace, entryId: entry.id,
    expectedRevision: entry.revision, kind: entry.kind, title: entry.title,
    body: entry.body + '\nAlso keep explanations concise.', summary: null,
    scope: entry.scope, provenance: entry.provenance, tags: entry.tags, actor: 'synthetic-conflict-writer' });
  console.log(JSON.stringify({ entryId: revised.id, revision: revised.revision }));
} finally { database.close(); }
