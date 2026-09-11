# Kiokuko（記憶庫）

1.0では旧DBを利用できません。新規DBで開始してください。[破壊的変更と旧設定の撤去手順](docs/breaking-changes-1.0.md)を参照してください。

[English](README.md) | 日本語 | [简体中文](README.zh-CN.md) | [한국어](README.ko.md)

**MCPで接続し、必要な記憶を検索し、作業後に知識を蓄積する。**

KiokukoはAIコーディングエージェント向けのローカル外部メモリです。SQLiteに知識を保存し、
次のタスクに関係する文脈を検索し、作業結果から再利用できる知識を記録します。

## 基本概念

```text
依頼 → MCP接続 → 関係する記憶を検索 → 作業
                                  ↓
                         再利用できる知識を保存
```

記憶はProject・Ecosystem・Globalに分離されます。現在のコード、設定、実行結果が過去の記憶より優先されます。

## 最短セットアップ

Node.js 24.16.0以上が必要です（Node.js 26.1.0以上にも対応）。

```bash
npm install --global @askdkc/kiokuko
kiokuko setup
```

`setup`はローカルDB・標準Skill・MCP接続に加えて、ローカルsemantic検索も設定します。
初回は埋め込みランタイムとモデルを導入します。
起動中のクライアントは、設定後に一度再起動してください。正確な設定規則は
[導入ガイド](docs/getting-started.ja.md)を参照してください。

埋め込みランタイムとモデルを導入せず、クライアント設定だけ行う場合:

```bash
kiokuko setup --no-embeddings
```

埋め込みのセットアップを省略します。既存の埋め込み設定は変更しません。

## アンインストール

Kiokukoを使うクライアントと`kiokuko serve`を終了してから実行します。

```bash
kiokuko uninstall --dry-run
kiokuko uninstall
# 全エージェントを選択して正常終了後、最後に表示されたコマンドを実行
npm uninstall --global kiokuko
```

↑↓で移動、Spaceで選択を切り替え、Enterで確定、Escで中止します。初期状態は未選択です。
選択したエージェントの管理設定・Skillだけを削除します。**全4エージェントを選ぶと記憶DB・埋め込みモデル・登録済みプロジェクトの管理部分も削除**し、最後にnpmの削除コマンドを表示します。一部だけを選んだ場合は共有データとnpmパッケージを残します。ユーザーが書いた内容は保持します。
スクリプトでは `kiokuko uninstall --clients opencode,claude`、完全削除には `kiokuko uninstall --all` を使います。
独自の配置先を指定していた場合は、セットアップ時と同じ環境変数で実行してください。[削除範囲と失敗時の扱い](docs/cli-contract.md#uninstall)

## 主な機能

- **RAGメモリ**: lexical検索に加え、`setup`でローカルsemantic検索を設定。
- **Akinator**: 曖昧な依頼を作業前に具体化。
- **ローカルWeb UI**: 保存した記憶の確認と整理。
- **参照専用Skill**: 外部Skillは検証して保存するが、自動実行しない。

`kiokuko embeddings setup`は、`kiokuko setup`と同じ処理を行う互換コマンドとして利用できます。

managed MCP blockと登録済みプロジェクトのinstructionsを更新します。unmanaged identityの置換は対話確認後だけ行い、
非対話または`--dry-run --json`では変更せずfail closedします。詳細は
[semantic retrievalガイド](docs/semantic-retrieval.ja.md)を参照してください。

## 対応クライアント

Codex、OpenCode、Claude Code、Hermes Agentに対応しています。client別の設定、再起動、Web UIは
[導入ガイド](docs/getting-started.ja.md)にまとめています。

## 安全性と制約

会話全文は保存せず、パスワード、API key、token、秘密鍵に似た内容を拒否します。保存された記憶は参考情報であり、
現在のリポジトリと実行結果で確認してください。

MCPの利用はclientとモデルが決めるため、**毎回必ずKiokukoが呼ばれる保証はありません**。信頼境界と公開エラーは
[Security and trust](docs/security-and-trust.ja.md)で説明しています。

## 詳細ドキュメント

- [ドキュメント目次](docs/README.ja.md)
- [導入ガイド](docs/getting-started.ja.md)
- [基本概念](docs/concepts.ja.md)
- [Semantic retrieval](docs/semantic-retrieval.ja.md)
- [Security and trust](docs/security-and-trust.ja.md)
- [CLI contract](docs/cli-contract.md)

実装者向け資料は[architecture](docs/architecture.md)、[database](docs/database.md)、[execution ledger](docs/execution-ledger.md)、
[client compatibility](docs/client-compatibility.md)を参照してください。
