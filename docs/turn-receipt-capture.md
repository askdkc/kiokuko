# TurnReceiptによる記憶候補と保存確認

2026-11-12。実装対象の基点: `d82058307e659d073251b531d67c69ba27b2f4c0`。

## 対応範囲

通常ChatGPTの自動記録・完了通知は**未対応**。AgenticReplay側に正式なChatGPT
adapterとイベント形式がなく、今回確認したアプリの公開ツールにも、完全な記録と
会話・ターン・分岐・実行主体を保証する完了購読の入口はなかった。
`read_thread`の要約取得を完全なtranscriptや完了通知に置き換えない。
実ChatGPT E2Eは未実施。モデル名では対応可否を判定しない。

| 経路 | 現在の動作 |
| --- | --- |
| 既存Codex | host transcriptの完了検証、対象ターンのAPI記録検証を引き続き必須とする。 |
| 共通TurnReceipt | 私有Unix socketのread-only `action: receipt`を、Codexのsealed記録取得後に試す。対応しない旧ARは従来検証を使用する。 |
| ChatGPT receipt | 共通スキーマ・identity・録画整合性を検証する独立入口を設置。ChatGPT形式を推測せず、`chatgpt_adapter_unsupported`で候補化を拒否する。 |
| Codex確認UI | 次ターンhookの案内から`memory_review_pending`を呼ぶfallback。MCP form elicitationでSave/Declineを確認する。完了直後の自動UIではない。 |
| ChatGPT確認 | `memory_review_pending`は未対応理由のみ返す。既存`memory_capture`が明示的な代替。read-write接続とform elicitationが必要。 |

## 契約と信頼境界

参照したAgenticReplayの契約は`packages/schema/schema/turn-receipt.schema.json`、
`schemaVersion: 1`。参照先HEADは`444f7d7c4780e382081b455aa3040104f5d89204`、
スキーマSHA-256は`3a4d0c886d10c23db8327c00bf8288ffa61be359c9e9c90c211132472af1dcc8`。
これは実在する契約への整合であり、未実装ChatGPT adapterとの接続合意や検証完了を意味しない。

インストール済みAR 0.1.19には共通schema exportがなかったため、Kiokukoに厳密な
検証器を実装した。バージョン番号で機能を推定せず、実応答を検証する。
参照先の実際のvalidatorおよび`matchesUserTurn`との270通りの比較が一致した。

- `source/sessionId/turnId/branchId`は、モデルの申告ではなく独立したhost bindingと照合する。
- 共通経路は`scope=user`、`identityComplete=true`、`outcome=completed`、
  `capture=complete`を要求する。背景処理・子agent・不明・中断・失敗を昇格させない。
- 現在のCodex AR receiptは`scope=unknown`、分岐なし、identity不完全。
  それ自体では候補の証拠にしない。既存Codex transcript経路だけは独立に検証して継続する。
  明示的なbackground/subagent receiptやID矛盾が返った場合は候補を作らない。
- socketと親directoryの所有者・mode・canonical pathを確認する。受信量と待機時間を制限する。
- 録画は同じrepositoryの`.agenticreplay/runs`配下に限定し、manifestのrun/root/
  完全性とeventsのSHA-256を照合する。Codex抽出時にも同じevents digestを要求する。
- SHA-256は整合性であり、署名や同一OSユーザーによる改変への耐性ではない。
  任意JSONやモデルtool引数を受け取るreceipt登録APIは公開しない。
- receipt IDと本文digestを永続化する。同一IDの本文変更は`receipt_conflict`。
  再受信は候補承認にも保存承認にもならない。

## 状態と再試行

migration 018でreceipt履歴、提示lease、提示履歴を追加する。
完了予約、receipt受信、記録検証、候補、UI提示、保存は別の状態。
候補生成は`entries`への記憶保存ではない。

確認は候補・revision・digest・workspace・sessionに結び付く。
Saveだけが既存のtransactional storeへ書き込み、同じ承認keyの再送は二重保存しない。
Declineは終端、Cancel・UI障害・非対応は保存0件。

複数プロセスで同じ候補を同時提示しないよう、DB leaseを使用する。
待機は最大120秒、leaseは125秒。応答が遅れて届いても、中断・期限切れ・所有権喪失後の
Saveは無効。終了済み保存への再試行ではUIを開かない。

提示履歴をUI呼び出し**前**にtransactionで記録する。同じhost requestの再送・再起動で
フォームを再送しない。提示を試みた候補は次ターンの自動案内対象から除く。
Cancelや応答不明の候補はpendingとして診断に残り、別のhost requestまたは利用者の
手動CLI操作で明示的に再確認できる。hostの表示ackがないため、クラッシュの境界では
「履歴はあるが画面には届かなかった」可能性が残る。表示成功を保証しない。

