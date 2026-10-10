# AgenticReplayでKiokukoのセッションを記録する

Kiokukoに接続したクライアントのモデルAPI通信は
[AgenticReplay](https://github.com/askdkc/AgenticReplay)で記録できます。
任意で使う外部ツールです。Kiokukoからインストールしたり、記録のために
クライアント設定を変更したりはしません。互換性チェックの対象は`agenticreplay@0.1.2`です。

## コマンドを確認する

インストール済みなら、そのコマンドを使ってください。

```bash
agenticreplay --version
agenticreplay doctor
```

未導入のマシンでは、次のコマンドでインストールします。

```bash
npm install --global agenticreplay@0.1.2
```

## クライアントを記録する

先に`kiokuko setup`でクライアントのMCP接続を設定し、必要なら再起動します。
作業対象のプロジェクトで、モデルへリクエストを送る**ホストクライアント**を
レコーダーから起動してください。`kiokuko mcp`だけを包んでも、ホスト側の
モデル通信は記録できません。

Claude Codeの場合：

```bash
agenticreplay record claude -- -p "Use Kiokuko to recall relevant context for this project."
agenticreplay show last
agenticreplay replay last --worktree
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

## 記録を確認して再生する

記録は対象プロジェクトの`.agenticreplay/runs/`に保存されます。
シリアライズされたリクエストから、ホストが実際にモデルへ送ったKiokukoの
ツールスキーマと結果を確認できます。プロバイダー内部の非公開の推論や、
記録境界より前の変更は観測できません。

```bash
agenticreplay list
agenticreplay show last --json
agenticreplay replay last --worktree --json
```

exact replayでは、記録済みのモデル応答を返します。作業用worktreeでプロジェクトの
ファイルは保護できますが、**Kiokukoのデータベースは巻き戻りません**。
ツールが再実行され、記憶を書き込む場合があります。書き込み操作のテストでは、
使い捨てのKiokukoデータディレクトリとクライアント設定を使ってください。
通信本文とファイルのスナップショットは機密情報として扱い、共有前に確認します。
Kiokukoの記憶は、Git管理下のファイルでなくてもモデルへのリクエストに含まれます。

## リポジトリの互換性チェック

Node.jsとAgenticReplay 0.1.2が使える環境で実行します。

```bash
npm ci
npm run test:agenticreplay
```

Kiokukoをビルドし、テスト用のNodeホストから実際のMCPサーバーを起動して、
ローカルのモデルfixtureへの2件のリクエストを記録します。
記録された`task_inspect`のスキーマとSOULの結果を確認した後、モデルの接続先を停止し、
オフライン再生で2件がcanonical exact一致し、divergences、unmatched、liveCallsがすべて0になることを
検証します。一時的な記録、設定、記憶データは終了後に削除します。
コマンドが`PATH`にない場合は、`AGENTICREPLAY_BIN`に実行ファイルのパスを指定できます。

認証情報や有料のモデル呼び出しは不要です。モデル通信と実際のKiokuko MCP境界を
検証するチェックであり、すべてのクライアント、streaming、TLS傍受、MCP shim、
ファイル復元、記憶への永続的な書き込みを保証するものではありません。
