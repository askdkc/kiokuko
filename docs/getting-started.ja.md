# 導入ガイド

## インストールと設定

Node.js 24.16.0以上が必要です。次の2コマンドで導入します。

```bash
npm install --global @askdkc/kiokuko
kiokuko setup
```

Optional setup flags: `--no-standard-skills`, `--skill-discovery off|official|community`, and `--dry-run --json`.

Codexでは次のmanaged blockを所有します。

```toml
[mcp_servers.kiokuko]
command = "kiokuko"
args = ["mcp"]
enabled = true
required = true
```

`required`の欠落、値、順序、重複key、余分なfieldの変更や
`required = false`はuser-managed conflictとして無断上書きしません。対話実行では置換確認を行い、JSON・非対話・dry-runでは
`CONFLICT`を返して変更しません。他の対応clientも同じ規則です。

起動中のclientは設定後に再起動してください。
`kiokuko doctor --json`はruntime、DB、Codex MCPを読み取り専用で検査します。

## Embeddings

`kiokuko embeddings setup`は固定semantic runtimeを導入し、`kiokuko setup`と同じclient設定フロー（conflict確認、managed MCP更新、
登録済みプロジェクトのinstructions更新）を実行します。

```bash
kiokuko embeddings setup --clients codex
kiokuko embeddings setup --preset local-small --offline
kiokuko embeddings status --json
```

`--replace`は別のembedding profileから切り替える指定です。`--dry-run`はdownloadと変更を行わず、`--json`は自動化向けで
unmanaged MCP identityをfail closedします。

## Web UIとclient