AR取得は既存の背景worker内。DB・AR・UI障害は記憶候補だけを失敗させ、
通常の会話・編集の権限や完了結果を変更しない。既存のmemory準備ルール自体は変更しない。

## 診断

```sh
kiokuko memory-review --status --cwd /absolute/repository --database /absolute/kiokuko.sqlite3
# 特定の会話だけ表示
kiokuko memory-review --status --cwd /absolute/repository --database /absolute/kiokuko.sqlite3 --session SESSION_ID
```

`--status`はTTY不要、read-only。本文・認証情報を表示せず最新20件の状態を返す。
未提示pendingは次ターンfallbackの対象。提示済みpendingの明示的な手動確認は
`kiokuko memory-review --pending`。CLIのTTYは認証された人間の証拠ではなく、
モデルがPTYを作って承認してはならない。

| 診断 | 意味 |
| --- | --- |
| `hook_not_observed` | 指定範囲に完了予約がない。hook故障と断定はしない。 |
| `desktop_transcript_unavailable` / `desktop_turn_completion_timeout` | Codex完了証拠がない／待機期限切れ。 |
| `replay_source_unavailable` / `receipt_recording_unavailable` | 記録取得不可。 |
| `receipt_identity_mismatch` / `replay_desktop_turn_mismatch` | source・会話・ターン等の不一致。 |
| `receipt_user_scope_unproven` | 共通receiptでは利用者の対象ターンと証明できない。 |
| `no_candidates` | 検証した記録に候補なし。 |
| `ui_unsupported` | form elicitation非対応。保存しない。 |
| `review_in_progress` / `review_already_presented` | 確認中／同じhost requestには提示済み。 |
| `chatgpt_adapter_unsupported` | 通常ChatGPTの自動抽出は未対応。 |

## 検証と残る条件

- 最終コードで`npm run typecheck`、`npm run build`、`git diff --check`が成功。
  下記136件は135件成功、1件skip。全リポジトリsuiteは実施していない。
- 反例: 別source/会話/ターン/分岐、background/subagent、偽の完了種別、
  不完全記録、digest不一致、録画欠落、path逸脱、receipt本文変更を拒否。
- 同一候補の並行提示、DB再接続後の提示重複、Cancel後の遅延Save、UI例外、
  DB利用不能、診断CLI、Save後の二重保存を検査。
- disposable copyでuser-scope検査を除くとbackground receiptが通ることを確認。
  元の検査は変更していない。
- Unix socketのlistenがsandboxで`EPERM`。新規socket試験1件はskip、既存の
  desktop replay実socket試験6件は同じ理由で失敗。実通信を成功とは報告しない。
- 実Codex/ChatGPT hostの完了から保存までのE2Eは未実施。稼働サービスの更新・再起動、
  利用中DBへのmigration、commit/pushは実行していない。
- ChatGPTの残件: 正式なhost通知と完全なrecord adapter、形式の明示変換、
  hostからの独立identity binding、実hostでの確認UIとSave/Decline/Cancel E2E。
  今回の共通契約検査を通るsynthetic receiptは、その代わりにならない。

再実行コマンド:

```sh
npm run typecheck
npm run build
node scripts/run-tests.mjs \
  tests/integration/turn-receipt.test.ts \
  tests/integration/capture-consideration.test.ts \
  tests/integration/chatgpt-capture.test.ts \
  tests/integration/chatgpt-mcp.test.ts \
  tests/integration/replay-codex-wire.test.ts \
  tests/integration/replay-review.test.ts \
  tests/integration/memory-capture-consent.test.ts \
  tests/integration/migrations.test.ts \
  tests/unit/migration-failclose.test.ts \
  tests/integration/codex-hook-upgrade.test.ts \
  tests/integration/replay-request-context.test.ts \
  tests/integration/replay-write-boundary.test.ts \
  tests/unit/memory-capture-review.test.ts \
  tests/unit/chatgpt-contract.test.ts \
  tests/integration/relation-chatgpt-output.test.ts
# この環境ではlisten EPERMになった別の試験
node scripts/run-tests.mjs tests/integration/codex-desktop-replay.test.ts
```

build後の主要artifact SHA-256（稼働中サービスの同一性は未検証）:

- `dist/memory/capture-consideration.js`: `0f0bce9777c87234e4490307109ef5550214ea5adbcd73dbb84befe71d286c80`
- `dist/memory/capture-pending-review.js`: `fb4fff027e80e2c2bd3d03699c3453c9374068775e33a28659ce56be8887862f`
- `dist/agenticreplay/turn-receipt.js`: `da652370e38c743113e82fd46bf893082998969ec7ea1b4982a69ee13e1661d4`
