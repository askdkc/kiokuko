# Kiokuko（記憶庫）

[English](README.md) | 日本語 | [简体中文](README.zh-CN.md) | [한국어](README.ko.md)

**MCPでつなぎ、RAGで思い出し、作業後に記憶する。**

Kiokukoは、AIコーディングエージェント向けの外部記憶です。

過去の作業から得た知識をローカルのSQLiteへ保存し、次の依頼で関連する記憶だけを検索してAIへ渡します。

ユーザーが毎回プロンプトに過去の経緯を貼ったり、記憶を手作業で探したりする必要はありません。普段どおりAIを使うだけで、プロジェクト固有の知識が少しずつ蓄積され、次の作業へ再利用されます。

## すぐ使う

Node.js 24.16.0以上が必要です。Node.js 26.1.0以上もサポートしています。
以下の2コマンドで楽々スタートです💕

```bash
npm install --global @askdkc/kiokuko
kiokuko setup
```

`setup`は、インストール済みの対応クライアントを検出し、SQLiteデータベースとMCP接続を自動設定します。
対話式setupでは、監査済みcommunity Skillも参考資料として利用するか確認します。既定は「いいえ」です。

設定後、対象のAIクライアントを起動し、あとは普段どおり使うだけです。すでに起動している場合は、いったん終了してから起動し直してください。setupがCodexのStop hookを作成または更新した場合は、Codexで`/hooks`を開き、そのhookを明示的に信頼してください。

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

### セットアップ後に起こるAIエージェントの挙動

#### AI Akinator

AIエージェントに渡された依頼が漠然としていてAIに具体性が見えない時は、Akinatorが内部的な質問を行い、AIにとって必要な具体性に依頼を固めて行きます。この際に推奨される言語やフレームワークなどのSkillがあれば取得して利用可能にします。

#### 役小角 (Enno-oduno)

AIエージェントへの依頼を処理するLoop処理：役小角 が有効になります。

依頼内容の理想系を決め、プランニングを行い、実装を小エージェントにオーケストレーションで処理させ、最後に理想に合致するかを自動でチェックしてくれます。

#### 記憶の格納

モデル向けの記憶は、capability gateを通るMCPツール `task_prepare` と
`task_answer` からだけタスクへ渡されます。`task_prepare`は役小角の入口です。タスクを処理した後に内容が記録され、必要に応じてAIが使う知識へと昇華可能かを検討します。実用に耐える知識が昇格されるように自動調整されています。

### Enno-Oduno（役小角）Agent Loop 詳細

`build`、`debug`、`review`、`devops`では、`task_prepare`がrun-bound loopを開始して`ennoOduno`を返します。強制される役割順序は次のとおりです。

```text
ユーザーの依頼
  -> task_prepare: 役小角がCodex、Claude Code、OpenCodeを特定
  -> currentRoleが役小角なら、requiredSkillsのkiokuko-enno-odunoを読み、適用
  -> 必要なら役小角がAkinatorの質問をユーザーへ返す
  -> 小角の理想像がtask_prepare handoffとAkinatorが発見した全Skillから最適な到達点を導出
  -> enno_ideal_submitが理想像を保存し、その後にだけクライアント別の前鬼へ渡す
  -> 前鬼がrequiredSkillsのkiokuko-single-purpose-functionsを先に読み、計画へ適用
  -> code変更を一つの凝集した関数/ユースケース契約、一責務、一変更理由、focused test target単位へ分割
  -> 前鬼がWorkUnitごとにversion付きexpertRefsを1〜3個選び、未選択fragmentは既定で読まない
  -> 前鬼がWorkPlan、WorkUnit、expert refs、Skill snapshot、検証方法を提出
  -> 必要なら役小角がユーザー確認を得る
   -> 後鬼が承認済みWorkUnitだけをオーケストレーション
   -> enno_verify_prepareがfinal verifierを実行し、freshな証拠を保存
   -> 証拠の準備後にだけ、親ホストがfinal-review Advisorをfan-out
   -> enno_finishが保存済み証拠からaccept/replan/blockを決定
        -> 成功: 役小角が受け入れ、読み取り専用の小角の瞑想へ移行
            -> 変更済み・承認済みpathから、根拠のある古いtestまたは関数を探索
            -> enno_meditation_submitが削除せずに候補を保存し、その後runを完了
       -> 失敗: 役小角がrevisionを上げ、Review結果を前鬼へ返す
   -> 前鬼の修正plan提出と必要な確認が終わるまで後鬼は再開不可
```

