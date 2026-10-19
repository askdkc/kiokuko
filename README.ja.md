# Kiokuko（記憶庫）

[English](README.md) | 日本語 | [简体中文](README.zh-CN.md) | [한국어](README.ko.md)

AIエージェント用のローカルメモリです。好み・判断・訂正をSQLiteに保存し、
必要な文脈をMCP経由で検索します。

**Codex・OpenCode・Claude Code・Hermes Agent**に対応。
[ChatGPTへの接続はプレビュー版です](docs/setup-notes.ja.md#chatgpt)。

## インストール

Node.js **24.16.0以上**が必要です。

```bash
npm i -g kiokuko
kiokuko setup
```

クライアントを再起動すれば、あとは普段どおり使えます。MCP・標準Skill・
ローカルsemantic検索を設定します。埋め込みモデルのダウンロードを省く場合は
`kiokuko setup --no-embeddings`を使ってください。

1.0未満からの更新には新規DBが必要です。
[移行と旧設定の撤去](docs/breaking-changes-1.0.md)。

## ドキュメント

<a id="setup-messages"></a>

- [導入ガイド](docs/getting-started.ja.md)
- [設定・トラブルシューティング・アンインストール](docs/setup-notes.ja.md)
- [記憶と検索](docs/concepts.ja.md)
- [履歴とコードの証拠（英語）](docs/history-evidence.md)
- [ドキュメント一覧](docs/README.ja.md)

保存した記憶には誤りがありえます。秘密情報に見える内容は拒否し、会話全文は保存しません。
MCPの呼び出しはクライアントとモデルの判断に依存します。
[安全性と信頼の境界](docs/security-and-trust.ja.md)。
