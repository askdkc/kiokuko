# 導入ガイド

## インストールと設定

Node.js 24.16.0以上が必要です。次の2コマンドで導入します。

```bash
npm install --global @askdkc/kiokuko
kiokuko setup
```

`setup`はクライアント設定とローカルsemantic検索の導入を行います。
埋め込みランタイムの導入・モデル取得・埋め込み生成を省略する場合:

```bash
kiokuko setup --no-embeddings
```

既存の埋め込み設定とモデルは保持します。設定済みsemantic検索を無効化するフラグではありません。
ほかに`--no-standard-skills`、`--skill-discovery off|official|community`、`--dry-run --json`が使えます。

Terminalでは、↑↓でエージェント間を移動し、Spaceでチェックを切り替え、Enterで確定します。
数字キー1〜4でも各エージェントのチェックを切り替えられます。検出済みのエージェントは選択済みで、複数選択できます。
EscまたはCtrl+Cで選択を中断します。自動実行では`--clients codex,opencode`のように対象を指定してください。

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
対話実行の`kiokuko doctor`では、登録済みの指示ファイルの再作成や、Kiokuko専用部分の
追加・更新を確認します。Enterだけなら変更しません。再作成できるのはKiokukoの指示だけで、
削除された独自の指示は復元できません。修復では独自の記述と他製品の部分を残します。
Kiokukoの指示はプラグイン専用のHTMLコメントに格納し、通常のsetup更新で旧形式を移行します。
JSON・非対話実行では確認やファイル変更を行わず、
`data.checks.agentFiles.findings`に対象パスと理由を返します。

## Embeddings

`kiokuko setup`は固定semantic runtimeの導入とclient設定（conflict確認、managed MCP更新、
登録済みプロジェクトのinstructions更新）を実行します。`kiokuko embeddings setup`は同じ実装への
互換入口で、こちらでも`--no-embeddings`を指定できます。

```bash
kiokuko setup --clients codex
kiokuko setup --preset local-small --offline
kiokuko embeddings status --json
```

`--replace`は別のembedding profileから切り替える指定です。`--dry-run`はdownloadと変更を行わず、`--json`は自動化向けで
unmanaged MCP identityをfail closedします。

## Web UIとclient


材料が会話内に揃った回答だけの依頼は、run 作成や記憶検索を行わず回答します。判断に必要な事実だけが欠けている場合は、限定読み取りの `task_inspect` を使えます。`operation: "diff"` の `scope` は `"auto" | "staged" | "working-tree"` で、auto は staged があれば優先し、選択した scope を返します。外部 diff、textconv、作業ツリーの filter は実行しません。コード変更、操作、正式なレビュー・実装計画では intake と検証を維持します。追加確認は判断を変えるか完了を証明する場合に限り、最低思考時間は設けません。

通常の setup 更新は、ユーザー記述を保存し、既存の管理指示と Skill を更新します。設定済みクライアントのグローバル指示や登録済みプロジェクトの指示ファイルが欠落している場合は、再作成せず skipped として報告します。登録済みプロジェクトの欠落ファイルを復元したい場合は、既存の対話式 `kiokuko doctor` の確認に答えてください。
