# Kiokuko

[English](README.md) | 日本語 | [简体中文](README.zh-CN.md) | [한국어](README.ko.md)

Kiokukoは、AIコーディングエージェント向けのモデル非依存な外部記憶です。npmでグローバルインストールすると、現在のOSユーザー用SQLiteデータベースに構造化された記憶を保存し、stdio MCP経由でCodex、OpenCode、Claude Codeにタスク準備とrecall/checkpointツールを提供します。

## グローバルへのインストールと有効化

```bash
npm install --global @askdkc/kiokuko
kiokuko setup
```

npmパッケージ名は`@askdkc/kiokuko`ですが、インストールされるCLIコマンド名は引き続き`kiokuko`です。

セットアップ後にCodex、OpenCode、Claude Codeを再起動してください。それ以降は、各クライアントのグローバル指示が重要な作業の前後にKiokukoを呼び出すようエージェントへ指示し、必要になるとグローバル設定から`kiokuko mcp`が起動されます。

`setup`は明示的に実行する冪等な処理です。npmの`postinstall`がAIクライアントの設定を変更することはありません。既存のTOML/JSON/JSONC設定、コメント、指示内容、改行コード、ファイルモードを維持し、Kiokukoは管理対象セクションだけを更新します。

```bash
# 書き込まずに変更対象ファイルと予定内容を確認
kiokuko setup --dry-run --json

# 一方のクライアントだけを設定
kiokuko setup --clients codex
kiokuko setup --clients opencode
kiokuko setup --clients claude

# クライアントプロセスがnpmのPATHを継承しない場合は絶対パスを指定
kiokuko setup --command /absolute/path/to/kiokuko
```

セットアップ対象は次のとおりです。

| クライアント | MCP設定 | グローバル指示 |
|---|---|---|
| Codex | `$CODEX_HOME/config.toml`または`~/.codex/config.toml` | `$CODEX_HOME/AGENTS.md`または`~/.codex/AGENTS.md` |
| OpenCode | `$XDG_CONFIG_HOME/opencode/opencode.json`または`~/.config/opencode/opencode.json` | 同じディレクトリの`AGENTS.md` |
| Claude Code | `$CLAUDE_CONFIG_DIR/.claude.json`または`~/.claude.json` | `$CLAUDE_CONFIG_DIR/CLAUDE.md`または`~/.claude/CLAUDE.md` |

OpenCodeの`opencode.jsonc`がすでに存在する場合、Kiokukoはコメントを維持したままそのファイルを更新します。CodexにKiokuko管理外の`[mcp_servers.kiokuko]`テーブルが存在する場合、上書き対象を推測せずセットアップを停止します。

## 記憶のスコープ

データベースはOSユーザー全体で共有されますが、通常のrecallがデータベース全体を無条件に検索することはありません。

- `project`記憶は、`.kiokuko.json`、既知の正規パス、またはGit remoteから自動解決されます。他のプロジェクトの記憶は除外されます。
- `global`記憶は、本当にプロジェクト横断で利用する設定や教訓のために予約されています。
- デフォルトの`auto` recallは、現在のプロジェクトとglobal記憶だけを返します。
- remoteのないリポジトリには、パスから導出した安定した識別子を使用します。自動解決時にKiokukoがリポジトリ内へファイルを書き込むことはありません。

MCPの公開インターフェースは意図的に小さくしています。

- `task_prepare`: Akinator形式の取り込み、上限付きの記憶・参照検索、現在のクライアントから渡されたSKILL/MCPツール名との照合を一度に行います。
- `task_answer`: ユーザーの依頼または確認済みのリポジトリ情報に根拠がある回答だけで、取り込みを続行します。
- `memory_recall`: 上限付きのproject/globalコンテキストを読み取ります。結果には常にuntrustedマークが付きます。
- `memory_checkpoint`: 上限付きの永続的な記憶を`candidate`かつ`untrusted`として保存します。シークレットに見える内容は拒否されます。

これは指示による自動利用であり、プロンプトの横取りではありません。Codex、OpenCode、Claude Codeが特定のターンでツールを呼ばない可能性は残ります。Kiokukoはフックをインストールせず、会話全文を取得せず、取得したSKILLを自動インストールせず、記憶を暗黙にverifiedへ昇格させません。

## 開発

```bash
npm install
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

## 開発環境での実行

```bash
npm exec -- tsx src/bin/kiokuko.ts setup --dry-run --json
npm exec -- tsx src/bin/kiokuko.ts mcp
```

`kiokuko use`は、移植可能な明示的バインディングが必要な場合の任意機能として残っています。`.kiokuko.json`と`AGENTS.md`内の管理ブロックを作成しますが、通常のMCP利用では不要です。

## Akinator形式の知識取り込み

重要な作業では、セットアップ済みのエージェント指示が`task_prepare`を呼び出します。このツールはタスク種別、対象、成功条件など、不足している価値の高い項目だけを質問し、クエリとBot用途タグからローカル記憶を選択します。クライアントが現在利用可能なSKILLとMCPツールの名前を渡した場合は、必要な機能を照合し、`available`、`missing`、`unknown`を区別して返します。この一覧は一時的にだけ使用され、保存されません。CLIの`guide`コマンドでも同じ取り込みを手動実行できます。

```bash
kiokuko guide start "Implement the API change and add tests" \
  --workspace <workspace> --json
kiokuko guide answer <session-id> --workspace <workspace> \
  --question-id target --value src/api.ts --json
kiokuko guide answer <session-id> --workspace <workspace> \
  --question-id expected --value "All tests pass" --json
kiokuko guide context <session-id> --workspace <workspace> --json
```

ローカル検索で関連エントリが見つからず、クライアントが利用可能なSKILLは0件だと明示した場合に限り、`task_prepare`は次の単一の許可済み公開リポジトリから現在の`main`ツリーを取得できます。

- https://github.com/mattpocock/skills

capability一覧の省略は0件ではなく「不明」として扱い、フォールバックを無効にします。SKILLが1件以上ある場合も無効です。CLIで手動利用する場合は、`guide context ... --no-client-skills`で同じ条件を明示します。`disable-model-invocation: true`のSKILLは自動選択から除外します。

インポートされた各エントリには、リポジトリ、commit SHA、ソースパスが記録されます。これらは信頼されていない参照資料であり、自動的に`verified`へ昇格したり、コマンドとして実行されたりすることはありません。同期の再実行はコンテンツハッシュにより冪等です。

## ローカルWeb UI

ループバック専用HTTPサーバーを起動すると、Bot用途、記憶タイプ、横断タグで記憶エントリを閲覧し、ブラウザからcandidateエントリを編集できます。

```bash
kiokuko web
# http://127.0.0.1:4173 を開く
```

`--port 0`で空いているポートを自動選択でき、`--json`で選択されたURLをJSONとして出力できます。Web UIが非ループバックインターフェースへサーバーを公開することはありません。verifiedおよびsupersededエントリは読み取り専用です。candidateの編集には楽観的リビジョン検査が使われ、監査履歴が維持されます。

`bot:researcher`、`bot:builder`、`bot:reviewer`などのタグは、種類をまたいだフィルターとして使用できます。エントリまたはサイドバーのタグをクリックすると、記憶タイプに関係なく一致するすべてのエントリが表示されます。

記憶エントリは信頼されていない保存データです。過去のエントリを利用する前に、現在のファイルとランタイム状態を確認してください。パスワード、APIキー、トークン、秘密鍵、セッションCookieを保存しないでください。

このリポジトリは自動公開されません。`npm publish`、commit、pushにはユーザーによる明示的な許可が必要です。
