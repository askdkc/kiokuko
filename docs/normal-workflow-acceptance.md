# 通常依頼の受け入れテスト

この試験は、selectorの契約、隔離インストール、実AIの通常依頼を別々に判定する。
既存の `test:memory-assurance:live` は接続smokeのまま残す。
`probe.txt` や `true` の成功は通常依頼の受け入れに数えない。

## ローカルの決定的テスト（G0–G2）

```sh
npm run test:normal-workflow
npm run test:normal-workflow:gates -- --output /tmp/kiokuko-normal-gates
```

outputには**まだ存在しないか、空のディレクトリ**を指定する。既存の試行は上書きしない。
gatesは型検査、既定スイート、実際の `npm pack` と隔離global installを実行する。
型検査・スイート・インストールのログ、`G0.json`、`G1.json`、`G2.json`、
`candidate.json`、検証した `candidate.tgz` を保存する。
途中でソースが変われば合格にしない。dirty checkoutでのローカル検証は可能だが、
リリースにはcleanな候補commitが必要。

配布境界の試験はCodex、OpenCode、Claude、Hermesの実際の生成済みSkillの
frontmatterとMarkdown参照からselectorを取得し、そのままpackaged MCPに渡す。
harnessでaliasをcanonical名へ補正しない。初回と更新後、別repo、subdirectory、
checkout外を確認する。静的な接続試験は実AIによる文面理解の証明ではない。

selectorはmanifest内のbare名、`name/SKILL.md`、宣言済みreference、固定Codex alias、
任意の `skills/` prefix、`/` と `\` を受理する。
空segment、`.`、`..`、未知のalias、URL decodingは受理しない。
package自身のbundle内の絶対パスは維持する。インストール済みclientの絶対パスは別物。
manifest entryを外部または未登録ファイルへ向けるsymlinkも拒否する。
Windowsのsymlink負例は権限を仮定せず `NOT_RUN` を記録する。

## fixtureと独立oracle

ネットワーク不要の送料fixtureを使う。仕様は5,000円以上が無料、未満が500円。
バグfixtureは5,000円だけ誤り、既存の4,999円・5,001円のテストは通る。
会員追加fixtureは非会員の境界を正常にしてから別に開始する。
会員引数の契約はfixtureのREADMEに公開してあり、隠れたoracleだけでAPIを決めない。

oracleは以下を独立確認する。

- 問い合わせはfixtureを編集せず、仕様と実装の境界不一致を区別する。
- 開発は既存テスト・README・設定を保持し、新規テストと製品コードだけを変更する。
- 実装変更前のRed snapshotを再構築する。新規assertionが失敗し、要求された動作だけを
  実装した対照では通ることを確認する。構文エラー・依存不足はRedにしない。
- 最終treeで既存・新規テストを再実行する。テスト件数ゼロ、skip、todoは不合格。
- 0 / 4,999 / 5,000 / 5,001円、既存呼び出し、非会員・会員を固定期待値で検証する。
- no-op、Red欠落、古いGreen、テスト弱体化、stdoutでの成功偽装を不合格にする。

replayはAIの編集範囲外で実行する。Node permissionでreplay tree以外の読み書きと
子プロセスを許可しない。sourceがstdoutを偽装してもoracleの結果として採用しない。
送料モジュールは別のVMコンテキストで評価し、oracleへは有限の数値だけを返す。
hostの関数・オブジェクト、import、動的コード生成を渡さず、実装側からの
oracleの組み込み関数・署名・出力処理の置換を防ぐ。VMだけを安全境界とはせず、
permissionと別プロセスの時間上限も適用する。
自己テストのPASSはharnessの検出力の証拠であり、実モデルのPASSではない。

## 実モデル試験（G3）

```sh
node scripts/run-normal-workflow-acceptance.mjs --offline --output /tmp/kiokuko-normal-offline
node scripts/run-normal-workflow-acceptance.mjs --offline --require-live --output /tmp/kiokuko-normal-offline-gate
```

最初のコマンドはインフラ確認として終了コード0を返せるが、全シナリオは `NOT_RUN`。
`--require-live` は同じ未実行状態で終了コード1を返す。offlineをrelease passにしない。

実行前に、次の承認ファイルを具体化する。例の値は承認でも推奨model/versionでもない。
`authFile` は**専用テストアカウント**の認証ファイルを指定する。
本番の記憶、通常のHOME、client設定は読み込まない。専用認証は一時制御ディレクトリに
コピーし、証跡に含めず、終了時に削除する。

```json
{
  "approved": false,
  "testCredentials": true,
  "provider": "chatgpt-subscription",
  "model": "REPLACE_WITH_APPROVED_MODEL",
  "clientVersion": "0.0.0",
  "reasoningEffort": "medium",
  "clients": ["codex-cli"],
  "authFile": "/path/to/test-only/auth.json",
  "attempts": 1,
  "maxSeconds": 180,
  "maxTotalSeconds": 1440,
  "maxTurns": 10,
  "maxToolCalls": 60,
  "maxCost": 0,
  "currency": "USD"
}
```

```sh
node scripts/run-normal-workflow-acceptance.mjs --require-live \
  --approval /path/to/approved-test-run.json \
  --candidate /tmp/kiokuko-normal-gates/candidate.json \
  --artifact /tmp/kiokuko-normal-gates/candidate.tgz \
  --output /tmp/kiokuko-normal-live
