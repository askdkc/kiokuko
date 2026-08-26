# Kiokuko（記憶庫）

[English](README.md) | 日本語 | [简体中文](README.zh-CN.md) | [한국어](README.ko.md)

**MCPでつなぎ、RAGで思い出し、作業後に記憶する。**

Kiokukoは、AIコーディングエージェント向けの外部記憶です。

過去の作業から得た知識をローカルのSQLiteへ保存し、次の依頼で関連する記憶だけを検索してAIへ渡します。

ユーザーが毎回プロンプトに過去の経緯を貼ったり、記憶を手作業で探したりする必要はありません。普段どおりAIを使うだけで、プロジェクト固有の知識が少しずつ蓄積され、次の作業へ再利用されます。

## すぐ使う

Node.js 24.16以上が必要です。
以下の2コマンドで楽々スタートです💕

```bash
npm install --global @askdkc/kiokuko
kiokuko setup
```

`setup`は、インストール済みの対応クライアントを検出し、SQLiteデータベースとMCP接続を自動設定します。
対話式setupでは、監査済みcommunity Skillも参考資料として利用するか確認します。既定は「いいえ」です。
モデル向けの記憶は、capability gateを通るMCPツール `task_prepare` と
`task_answer` からだけタスクへ渡されます。Kiokukoは、これらの呼び出し前に
記憶を暗黙取得するclient Hookやpluginをインストールしません。

設定後、対象のAIクライアントを起動し、あとは普段どおり使うだけです。すでに起動している場合は、いったん終了してから起動し直してください。

対応クライアント：

- Codex
- OpenCode
- Claude Code
- Hermes Agent

## 使うほど賢くなる仕組み

```text
ユーザーの依頼
      ↓
関連する過去の記憶を検索
      ↓
AIが記憶を参照して作業
      ↓
再利用できる成果や教訓を保存
      ↓
次の依頼で再び検索
```

Kiokukoは、次の流れを繰り返します。

1. 作業前に、現在のプロジェクトとGlobal記憶を検索する
2. 関連性の高い記憶だけをAIへ渡す
3. AIが作業を実行する
4. 作業後に、再利用できる知識を記憶する
5. 次の作業で、その記憶を再利用する

つまりKiokukoは、**永続的な記憶を蓄積していくRAGシステム**です。

MCPはAIクライアントとKiokukoを接続し、RAGは必要な記憶を検索してAIへ渡します。

## 記憶はプロジェクトごとに分離

通常の検索では、無関係なプロジェクトの記憶を混ぜません。

- **Project記憶**  
  現在のリポジトリだけで使う知識

- **Ecosystem記憶**  
  元のプロジェクトに保持したまま、言語、フレームワーク、データベース、ランタイム、ツールなどの適用条件が現在のプロジェクトと一致する場合だけ再利用する知識

- **Global記憶**  
  特定のプロジェクトに依存せず、複数プロジェクトで再利用するよう明示的に一般化した知識

自由形式のタグが一致するだけでは、Project記憶は他のプロジェクトへ共有されません。Ecosystem検索では、記憶に保存された構造化された適用条件と、現在のプロジェクトから検出した技術構成の両方が一致するかを確認します。プロジェクト固有のパスや識別子などを含む記憶は対象外です。

プロジェクトはGitリモートやパスから自動判定されます。

Project記憶をGlobal記憶へ移す場合は、Curatorで候補を確認して明示的に承認します。

```bash
kiokuko curator
```

## 記憶を確認する

ローカルWeb UIから、保存された記憶の検索、確認、編集ができます。

```bash
kiokuko web
```

ブラウザで次を開きます。

```text
http://127.0.0.1:4173
```

Web UIはローカル環境だけで動作し、外部ネットワークへ公開されません。
Web UIと明示的なmemory CLI commandは人間/operator向けの管理surfaceです。
モデルが `task_prepare` / `task_answer` を迂回してタスク記憶を取得する経路ではありません。

## 外部Skill

外部Skillの発見は参考データ専用で、Akinatorのtask preparationでは既定で
`official` モードを使います。現在のGitHub commitを検証し、制限した本文を
常に `candidate` + `untrusted` + `reference` の記憶として保存します。
インストールや実行は行いません。自動発見を止める場合は
`KIOKUKO_SKILL_DISCOVERY=off` を指定します。`community` は引き続き明示的な
opt-inです。対話式 `kiokuko setup` はcommunityを有効にするか確認し、バッチ実行では
`--skill-discovery community` で明示できます。

具体的な操作例:

```bash
kiokuko skills find svelte --official-only --json
kiokuko skills list
kiokuko skills disable sveltejs/ai-tools/svelte-code-writer
kiokuko skills refresh sveltejs/ai-tools/svelte-code-writer
```

Web UIのExternal Skills画面ではsource状態を確認し、mappingを無効化・再有効化
できます。インストール、script実行、MCP登録の操作はありません。

## 安全性

Kiokukoは会話全文を保存しません。

パスワード、APIキー、トークン、秘密鍵など、シークレットに見える内容は保存を拒否します。

保存された記憶は常に参考情報として扱われます。過去の記憶より、現在のコード、設定、実行結果が優先されます。

## 注意

Kiokukoはプロンプトを横取りする仕組みではありません。自動利用は各AIクライアントとモデルのMCP呼び出しに依存するため、すべてのターンで必ず呼び出される保証はありません。

詳細なコマンドは次から確認できます。

```bash
kiokuko --help
kiokuko setup --help
```