Final Reviewは意図的に二段階です。`enno_verify_prepare`はdatabase
transactionの外側でshellを無効にし、repository内に限定したcwdで承認済み
verifierを実行し、現在のcontract revisionとmutation revisionに結び付いた
freshな証拠を保存します。`enno_finish`はsubprocessを起動せず、保存済みの
freshでpassingな証拠だけを受け入れます。testがpassingしただけではrunを
受け入れません。
Enno continuationを有効にした場合、CodexとClaude Codeは上限付きStop hook、
OpenCodeは上限付き`session.idle` pluginを使います。Hermesはnative stdio MCPと
bundled Skillだけを使い、Enno continuation adapterは導入しません。

したがってintakeが未完了なら、返すのは役小角directiveと`answer_intake`であり、その`requiredSkills`には`kiokuko-enno-oduno`が含まれ、前鬼はまだ開始しません。準備完了したintakeは、まず`oduno_ideal`と`submit_ideal`を返します。`enno_ideal_submit`では、Akinatorが選択したdiscovery setの全Skillについて貢献を正確に一件ずつ指定する必要があり、外部Skillは引き続きuntrusted reference-onlyの指針として扱います。その後にだけ、runはrevision固定の前鬼directiveを返します。このdirectiveは、空のdraft Skill snapshotでもcompact indexである`kiokuko-single-purpose-functions`を`requiredSkills`へ含めます。前鬼はこのindexをWorkUnit選定前に使い、無意味な微小関数を作らず、code変更を凝集した関数またはユースケース契約とfocused test targetへ分割します。各code変更WorkUnitは理由付きの登録済み`expertRefs`を1〜3個選ぶ必要があり、UI WorkUnitは`code.*`と`ui.*`を少なくとも一つずつ要求します。`enno_plan_submit`は欠落、重複、未知、上限超過のmixtureを拒否し、その選択をrevisionとともに保存します。後鬼はSkillの全referenceではなく、そのfragmentだけを読みます。controller Skillはrole単位であり、WorkUnitのSkill snapshotには混ぜません。完全なプランの受理と必要な確認が成功するまで、後鬼には遷移できません。最終Review失敗時も古い後鬼WorkUnitを直接再開しません。却下したplanと検証証拠を旧revisionの履歴として保持し、`zenki_planning`へ戻して新しいplanを必須にします。Reviewを受け入れると、直接完了せず`oduno_meditation`へ移行します。`enno_meditation_submit`はrepositoryを変更せず、検査したrepository-relative pathと根拠付きの古いtestまたは関数の候補を保存してからrunを完了します。応答の`orchestrationId`を全Enno MCP操作で使い、ホスト側session identityとは分離します。推論したscope、達成条件、Skill、expert選択、検証コマンドがある場合、実装前に通常のクライアントUIへ確認を返します。`needs_confirmation`応答には、確定済み契約の決定的な表示projectionである`ennoOduno.directive.userFacingConfirmation`が含まれます。scope、除外、達成条件、表示番号付き依存を持つ作業項目、reference-only状態を含むSkill、選定理由付きの専門観点、focused/final checks、試行上限が、それぞれprovenance basis（ユーザー指定・リポジトリ検証済み・提案）付きで一度ずつ現れます。クライアントモデルはraw directive JSONや内部識別子を出さずに全項目をユーザーの言語で提示し、明示的なapprove・revise・cancelを待ちます。secretを示す表示値や64 KiBを超えるprojectionは、redactionや切り詰めではなくplan submitの拒否になります。

### 計画開始時に環境情報が不足・変化した場合

ここでいう「環境情報」は、現在のAIクライアントで利用できるSkillとMCPツールの一覧です。ホストが自動収集する内部情報であり、ユーザーが一覧の保存場所を探したり、設定データを手作業で作成したりする必要はありません。

この一覧が何らかの理由で計画へ引き継がれていない、またはタスク準備時から変わっている場合、Kiokukoは安全確認を完了できないため作業を開始しません。関連するSkillの探索、3件の助言結果の計画への反映、重複実行を防ぐ受付記録の作成、計画版の更新より前に停止するため、この計画開始による新しい作業や追加のコード変更はありません。そのうえで、状況に応じて次の選択肢を表示し、ユーザーの明示回答を待ちます。

各選択肢は、ラベルと推奨表示、どのような意図に適するか、選択後に何が起きるか、の順で表示されます。

環境情報が引き継がれていないだけで、現在の実行をそのまま継続できる場合：