```

CLIから有料APIのドル上限を強制する機構は未実装。したがってこのadapterは、
追加従量課金を許可しない専用subscription試験だけを明示的な承認下で扱う。
有料providerを指定しても `BLOCKED_AUTH` にし、支出controllerの代わりに自己申告を使わない。
金額0でも、モデル利用、外部送信、時間、アカウント利用の承認は必要。
自動再試行はしない。失敗を残したまま別の空outputで新しいattemptを作る。

シナリオは問い合わせ、境界バグ、会員追加、一度だけのselectorエラー、関連する
合成記憶、無関係な合成記憶、subdirectory、checkout外の会話。
最初のselector失敗だけを明示的に注入し、自然発生した失敗とは別に記録する。
関連記憶は互換性の判断・テスト・結果に結び付ける。呼び出し回数だけで合格にしない。

### 現在のadapterの制約

Codex CLI JSON streamだけでAGENTSのロードを推定しない。
試験専用CODEX_HOMEのclientセッション記録から、同じthread ID・cwd・client版の
初期user instructionに生成済みAGENTSの全文が入り、自然な依頼より前に記録された
ことをcollectorで照合する。公式の[ロード確認手順](https://developers.openai.com/codex/guides/agents-md)と
[instructionの形式](https://developers.openai.com/cookbook/examples/gpt-5/codex_prompting_guide)を参照する。
raw rolloutは証跡へコピーせず、内容hash・記録位置・thread IDだけを保存し、
元の試験セッションは隔離制御ディレクトリごと削除する。
記録の欠落、未知の形式、別thread、内容の欠落、後からの引用、重複receiptは
`FAIL_HARNESS`（指示ロード未確認）。生成ファイルの存在やモデルの自己申告では合格にしない。
collectorは合成client記録で自己検証しており、承認済み実clientでのG3確認は別途必要。

AIのshell書き込みはfixture内に限定し、workspace-writeの `/tmp` / `$TMPDIR` 例外と
追加writable rootsを無効にする。保護された制御ディレクトリ・oracle・セッション記録を
編集して合格を偽装させない。これらのsandbox設定を使えないclientは対象外として扱う。

desktop adapterも未実装で、`codex-desktop` は `NOT_RUN`。
desktopを対象から外すなら、承認ファイルの対象clientとして明示する。
desktopを対象に含めたままCLIの成功で代用しない。

JSONイベントのtool完了時にfixtureをsnapshotする。複合コマンドの中でテスト追加・Red・
実装修正・Greenを一気に済ませた場合は、保護されたRed snapshotが取れないため合格にしない。
未知のevent形状や、独立に確認できないshell wrapperも実行証拠にしない。
ログ欠損や途中停止をモデルの動作不良と断定せず、保存した証跡で原因を判別する。
問い合わせの意味判定は固定事実に対する保守的な条件であり、表現が曖昧なら要レビュー。
有限のfixtureで全タスク・全model・全clientを保証する試験ではない。

## リリース照合（G4）

`candidate.json` に、承認済みの `clients`、全必須シナリオの `required`、
live summaryの `configurationHash` を加え、次を実行する。

```sh
node scripts/verify-normal-workflow-release.mjs \
  --candidate /path/to/release-candidate.json \
  --deterministic /tmp/kiokuko-normal-gates/G0.json \
  --deterministic /tmp/kiokuko-normal-gates/G1.json \
  --deterministic /tmp/kiokuko-normal-gates/G2.json \
  --live /tmp/kiokuko-normal-live/summary.json
```

G0–G3のcommitとtarball hash、必須シナリオ、model/client/実行上限の設定が一致し、
候補がcleanで、全必須結果がPASSのときだけ `releaseReady: true` と終了コード0を返す。
失敗した同一候補のattemptを後の成功で消さない。必須scenarioの削除、未実行、skip、
replay、環境・認証不足、artifact不一致、証跡欠落は不合格。
通常のPR CIはG0–G2を確認する。manual workflowは保護された
`normal-workflow-acceptance` environmentで承認済みの試験を実行するが、
repository内にworkflowを追加しただけでは実行・secret・有効なreceiptの存在は証明しない。

保存するのは、候補tarballとhash、入力fixture、生成済み指示、capability/response、
ツールイベント、hookの判定metadata、snapshot、回答、oracle、試行別summary。
private reasoningと認証ファイルは保存しない。実モデル・desktop・正式公開・
稼働中clientへの適用は、ローカルソース検証から分けて報告する。
