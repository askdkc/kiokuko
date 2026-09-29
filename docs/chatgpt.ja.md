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