- **同じ計画で続ける（推奨）**：計画内容は正しく、現在の環境情報を付け直すだけでよい場合に選びます。ホストが環境情報を自動で付け直し、現在の実行をそのまま続けます。
- **計画を見直す**：作業範囲、作業項目、確認方法を変更してから続けたい場合に選びます。クライアントが変更内容を質問し、回答があるまで実装を開始しません。
- **中止する**：この作業を続けない場合に選びます。現在の実行を取り消し、代わりの実行は作りません。

利用できるSkillやMCPツールがタスク準備後に変わった場合：

- **現在の環境で同じ計画をやり直す（推奨）**：計画内容は正しく、利用できる機能だけが変わった場合に選びます。現在の実行を先に取り消し、現在の環境と同じ確定済み計画で新しい実行を開始します。
- **計画を見直してからやり直す**：機能の増減に合わせて作業範囲、作業項目、確認方法も変更したい場合に選びます。クライアントが変更内容を質問し、回答後に現在の実行を取り消して、現在の環境と修正済み計画で新しい実行を開始します。
- **中止する**：この作業を続けない場合に選びます。現在の実行を取り消し、代わりの実行は作りません。

旧動作によって今回の実行がすでに終了している場合：

- **同じ計画で新しくやり直す（推奨）**：終了済み実行の計画内容は正しく、そのまま再利用したい場合に選びます。終了済み実行は変更せず、現在の環境と同じ確定済み計画で新しい実行を開始します。
- **計画を見直してからやり直す**：代わりの実行を作る前に、作業範囲、作業項目、確認方法を変更したい場合に選びます。クライアントが変更内容を質問し、終了済み実行は変更せず、回答後に現在の環境と修正済み計画で新しい実行を開始します。
- **中止する**：この作業を再開しない場合に選びます。終了済み実行は終了したままとし、新しい実行は作りません。

クライアントは説明をユーザーの言語で表示し、機械用の選択値、内部の理由コード、処理名、機能一覧、識別子、計画版、表示形式の版番号、生のJSONは表示しません。どの状況でも、ユーザーが選択する前に再提出、取消、新しい実行の作成を自動で行いません。

3役は現在のクライアントモデルを順番に使います。Kiokukoが別モデルを呼ぶことはなく、OpenAI、Anthropic、OpenCodeのAPI keyもKiokuko側には不要です。Codex/Claude Codeは上限付きStop hook、OpenCodeは上限付き`session.idle` pluginを使います。OpenCodeでは子sessionのidleを無視し、同じ完了turnの重複配送を抑止します。同じOSユーザーでcanonical repositoryへアクセスできるlocal processは、そのrunを再開できるものとして信頼します。PID、process ancestry、実行ファイル、code signing、継承tokenによる証明は追加しません。adapterはsessionの完全一致routeを優先し、一致がなければCodex、Claude Code、OpenCodeをまたいでcanonical repository内の一意なactive runを原子的に再ルーティングし、以前のclient versionを消去します。複数候補なら全runを変更せず制御を返します。公開応答の`clientBinding`は現在のrouteを表し、`bound`は所有者を意味しません。sessionごとのcontinuation上限到達はそのsessionの自動継続だけを止め、runとledgerは別のlocal project clientが再開できるactive状態を維持します。Claude Codeではネイティブの8回連続block強制解除より前にKiokukoが制御をユーザーへ返します。Hermesに自動continuation hookはありませんが、同じrun identityを使うMCP操作は継続できます。adapter停止時は固定警告付きでfail-openします。外部Skillは引き続きuntrusted reference-onlyで、自動インストール・自動実行しません。

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

## MoA Advisory Round

理想像・計画・最終Reviewでは、親ホストが固定3スロットの隔離されたread-only Advisorをfan-outできます。Advisorを起動するのはKiokukoではなく親ホストであり、promptだけでは隔離の証明になりません。隔離を検証できないslotは`unavailable`として報告し、親Aggregatorだけがidentityを含まない構造化結果を`enno_advice_submit`へ送ります。結果は`host_reported`として記録し、provider/model identityやraw subagent出力は保存しません。各Roundはphase、revision、mutation revision、policy、slot定義、context digestに固定されます。

## 注意

Kiokukoはプロンプトを横取りする仕組みではありません。自動利用は各AIクライアントとモデルのMCP呼び出しに依存するため、すべてのターンで必ず呼び出される保証はありません。

詳細なコマンドは次から確認できます。

```bash
kiokuko --help
kiokuko setup --help
```
