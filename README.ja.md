# Kiokuko

[English](README.md) | 日本語 | [简体中文](README.zh-CN.md) | [한국어](README.ko.md)

Kiokukoは、AIコーディングエージェント向けのモデル非依存な外部記憶です。npmでグローバルインストールすると、現在のOSユーザー用SQLiteデータベースに構造化された記憶を保存し、native stdio MCP経由でCodex、OpenCode、Claude Code、Hermes Agentにタスク準備とrecall/checkpointツールを提供します。

## グローバルへのインストールと有効化

Node.js 24以上が必要です。

```bash
npm install --global @askdkc/kiokuko
kiokuko setup
```

`PATH`上に`hermes`実行ファイルが検出された場合、引数なしの`setup`は有効なHermesプロファイルだけを設定し、Kiokukoデータベースを初期化して同梱標準スキルを配置します。利用できる場合は`hermes config path`で現在のプロファイルを取得し、利用できない場合は有効な`active_profile`または既定の`$HOME/.hermes`を使います。`hermes`実行ファイルがない場合、引数なしのコマンドは対応する全クライアントを設定します。`--clients`を明示した場合は、常にその指定が優先されます。

npmパッケージ名は`@askdkc/kiokuko`ですが、インストールされるCLIコマンド名は引き続き`kiokuko`です。

セットアップ後にCodex、OpenCode、Claude Code、Hermes Agentを再起動してください。Hermesの`/reload-mcp`はMCP登録を再読み込みできますが、更新された標準スキルの検出には再起動または新規セッションが必要です。`hermes mcp test kiokuko`でスモークテストできます。Hermesは有効なプロファイルのnative stdio MCPを使い、グローバル指示ファイル、Hermes plugin、hookは作成しません。

`setup`は明示的に実行する冪等な処理です。npmの`postinstall`がAIクライアントの設定を変更することはありません。既存のTOML/JSON/JSONC/YAML設定、コメント、指示内容、改行コード、ファイルモードを維持し、Kiokukoは管理対象セクションだけを更新します。既定では、固定されたローカルマニフェストから`kiokuko-ui-design-soul`標準スキルも導入します。setup時のダウンロードやHIGページのスクレイピングは行いません。

既存データベースに未適用のマイグレーションがある場合、setupは先に現在のユーザー用データディレクトリ内の`backups/`へバックアップを作成し、整合性を検査します。現在のKiokukoより新しいバージョンで更新されたデータベースは変更せず拒否します。

```bash
# 書き込まずに変更対象ファイルと予定内容を確認
kiokuko setup --dry-run --json

# 一方のクライアントだけを設定
kiokuko setup --clients codex
kiokuko setup --clients opencode
kiokuko setup --clients claude
kiokuko setup --clients hermes

# クライアントプロセスがnpmのPATHを継承しない場合は絶対パスを指定
kiokuko setup --command /absolute/path/to/kiokuko

# 標準スキルの新規配置を省略（既存の管理済みコピーは削除しない）
kiokuko setup --no-standard-skills
```

Hermesの設定はプロファイル単位です。`$HOME/.hermes/profiles/work/config.yaml`のようなnamed profileには、そのプロファイルのMCP設定と標準スキルだけを配置し、rootや非アクティブなプロファイルは変更しません。別プロセスで一時的に指定した`hermes -p <name>`は自動推測しません。確実にnamed profileを指定するには、次のように`HERMES_HOME`へプロファイルディレクトリを渡します。

```bash
HERMES_HOME="$HOME/.hermes/profiles/work" kiokuko setup --clients hermes
```

Desktopプロセスから`kiokuko`が見つからない場合は、空の`command -v`結果を渡さず、絶対パスへ移行します。

```bash
KIOKUKO_BIN="$(command -v kiokuko)"
test -n "$KIOKUKO_BIN" && test -x "$KIOKUKO_BIN" || { echo "kiokuko executable not found" >&2; exit 1; }
kiokuko setup --clients hermes --command "$KIOKUKO_BIN"
```

セットアップ対象は次のとおりです。

