# Semantic retrieval evaluation

Evaluation version: 1  
Fixture: `tests/fixtures/retrieval-evaluation/`  
Runner: `npm run test:evaluation`

The deterministic fixture expands to 110 queries: 100 positive exact,
lexical, semantic-only, mixed Japanese/English, and hard-negative queries plus
10 stale/superseded negative queries. It runs migration 001–021, canonical
entry writes, an active embedding profile, ordinary vector BLOB projection, the
JavaScript exact-cosine backend, and the production `hybridSearch` weighted-RRF
path. It does not call a remote provider.

Recorded baseline on 2026-08-31 using Node.js v26.5.0 on macOS arm64:

| Metric | Result | Gate |
| --- | ---: | ---: |
| Recall@1 | 0.93 | >= 0.90 |
| Recall@5 | 0.99 | >= 0.99 |
| MRR | 0.955 | recorded |
| exact-identifier Recall@1 | 1.00 | 1.00 |
| semantic-only Recall@5 | 0.95 | >= 0.95 |
| lexical semantic-only Recall@5 | 0.35 | baseline |
| semantic-only improvement | +0.60 | >= +0.50 |
| scope leakage | 0 | 0 |
| stale/superseded semantic delivery | 0 | 0 |

The baseline keeps the planned semantic RRF weight `2.5` and fixture distance
ceiling `0.25`. One semantic-only query ranks its expected entry sixth because
several lexical lanes agree on other candidates; this is recorded rather than
hidden by tuning the gate after the fact. Exact-identifier Recall@1 remains
1.00, so the semantic lane did not displace exact identifiers in this fixture.

The separate database-search performance fixture uses 10,000 vectors at 384,
768, and 1,536 dimensions. It records p50, p95, peak process RSS, and a digest
that must match between JavaScript and sqlite-vec rankings:

```bash
npm run test:benchmark
```

Recorded database-search baseline on 2026-08-31 using Node.js v26.5.0 on
macOS arm64 (25 measured searches after one warm-up, limit 20):

| Dimensions | Backend | p50 | p95 | Peak process RSS |
| ---: | --- | ---: | ---: | ---: |
| 384 | JavaScript | 114.0 ms | 120.7 ms | 284.4 MiB |
| 384 | sqlite-vec | 16.6 ms | 17.9 ms | 283.9 MiB |
| 768 | JavaScript | 198.5 ms | 206.3 ms | 535.1 MiB |
| 768 | sqlite-vec | 24.3 ms | 26.0 ms | 480.9 MiB |
| 1,536 | JavaScript | 367.5 ms | 371.6 ms | 732.2 MiB |
| 1,536 | sqlite-vec | 37.7 ms | 53.6 ms | 732.3 MiB |

The backend result digests matched at every dimension. RSS is the peak for the
whole benchmark process, not isolated incremental allocation per search. On
this measured platform sqlite-vec is faster, so `auto` selecting sqlite-vec
when its exact package loads is appropriate. Other supported platforms still
need their own measurements; operators can force `javascript` where native
results are slower or the extension is unavailable.

Provider latency is deliberately excluded because it is network- and
deployment-specific. The benchmark records measurements but does not invent a
fixed latency threshold before results exist for every supported platform.
Platform smoke jobs record only the matrices that actually run; Windows and
additional architecture verification remain release gates before semantic
retrieval can become enabled by default.
