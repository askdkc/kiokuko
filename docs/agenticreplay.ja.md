# AgenticReplayでKiokukoのセッションを記録する

Kiokukoに接続したクライアントのモデルAPI通信は
[AgenticReplay](https://github.com/askdkc/AgenticReplay)で記録できます。
任意で使う外部ツールです。Kiokukoからインストールしたり、記録のために
クライアント設定を変更したりはしません。検証済みの最低版は`package.json`で宣言し、
`npm ci`は`package-lock.json`で解決された版を導入します。検査は固定版ではなく動作を確認します。

## コマンドを確認する

インストール済みなら、そのコマンドを使ってください。

```bash
agenticreplay --version
agenticreplay doctor
```

リポジトリの検証では`npm ci`でローカルに導入します。別途グローバルに
導入する場合はAgenticReplayの公式手順に従い、以下の互換性チェックで動作を確認してください。

## クライアントを記録する

先に`kiokuko setup`でクライアントのMCP接続を設定し、必要なら再起動します。
作業対象のプロジェクトで、モデルへリクエストを送る**ホストクライアント**を
レコーダーから起動してください。`kiokuko mcp`だけを包んでも、ホスト側の
モデル通信は記録できません。

Claude Codeの場合：

```bash
agenticreplay record claude -- -p "Use Kiokuko to recall relevant context for this project."
agenticreplay show last
```

記録時はクライアントの既存の認証情報を使い、モデル利用料が発生する場合があります。
サブスクリプション認証のCodex CLIなど、base URLの設定でモデルAPIの接続先を
変更できないホストでは、プロセス内のTLS傍受を使います。

```bash
agenticreplay record exec --tls-intercept -- codex
```

独自のモデルAPIホストを使う場合は、AgenticReplayの`--tls-hosts`とupstream設定を
確認してください。クライアントはレコーダーから起動します。起動済みのデスクトップ
クライアントには、新しいプロセスの記録用環境変数は引き継がれません。

## 記録を確認してオフライン検証する

記録は対象プロジェクトの`.agenticreplay/runs/`に保存されます。
シリアライズされたリクエストから、ホストが実際にモデルへ送ったKiokukoの
ツールスキーマと結果を確認できます。プロバイダー内部の非公開の推論や、
記録境界より前の変更は観測できません。

```bash
agenticreplay list
agenticreplay show last --json
agenticreplay events last --json
```

リポジトリのテストは、元のモデル接続先を閉じてから、記録した応答を別のテスト用ホストへ
オフラインで返します。検証した現行版にはレコーダーのCLI再生コマンドはありません。
書き込み操作のテストでは、使い捨てのKiokukoデータディレクトリと
クライアント設定を使ってください。
通信本文とファイルのスナップショットは機密情報として扱い、共有前に確認します。
Kiokukoの記憶は、Git管理下のファイルでなくてもモデルへのリクエストに含まれます。

## リポジトリの互換性チェック

Node.jsとlockfileから導入したAgenticReplayを使って実行します。

```bash
npm ci
npm run test:agenticreplay
```

Kiokukoをビルドし、テスト用のNodeホストから実際のMCPサーバーを起動して、
ローカルのモデルfixtureへの2件のリクエストを記録します。
記録された`task_inspect`のスキーマとSOULの結果を確認した後、モデルの接続先を停止し、
記録した2件の応答を別のホストへ返し、必要なリクエストの契約が一致することと、
元のモデル接続先に再アクセスしないことを検証します。版番号だけが変わっても動作が
保たれていれば通り、記録機能が欠けていれば失敗します。一時的な記録、設定、記憶データは終了後に削除します。
コマンドが`PATH`にない場合は、`AGENTICREPLAY_BIN`に実行ファイルのパスを指定できます。

認証情報や有料のモデル呼び出しは不要です。モデル通信と実際のKiokuko MCP境界を
検証するチェックであり、すべてのクライアント、streaming、TLS傍受、MCP shim、
ファイル復元、記憶への永続的な書き込みを保証するものではありません。