| クライアント | MCP設定 | グローバル指示 | 実行時ガード | 標準スキル |
|---|---|---|---|---|
| Codex | `$CODEX_HOME/config.toml`または`~/.codex/config.toml` | `$CODEX_HOME/AGENTS.md`または`~/.codex/AGENTS.md` | — | `~/.agents/skills/kiokuko-ui-design-soul` |
| OpenCode | `$XDG_CONFIG_HOME/opencode/opencode.json`または`~/.config/opencode/opencode.json` | 同じディレクトリの`AGENTS.md` | `plugins/kiokuko-loop-guard.js` | グローバル設定内の`skills/kiokuko-ui-design-soul` |
| Claude Code | `$CLAUDE_CONFIG_DIR/.claude.json`または`~/.claude.json` | `$CLAUDE_CONFIG_DIR/CLAUDE.md`または`~/.claude/CLAUDE.md` | — | Claude設定内の`skills/kiokuko-ui-design-soul` |
| Hermes Agent | 有効なプロファイルの`config.yaml`（`$HERMES_HOME`、`$HOME/.hermes`、またはWindowsの`%LOCALAPPDATA%/hermes`） | なし | なし | 有効なプロファイル内の`skills/kiokuko-ui-design-soul` |

Hermesの設定はプロファイル単位です。`mcp_servers.kiokuko`に`command: kiokuko`と`args: [mcp]`を登録します。管理対象の正規形であれば`--command`でcommandだけを移行でき、args、コメント、他serverは保持します。未管理entry、余分なfield、`mcp`以外のargsは引き続きconflictです。Hermesの組み込みmemoryとskillsはKiokukoとは別です。モデルがMCP tool descriptionを使うかどうかはbest effortです。

OpenCodeの`opencode.jsonc`がすでに存在する場合、Kiokukoはコメントを維持したままそのファイルを更新します。CodexにKiokuko管理外の`[mcp_servers.kiokuko]`テーブルが存在する場合、上書き対象を推測せずセットアップを停止します。管理対象のOpenCodeガードは、可視エージェントを12 stepに制限し、1ユーザー要求につき`task_prepare`と`memory_checkpoint`を各1回までにし、チェックポイント後のツール利用を閉じ、同一呼び出しまたは読み取り専用の探索結果が3回続いた後の再実行を停止します。カウンターとフィンガープリントはプロセスメモリにだけ保持します。

標準スキルの各ファイルにはKiokuko管理マーカーがあります。setupは固定された既知ファイルだけを更新し、完全一致は`unchanged`とし、無関係な兄弟ファイルは変更しません。同名ファイルに管理マーカーがなければ、ファイルやデータベースへ書き込む前に`CONFLICT`で停止します。

## 記憶のスコープ

データベースはOSユーザー全体で共有されますが、通常のrecallがデータベース全体を無条件に検索することはありません。

- `project`記憶は、`.kiokuko.json`、既知の正規パス、またはGit remoteから自動解決されます。他のプロジェクトの記憶は除外されます。
- `global`記憶は、本当にプロジェクト横断で利用する設定や教訓のために予約されています。
- デフォルトの`auto` recallは、現在のプロジェクトとglobal記憶だけを返します。
- remoteのないリポジトリには、パスから導出した安定した識別子を使用します。自動解決時にKiokukoがリポジトリ内へファイルを書き込むことはありません。

MCPの公開インターフェースは意図的に小さくしています。

- `task_prepare`: 1ユーザー要求につき1回だけ、Akinator形式の取り込み、上限付きの記憶・参照検索、現在のクライアントから渡されたSKILL/MCPツール名との照合を行います。
- `task_answer`: ユーザーの依頼または確認済みのリポジトリ情報に根拠がある回答だけで、取り込みを続行します。
- `memory_recall`: 上限付きのproject/globalコンテキストを読み取ります。結果には常にuntrustedマークが付きます。
- `curator_check`: 最終checkpointの前に、原則としてスキル化可能な候補だけを返します。qualified hitは「実行可能なAkinator経路を独立runで完了し、freshな検証または成功テストがある」場合だけです。検索・recall回数は数えません。
- `curator_globalize`: 表示されたスキル名と3行概要をユーザーが明示的に承認した後だけ、revision確認済みの再生成ドラフトをGlobalへ保存します。
- `memory_checkpoint`: ユーザー要求の最後に1回だけ、上限付きの永続的な記憶を`candidate`かつ`untrusted`として保存します。同時に、提案記憶ごとのAkinator絞り込み経路をrunと検証証拠に結び付けます。シークレットに見える内容は拒否されます。

## Curator

