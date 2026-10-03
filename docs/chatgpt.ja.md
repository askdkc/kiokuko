# ChatGPT接続の補足

[最短手順はREADME](../README.ja.md#chatgptで使うプレビュー) | [English](chatgpt.md)

## 対応版を入れる

`kiokuko mcp --help`に`--profile`と`--access`があれば、そのまま使える。
ソースから導入する場合は、Kiokukoのリポジトリ直下で次を実行する。

```bash
npm ci
npm run build
npm install --global .
kiokuko mcp --help
```

DBが未作成の場合だけ`kiokuko init`を実行する。ChatGPT用に`kiokuko setup`は不要。

## 困ったとき

| 症状 | 対処 |
|---|---|
| `tunnel-client: command not found` | macOSでは`brew install openai/tools/tunnel-client`で導入し、`tunnel-client --version`で確認する。導入済みなら`command -v tunnel-client`でPATHを確認する。 |
| Tunnelを作れない・ChatGPTで選べない | [公式手順](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)で権限と対象ChatGPT workspaceへの関連付けを確認する。 |
| 接続できない | 下のdoctorを実行する。`kiokuko`が見つからなければ、Tunnel設定の起動コマンドを`command -v kiokuko`で確認したパスに直す。 |
| DBがない・互換性がない | 未作成なら`kiokuko init`。互換性エラーならDBを保全し、そのDBに対応するKiokuko版で扱う。 |
| 保存できない | 起動引数が`--access read-write`か、`KIOKUKO_INTERACTION_MEMORY=off`を設定していないか確認する。 |
| 設定変更が反映されない | Tunnelを再起動し、ChatGPTのPluginsで接続をRefreshして、新しい会話を始める。 |

```bash
tunnel-client doctor --profile kiokuko-chatgpt --explain
```

## 利用範囲と停止

- Global記憶の保存・検索・訂正に対応。Project記憶は公開しない。
- 接続はDB所有者本人だけで使う。取得した記憶はChatGPTに送られる。
- PCとTunnelの起動中だけ使える。毎回の自動保存・検索は保証しない。ChatGPT標準メモリの保存先は変更しない。
- 止めるときはTunnelの端末でCtrl+C。登録も解除するならChatGPTのPluginsから接続を削除する。DBは残る。

**ChatGPT実機での接続・書き込み承認は未検証。** [検証状況](chatgpt-validation.md)

## 接続の監視

```bash
kiokuko chatgpt run --profile kiokuko-chatgpt
kiokuko chatgpt status --profile kiokuko-chatgpt --json
```

既存の直接起動を停止してから実行する。既存プロファイルと環境変数を使い、API キーやアクセス権限は変更しない。`--profile-dir` と `--tunnel-client` で場所を指定できる。

最初の失敗から状態は `degraded`。一時的な通信障害は3回目から警告し、継続中は最大60秒に1回に集約する。認証・証明書・HTTPエラーは直ちに通知する。成功したpollで復旧を確認し、生存確認や古いmetricsだけで正常とは判定しない。取得不能・古い診断は `unknown`。自動再起動はしない。Ctrl+Cで子プロセスも停止する。

集約はこのコマンドの出力だけに適用する。上流の管理画面と直接起動のログは変わらない。DNS/TLSの段階や接続再利用など、上流が公開しない情報は不明。poll成功とChatGPT経由のMCP呼び出し成功は別々に確認する。
