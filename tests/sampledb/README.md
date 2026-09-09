# Kiokuko sample database

`kiokuko.sqlite3` is a deterministic, synthetic CI fixture. It contains:

- project-scoped memory entries, including Unicode and multiline text;
- global memory entries;
- one imported external-skill snapshot and its entry mappings.

The fixture is generated from schema version 1, the Kiokuko 1.0 baseline.
Only the standalone `.sqlite3` file is committed; WAL and SHM files are runtime artifacts.
CI copies it into an isolated application-data directory before running
`kiokuko setup`. The test verifies unchanged migration history, runs
`kiokuko doctor`, and checks the data through a real `kiokuko web` process.

Regenerate it after intentionally changing the fixture or its baseline:

```sh
npm run sampledb:generate
```

Do not run `kiokuko setup` or `kiokuko web` directly against the committed
fixture. Use `npm run test:sampledb`, which works on a temporary copy.