`kiokuko curator`は、プロジェクト内のcandidate記憶から、他のプロジェクトでも再利用できそうな知識を判定します。プロジェクト識別子やパスを中立化し、「目的・手順・適用条件・検証」の構造を持つ汎用ドラフトをローカルで決定論的に再生成します。スキル名、3行程度の概要、再生成した本文に加え、qualified hit数、独立run数、workspace数、抽象→具体サイロ充足度を表示してから、対話的にGlobalへの追加を確認します。`--skill-ready-only`は定期確認に使う高根拠候補だけへ絞り込みます。

```bash
kiokuko curator
kiokuko curator --json
kiokuko curator --skill-ready-only
kiokuko curator --entry-id <entry-id>
```

Web UIの`Curator`ボタンでは、全プロジェクトworkspaceの汎用化候補を一覧表示します。候補ごとのチェックボックスで追加・見送りを選択し、選択した候補を1回の明示操作でGlobalへ追加できます。Globalには元のプロジェクト固有本文ではなく再生成ドラフトを保存します。外部LLMやAPIキーは使いません。追加後もGlobalエントリは`candidate`かつ`untrusted`のままで、元のworkspace・revision・provenanceを保持します。

これは指示による自動利用であり、プロンプトの横取りではありません。Codex、OpenCode、Claude Code、Hermes Agentが特定のターンでツールを呼ばない可能性は残ります。Hermesでの自動利用・モデル利用はMCP tool descriptionによるbest effortです。Hermesの組み込みmemoryとskillsは分離されたままです。KiokukoはHermes用のグローバル指示ファイル、plugin、hookを作成せず、会話全文を取得せず、外部から取得したSKILLを自動インストールせず、記憶を暗黙にverifiedへ昇格させません。OpenCodeへ導入するpluginは上記の限定的なローカルループガードだけであり、同梱標準スキルはpluginではなくクライアントnativeのskillです。

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

重要な作業では、セットアップ済みのエージェント指示が`task_prepare`を呼び出します。Akinatorは人気投票や固定フォームではなく、抽象的な意図から複数の行動系列を候補にし、質問ごとに候補を除外・具体化して、選択行動、検証方法、停止条件まで収束させる推論ガイドです。返却する抽象→具体サイロは、意図、行動系列、対象、成功状態、選択行動、検証の各層と充足度を持ちます。タスク種別、対象、観測可能な成功条件など、不足している価値の高い項目だけを質問し、その後にクエリと役割・用途タグからローカル記憶を選択します。クライアントが現在利用可能なSKILLとMCPツールの名前を渡した場合は、必要な機能を照合し、`available`、`missing`、`unknown`を区別して返します。この一覧は一時的にだけ使用され、保存されません。CLIの`guide`コマンドでも同じ取り込みを手動実行できます。

UI、UX、frontend、screen、SwiftUI、画面、アクセシビリティなどの具体的なUI語彙を含む依頼では、クライアントのcapability一覧に存在する`kiokuko-ui-design-soul`を`task_prepare`が明示的に推薦します。`design`単独、backend-only作業、画像生成だけの依頼では発火しません。

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

ループバック専用HTTPサーバーを起動すると、役割・用途、記憶タイプ、横断タグで記憶エントリを閲覧し、ブラウザからcandidateエントリを編集できます。

```bash
kiokuko web
# http://127.0.0.1:4173 を開く
```

UIは英語、日本語、簡体字中国語、韓国語に対応します。初回はブラウザの言語を使用し、明示的に選択した言語はブラウザに保存されます。`?lang=en`、`?lang=ja`、`?lang=zh-CN`、`?lang=ko`で上書きできます。

`--port 0`で空いているポートを自動選択でき、`--json`で選択されたURLをJSONとして出力できます。Web UIが非ループバックインターフェースへサーバーを公開することはありません。verifiedおよびsupersededエントリは読み取り専用です。candidateの編集には楽観的リビジョン検査が使われ、監査履歴が維持されます。

`bot:researcher`、`bot:builder`、`bot:reviewer`などのタグは、種類をまたいだフィルターとして使用できます。エントリまたはサイドバーのタグをクリックすると、記憶タイプに関係なく一致するすべてのエントリが表示されます。

記憶エントリは信頼されていない保存データです。過去のエントリを利用する前に、現在のファイルとランタイム状態を確認してください。パスワード、APIキー、トークン、秘密鍵、セッションCookieを保存しないでください。

このリポジトリは自動公開されません。`npm publish`、commit、pushにはユーザーによる明示的な許可が必要です。
