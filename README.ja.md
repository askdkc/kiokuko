# Kiokuko（記憶庫）

[English](README.md) | 日本語 | [简体中文](README.zh-CN.md) | [한국어](README.ko.md)

**MCPでつなぎ、RAGで思い出し、作業後に記憶する。**

Kiokukoは、AIコーディングエージェント向けの外部記憶です。

過去の作業から得た知識をローカルのSQLiteへ保存し、次の依頼で関連する記憶だけを検索してAIへ渡します。

ユーザーが毎回プロンプトに過去の経緯を貼ったり、記憶を手作業で探したりする必要はありません。普段どおりAIを使うだけで、プロジェクト固有の知識が少しずつ蓄積され、次の作業へ再利用されます。

## すぐ使う

Node.js 26.1.0以上が必要です。
以下の2コマンドで楽々スタートです💕

```bash
npm install --global @askdkc/kiokuko
kiokuko setup
```

`setup`は、インストール済みの対応クライアントを検出し、SQLiteデータベースとMCP接続を自動設定します。
対話式setupでは、監査済みcommunity Skillも参考資料として利用するか確認します。既定は「いいえ」です。
Codex、Claude Code、OpenCodeの新規導入では、Enno-Oduno（役小角）Agent Loopも有効になります。既存の管理済み環境は`--enno-oduno on`を明示するまで変更せず、`--enno-oduno off`はEnno-Odunoが所有するhook/pluginだけを削除します。
setupは、bundled controller Skillの`kiokuko-enno-oduno`を、`kiokuko-single-purpose-functions`および`kiokuko-ui-design-soul`と一緒に、選択した対応clientへ配置します。
モデル向けの記憶は、capability gateを通るMCPツール `task_prepare` と
`task_answer` からだけタスクへ渡されます。`task_prepare`はEnno-Odunoの入口でもあり、役小角が呼出元ハーネスを特定し、Akinator intakeを所有した後、実行可能になった依頼だけを前鬼へ渡します。hookは記憶を暗黙取得せず、プランニングも迂回しません。canonical repository内で一意なpending active runだけをclient sessionへ結合して、前鬼、後鬼、または最終Reviewの継続をgateします。repository単位の「最新run」は選びません。

すべての`task_prepare`呼び出しは、クライアントモデルがその論理タスク用に
ローカルの`kiokuko-soul`全文を読んだ後で`soulRead: true`を渡す必要があります。
また、全taskで完全一致するローカル`kiokuko-soul` capabilityを要求し、欠落または
availability不明ならintake未完了でもfail-closeします。このbooleanは明示的な
クライアントattestationであり、モデルがSkillを理解・遵守したことのremote proofでは
ありません。

設定後、対象のAIクライアントを起動し、あとは普段どおり使うだけです。すでに起動している場合は、いったん終了してから起動し直してください。setupがCodexのStop hookを作成または更新した場合は、Codexで`/hooks`を開き、そのhookを明示的に信頼してください。

### Enno-Oduno（役小角）Agent Loop

`build`、`debug`、`review`、`devops`では、`task_prepare`がrun-bound loopを開始して`ennoOduno`を返します。強制される役割順序は次のとおりです。

```text
ユーザーの依頼
  -> task_prepare: 役小角がCodex、Claude Code、OpenCodeを特定
  -> currentRoleが役小角なら、requiredSkillsのkiokuko-enno-odunoを読み、適用
  -> 必要なら役小角がAkinatorの質問をユーザーへ返す
  -> 役小角が実行可能な構造化handoffをクライアント別の前鬼へ渡す
  -> 前鬼がrequiredSkillsのkiokuko-single-purpose-functionsを先に読み、計画へ適用
  -> code変更を一つの凝集した関数/ユースケース契約、一責務、一変更理由、focused test target単位へ分割
  -> 前鬼がWorkUnitごとにversion付きexpertRefsを1〜3個選び、未選択fragmentは既定で読まない
  -> 前鬼がWorkPlan、WorkUnit、expert refs、Skill snapshot、検証方法を提出
  -> 必要なら役小角がユーザー確認を得る
  -> 後鬼が承認済みWorkUnitだけをオーケストレーション
  -> 役小角がfreshなfinal verifier証拠をReview
       -> 成功: 役小角だけが受け入れて完了
       -> 失敗: 役小角がrevisionを上げ、Review結果を前鬼へ返す
  -> 前鬼の修正plan提出と必要な確認が終わるまで後鬼は再開不可
```

したがってintakeが未完了なら、返すのは役小角directiveと`answer_intake`であり、その`requiredSkills`には`kiokuko-enno-oduno`が含まれ、前鬼はまだ開始しません。最終Review時の役小角directiveも同じcontroller Skillを必須にします。準備完了後に返すrevision固定の前鬼directiveは、空のdraft Skill snapshotでもcompact indexである`kiokuko-single-purpose-functions`を`requiredSkills`へ含めます。前鬼はこのindexをWorkUnit選定前に使い、無意味な微小関数を作らず、code変更を凝集した関数またはユースケース契約とfocused test targetへ分割します。各code変更WorkUnitは理由付きの登録済み`expertRefs`を1〜3個選ぶ必要があり、UI WorkUnitは`code.*`と`ui.*`を少なくとも一つずつ要求します。`enno_plan_submit`は欠落、重複、未知、上限超過のmixtureを拒否し、その選択をrevisionとともに保存します。後鬼はSkillの全referenceではなく、そのfragmentだけを読みます。controller Skillはrole単位であり、WorkUnitのSkill snapshotには混ぜません。完全なプランの受理と必要な確認が成功するまで、後鬼には遷移できません。最終Review失敗時も古い後鬼WorkUnitを直接再開しません。却下したplanと検証証拠を旧revisionの履歴として保持し、`zenki_planning`へ戻して新しいplanを必須にします。応答の`orchestrationId`を全Enno MCP操作で使い、ホスト側session identityとは分離します。推論したscope、達成条件、Skill、expert選択、検証コマンドがある場合、実装前に通常のクライアントUIへ確認を返します。

3役は現在のクライアントモデルを順番に使います。Kiokukoが別モデルを呼ぶことはなく、OpenAI、Anthropic、OpenCodeのAPI keyもKiokuko側には不要です。Codex/Claude Codeは上限付きStop hook、OpenCodeは上限付き`session.idle` pluginを使います。OpenCodeでは子sessionのidleを無視し、同じ完了turnの重複配送を抑止します。`task_prepare`時にホストsessionが不明なら、最初の一致hookがpending active runが一件だけの場合に限って原子的に結合します。曖昧なら推測せず制御を返し、確定済みの結合は変更できません。Claude Codeではネイティブの8回連続block強制解除より前にKiokukoが制御をユーザーへ返します。adapter停止時は固定警告付きでfail-openします。外部Skillは引き続きuntrusted reference-onlyで、自動インストール・自動実行しません。

```bash
kiokuko setup --clients codex,opencode,claude --enno-oduno on
kiokuko enno run --role zenki --input-json -
```

実クライアントE2Eはrelease gateとは分離されています。対応する環境変数がない場合は`not-run`になります。

```bash
npm run test:e2e:codex
npm run test:e2e:opencode
npm run test:e2e:claude
npm run test:e2e:agents
```

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
