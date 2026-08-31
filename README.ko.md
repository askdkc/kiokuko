# Kiokuko(기억 저장소)

[English](README.md) | [日本語](README.ja.md) | [简体中文](README.zh-CN.md) | 한국어

**MCP로 연결하고, RAG로 떠올리고, 작업 후에 기억합니다.**

Kiokuko는 AI 코딩 에이전트를 위한 외부 메모리입니다.

이전 작업에서 얻은 지식을 로컬 SQLite에 저장하고, 다음 요청에서 관련된 메모리만 검색해 AI에 전달합니다.

사용자는 매번 프롬프트에 과거의 경위를 붙여넣거나 메모리를 직접 찾을 필요가 없습니다. 평소처럼 AI를 사용하기만 하면 프로젝트 고유의 지식이 조금씩 쌓이고 다음 작업에 재사용됩니다.

## 바로 시작하기

Node.js 24.16.0 이상이 필요하며, Node.js 26.1.0 이상도 지원합니다.
다음 두 명령어로 쉽게 시작할 수 있습니다 💕

```bash
npm install --global @askdkc/kiokuko
kiokuko setup
```

`setup`은 설치된 지원 클라이언트를 감지하고 SQLite 데이터베이스와 MCP 연결을 자동으로 설정합니다.
또한 번들된 `memory-reasoning` Skill과 다른 Kiokuko 표준 Skill을 설치합니다. 기존 환경에는 다음 `kiokuko setup` 실행 시 추가되며, 같은 이름의 비-managed 파일은 덮어쓰지 않습니다.
표준 `kiokuko-soul` router는 범위가 명확하고 위험이 낮은 code 변경과 명시적인 minimal/YAGNI 요청에 `kiokuko-simple-work`를 적용하며, 일반 code 계약·보안·접근성·오류 처리·검증 요구 사항은 생략하지 않습니다.
대화형 setup은 감사된 community Skill도 참고 자료로 사용할지 묻고, 기본 응답은 아니요입니다.

Codex용 setup은 다음과 같은 정확한 managed MCP 핵심 설정을 생성합니다(Skill discovery용 environment 행이 뒤에 이어집니다).

```toml
[mcp_servers.kiokuko]
command = "kiokuko"
args = ["mcp"]
enabled = true
required = true
```

`required = true`이므로 Kiokuko를 초기화할 수 없으면 필수 SOUL과 policy 없이 계속하지 않고 Codex startup 또는 resume이 실패합니다. `kiokuko setup`을 다시 실행하면 `required`만 없는 정확한 이전 managed block을 업그레이드합니다. 값, 순서, 중복 key 또는 추가 field가 변경된 block은 덮어쓰지 않고 conflict를 보고합니다. 명시적으로 `required = false`로 바꾸면 해당 block은 user-managed가 되어 이후 setup에서 덮어쓰지 않습니다. Kiokuko는 Codex 전체의 optional MCP grace나 startup timeout을 변경하지 않습니다.

설정 후 대상 AI 클라이언트를 실행하고 평소처럼 사용하면 됩니다. 이미 실행 중이라면 한 번 종료한 후 다시 시작하십시오. setup이 Codex Stop hook을 생성하거나 업데이트했다면 Codex에서 `/hooks`를 열고 해당 hook을 명시적으로 신뢰하십시오.

### 선택적 시맨틱 검색

기본값은 어휘 검색입니다. 고정된 다국어 로컬 모델은 명시적인 setup 명령으로만 설치합니다.

```bash
kiokuko embeddings setup
```

자동화에서는 `--preset local-small --yes --json`을 사용하십시오. setup은 고정 revision의
모든 파일을 검증한 뒤 로드하고 SQLite에 설정을 저장한 다음 offline으로 vector를 생성합니다.
`--dry-run`은 다운로드와 변경을 하지 않고, `--offline`은 검증된 설치를 요구하며,
`--replace`는 다른 profile 교체를 허용합니다. 상태는 `kiokuko embeddings status --json`과
`kiokuko doctor --json`으로 확인하고 손상 시 `kiokuko embeddings repair`를 사용하십시오.
Embedding 설정은 환경 변수를 읽지 않으며 모델 weight는 npm package에 포함되지 않습니다.

## 사용할수록 똑똑해지는 구조

```text
사용자 요청
      ↓
관련 과거 메모리 검색
      ↓
AI가 메모리를 참고해 작업
      ↓
재사용 가능한 결과나 교훈 저장
      ↓
다음 요청에서 다시 검색
```

Kiokuko는 다음 흐름을 반복합니다.

1. 작업 전에 현재 프로젝트와 Global 메모리를 검색합니다
2. 관련성이 높은 메모리만 AI에 전달합니다
3. AI가 작업을 수행합니다
4. 작업 후 재사용할 수 있는 지식을 메모리로 저장합니다
5. 다음 작업에서 그 메모리를 재사용합니다

즉, Kiokuko는 **영구 메모리를 축적하는 RAG 시스템**입니다.

MCP는 AI 클라이언트와 Kiokuko를 연결하고, RAG는 필요한 메모리를 검색해 AI에 전달합니다.

### 설정 후 AI 에이전트의 동작

#### AI Akinator

AI 에이전트에게 전달된 요청이 너무 모호해 AI가 구체적인 작업을 파악하기 어려우면, Akinator가 내부 질문을 통해 AI에 필요한 수준까지 요청을 구체화합니다. 관련 언어나 프레임워크 등의 Skill이 있으면 사용할 수 있도록 준비합니다.

#### Enno-Oduno (役小角)

<img  width="634" src="https://github.com/askdkc/kiokuko/blob/main/skills/kiokuko-enno-oduno/enno-oduno.png?raw=true">

AI 에이전트의 요청을 처리하는 Enno-Oduno 루프가 활성화됩니다.

요청의 이상적인 결과를 정하고, 작업을 계획하고, 작은 에이전트들에게 구현을 orchestration한 뒤, 마지막으로 결과가 이상적인 상태에 맞는지 자동으로 확인합니다.

#### 메모리 저장

모델용 메모리는 capability gate를 거치는 MCP 도구 `task_prepare`와 `task_answer`를 통해서만 작업에 전달됩니다. `task_prepare`는 Enno-Oduno의 진입점입니다. 작업이 끝나면 내용을 기록하고 AI가 재사용할 지식으로 승격할 수 있는지 검토합니다. 실제로 유용한 지식이 승격되도록 자동 조정됩니다.

ready 응답에 모델용 context가 없지만 project에 검색 가능한 entry가 남아 있으면 `memoryPolicy`에 `deliveryEmpty: true`와 `storedEntryCount`가 포함됩니다. 의도적인 capability withholding과 빈 검색 결과를 구분하려면 `contextWithheld`도 확인하십시오.

### Enno-Oduno 에이전트 루프 상세

`build`, `debug`, `review`, `devops` 작업에서는 `task_prepare`가 run-bound loop를 시작하고 `ennoOduno`를 반환합니다. 강제되는 역할 순서는 다음과 같습니다.

```text
사용자 요청
  -> task_prepare: Enno-Oduno가 Codex, Claude Code 또는 OpenCode를 식별
  -> currentRole이 Enno-Oduno이면 requiredSkills의 kiokuko-enno-oduno를 읽고 적용
  -> Enno-Oduno가 필요한 Akinator 질문을 사용자에게 반환
  -> Oduno 이상 상태가 task_prepare handoff와 Akinator가 발견한 모든 Skill에서 최적 목표를 도출
  -> enno_ideal_submit이 이상 상태를 저장한 뒤에만 harness별 Zenki로 전달
  -> Zenki가 먼저 requiredSkills의 kiokuko-single-purpose-functions를 읽고 적용
  -> code 변경을 하나의 응집된 함수/유스케이스 계약, 책임, 변경 이유 및 focused test target으로 분리
  -> Zenki가 WorkUnit마다 version이 지정된 expertRefs 1~3개를 선택하며 기본적으로 선택하지 않은 fragment는 읽지 않음
  -> Zenki가 WorkPlan, WorkUnit, expert refs, Skill snapshot 및 verifier를 제출
  -> Enno-Oduno가 필요한 사용자 확인을 받음
   -> Goki가 승인된 WorkUnit만 orchestration
   -> enno_verify_prepare가 final verifier를 실행하고 새로운 증거를 저장
   -> 증거 준비 후에만 parent host가 final-review Advisor를 fan-out
   -> enno_finish가 저장된 증거에서 accept/replan/block을 결정
        -> 성공: Enno-Oduno가 수락하고 읽기 전용 Oduno meditation으로 전환
            -> 변경되었거나 승인된 path에서 근거가 있는 오래된 test 또는 함수를 탐색
            -> enno_meditation_submit이 삭제하지 않고 후보를 저장한 뒤 run을 완료
       -> 실패: Enno-Oduno가 revision을 올리고 feedback을 Zenki에 반환
   -> Zenki가 수정된 plan을 제출하고 확인이 성공한 뒤에만 Goki를 재개할 수 있음
```

Final Review는 의도적으로 두 단계입니다. `enno_verify_prepare`는 database
transaction 밖에서 shell을 비활성화하고 repository로 제한된 cwd에서 승인된
verifier를 실행합니다. 증거는 contract/mutation revision, verifier 사양 및 Git,
index, worktree, untracked file, symlink를 포함한 전체 repository 상태에 연결됩니다.
`enno_finish`는 그 상태를 다시 검사하고 subprocess를 실행하지 않으며 완전하게 저장된
통과 증거만으로 수락합니다. 테스트 통과만으로는 run을 수락하지 않습니다.
Enno continuation을 활성화하면 Codex와 Claude Code는 제한된 Stop hook을 사용하고,
OpenCode는 제한된 `session.idle` plugin을 사용합니다. Hermes는 native stdio MCP와
번들 Skill만 사용하며 Enno continuation adapter를 설치하지 않습니다.

Enno 입력 오류는 값을 포함하지 않는 제한된 `ENNO_INPUT_INVALID`로 반환됩니다.
advisory round는 `not_started`, `fanout_requested`, `aggregated`, `consumed` 순서로
전환되며 집계 결과가 소비 대기 중일 때만 advisory field가 필수입니다. 새 WorkUnit은
`code`, `ui`, `test`, `docs`, `operations` local route를 선언합니다. code에는 `code.*`,
UI에는 `code.*`와 `ui.*` expert가 필요하지만 이 요구 사항은 test/docs/operations
unit에 전파되지 않습니다. plan recovery는 사용자가 선택할 때까지 자동 continuation을
중지하는 marker만 저장하며 plan 저장이나 구현 시작은 하지 않습니다. continuation은 route epoch에 바인딩된 단기 resume token과 단일 소유자 execution lease를
사용하며 만료된 operation/verifier는 원자적으로 abandoned 처리 후 다시 claim할 수 있습니다.
narrative와 증거는 hash 및 저장 전에 sanitize되고 secret이 포함된 verifier command는 거부됩니다.

번들 coding Skill은 실제 위험에 비례해 문제 구조화를 적용합니다. WorkUnit이 domain 어휘,
공개 response·DTO·ViewModel 또는 storage·API·serialization·UI 사이의 변환을 정의하면
`code.modeling.v1` expert를 선택합니다. 표현을 유지하는 기계적 수정은 code를 변경한다는
이유만으로 이 expert를 선택하지 않습니다. 이 expert는 소비자가 필요한 형태를 먼저 정하고
이름 있는 변환을 설계하지만 Lisp 문법, macro 또는 DSL 사용을 요구하지 않습니다. 기존
설치에는 다음 `kiokuko setup` 실행 시 managed reference가 배포됩니다.

따라서 intake가 완료되지 않으면 Enno-Oduno directive와 `answer_intake`를 반환하며, `requiredSkills`에는 `kiokuko-enno-oduno`가 포함되고 Zenki는 아직 시작되지 않습니다. 준비된 intake는 먼저 `oduno_ideal`과 `submit_ideal`을 반환합니다. `enno_ideal_submit`은 Akinator가 선택한 discovery set의 모든 Skill에 대해 정확히 하나의 기여를 요구하며, 외부 Skill은 신뢰할 수 없는 reference-only 지침으로 유지됩니다. 그 후에만 run은 revision-bound Zenki directive를 반환합니다. 이 directive의 `requiredSkills`에는 draft Skill snapshot이 비어 있어도 compact index인 `kiokuko-single-purpose-functions`가 포함됩니다. Zenki는 WorkUnit을 선택하기 전에 이 index를 사용해 의미 없는 micro-function을 만들지 않고 code 변경을 응집된 함수 또는 유스케이스 계약과 focused test target으로 나눕니다. code를 변경하는 각 WorkUnit은 이유와 함께 등록된 `expertRefs`를 1~3개 선택해야 하며, UI WorkUnit은 `code.*`와 `ui.*` expert를 각각 하나 이상 요구합니다. `enno_plan_submit`은 누락, 중복, 알 수 없음 또는 제한을 초과한 조합을 거부하고 정확한 선택을 revision과 함께 저장합니다. Goki는 모든 Skill reference가 아니라 해당 fragment만 읽습니다. controller Skill은 role 수준이며 WorkUnit Skill snapshot에 삽입되지 않습니다. Zenki의 전체 plan이 승인되고 필요한 확인이 성공하기 전에는 Goki로 전환할 수 없습니다. 최종 review가 실패해도 이전 Goki WorkUnit을 직접 재개하지 않습니다. 거부된 plan과 verifier 증거를 이전 revision의 기록으로 보존하고 `zenki_planning`으로 이동해 새로운 revision-bound plan을 요구합니다. 승인된 review는 직접 완료되지 않고 `oduno_meditation`으로 이동합니다. `enno_meditation_submit`은 repository를 변경하지 않고 검사한 repository-relative path와 근거가 있는 오래된 test 또는 함수 후보를 저장한 뒤 run을 완료합니다. 응답의 `orchestrationId`는 모든 Enno MCP 작업에서 사용되며 host session identity와 분리됩니다. 추론한 scope, acceptance criteria, Skill, expert 선택 또는 verifier command가 있으면 구현 전에 일반 클라이언트 UI로 확인을 반환합니다. `needs_confirmation` 응답에는 확정된 계약의 결정적 표시 projection인 `ennoOduno.directive.userFacingConfirmation`이 포함됩니다. scope, 제외 항목, 완료 조건, 표시 번호 의존성을 가진 작업 항목, reference-only 상태를 포함한 Skill, 선택 이유가 있는 전문 관점, focused/final checks, 시도 상한이 각각 provenance basis(사용자 지정, 저장소 검증, 제안) 라벨과 함께 한 번씩 나타납니다. 클라이언트 모델은 raw directive JSON이나 내부 식별자를 노출하지 않고 모든 항목을 사용자 언어로 제시한 뒤 명시적인 approve, revise, cancel을 기다립니다. 기밀처럼 보이는 표시 값이나 64 KiB를 초과하는 projection은 가리거나 잘라내는 대신 plan 제출을 거부합니다.

공개 MCP tool failure는 일반 `isError: true` tool result입니다. 일반 failure에는 allowlist된 사용자용 문구와 `structuredContent.code`, `structuredContent.retryable`만 포함되며, `BACKPRESSURE`만 제한된 `retryAfterSeconds`도 포함할 수 있습니다. 원본 message, stack, 임의 details, path, SQL, request payload, credential 형태의 값은 일반 payload에 복사하지 않습니다. checkpoint, plan recovery, Enno validation 전용 error는 목적별로 제한된 field를 유지합니다.

Codex extension은 completion event와 model input보다 먼저 성공 및 error MCP result를 검사하거나 교체할 수 있습니다. 따라서 extension 계층은 trusted computing base의 일부입니다. `userFacingConfirmation`은 Kiokuko server가 생성한 projection이며 extension 처리 후 실제로 표시되거나 model에 전달된 내용을 증명하지 않습니다. 중요한 Kiokuko result를 변경하는 extension과 함께 사용하지 마십시오. Kiokuko는 Codex에서 위조 불가능한 original-result provenance나 modified flag를 받지 못하므로 end-to-end authenticity를 주장하지 않으며 server-only digest나 HMAC으로 대체하지 않습니다. 완전한 upstream 계약에는 extension이 위조할 수 없는 original-result digest 또는 identifier, modified flag, 정확한 tool call과의 binding이 필요합니다.

Codex의 effective plugin catalog는 requested repository와 선택한 model에 따라 달라질 수 있습니다. host는 task preparation에서 유지한 완전한 effective Skill/MCP tool catalog를 전달해야 합니다. 순서와 완전히 같은 descriptor의 중복은 binding을 바꾸지 않지만 항목 추가·삭제 또는 canonical name, kind, description 변경은 환경 변경으로 plan 시작을 중지합니다. catalog 생략과 명시적인 빈 catalog는 의미가 다릅니다. 한 plugin marketplace의 load error를 빈 catalog로 축약하여 다른 유효한 capability까지 숨기면 안 되며, load error는 별도로 진단 가능해야 합니다.

### 계획 시작 환경 정보가 누락되거나 변경된 경우

여기서 환경 정보는 현재 AI 클라이언트에서 사용할 수 있는 Skill과 MCP tool 목록입니다. host가 자동으로 수집하므로 사용자가 catalog 위치를 찾거나 JSON을 만들 필요가 없습니다. 이 정보가 계획에 전달되지 않았거나 작업 준비 후 변경되면 Kiokuko는 자동 continuation을 중지하는 marker만 저장하고 Skill discovery, advisory 소비, receipt 생성, plan 저장 또는 계약 revision 변경 전에 중지합니다. 따라서 이번 계획 시작으로 새 작업이나 추가 code 변경은 발생하지 않습니다. 같은 run을 다시 제출할 때는 사용자가 선택한 recovery action도 함께 전달합니다.

각 선택지는 label과 추천 여부, 어떤 사용자 의도에 맞는지, 선택 후 정확히 무엇이 일어나는지의 순서로 표시됩니다.

환경 정보만 누락되어 현재 시도를 계속할 수 있는 경우:

- **같은 계획으로 계속(권장)** — 계획은 여전히 올바르고 현재 환경 정보만 다시 붙이면 될 때 선택합니다. host가 정보를 자동으로 붙이고 같은 시도를 계속합니다.
- **계획 검토** — 계속하기 전에 범위, 작업 항목 또는 검증 방법을 바꾸고 싶을 때 선택합니다. 클라이언트가 변경 내용을 묻고 답변 전에는 구현을 시작하지 않습니다.
- **취소** — 작업을 계속하지 않을 때 선택합니다. 현재 시도를 취소하며 대체 시도를 만들지 않습니다.

작업 준비 후 사용할 수 있는 기능이 변경된 경우:

- **현재 환경에서 같은 계획 다시 시작(권장)** — 계획은 올바르고 사용할 수 있는 기능만 바뀌었을 때 선택합니다. 현재 시도를 먼저 취소한 뒤 현재 환경과 같은 합의된 계획으로 새 시도를 시작합니다.
- **계획을 검토한 뒤 다시 시작** — 기능 변경에 맞춰 범위, 작업 항목 또는 검증 방법도 바꾸고 싶을 때 선택합니다. 클라이언트가 변경 내용을 묻고, 답변 후 현재 시도를 취소한 다음 현재 환경과 수정된 계획으로 새 시도를 시작합니다.
- **취소** — 작업을 계속하지 않을 때 선택합니다. 현재 시도를 취소하며 대체 시도를 만들지 않습니다.

이전 동작으로 해당 시도가 이미 종료된 경우:

- **같은 계획으로 다시 시작(권장)** — 종료된 시도의 계획이 여전히 올바르고 재사용하려는 경우 선택합니다. 종료된 시도는 그대로 두고 현재 환경과 같은 합의된 계획으로 새 시도를 시작합니다.
- **계획을 검토한 뒤 다시 시작** — 대체 시도를 만들기 전에 범위, 작업 항목 또는 검증 방법을 바꾸려는 경우 선택합니다. 클라이언트가 변경 내용을 묻고 종료된 시도는 그대로 두며, 답변 후 현재 환경과 수정된 계획으로 새 시도를 시작합니다.
- **취소** — 작업을 다시 시작하지 않을 때 선택합니다. 종료된 시도는 종료 상태로 유지되고 새 시도는 만들어지지 않습니다.

클라이언트는 안내를 사용자 언어로 번역하고 기계용 action, 내부 reason code와 tool/field 이름, capability catalog, 식별자, revision, 표시 형식 version 또는 raw JSON을 표시하지 않습니다. 사용자가 명시적으로 선택하기 전에는 재시도, 취소 또는 대체 시도 생성을 자동으로 수행하지 않습니다.

세 역할은 현재 클라이언트 모델을 사용합니다. Kiokuko는 별도의 모델을 호출하지 않으며 OpenAI, Anthropic 또는 OpenCode API credential을 요구하지 않습니다. Codex와 Claude Code는 횟수가 제한된 Stop hook을 사용하고 OpenCode는 횟수가 제한된 `session.idle` plugin을 사용합니다. OpenCode는 child-session idle event를 무시하고 같은 완료 turn의 반복 delivery를 deduplicate합니다. 같은 OS 사용자로 canonical repository에 접근할 수 있는 local process는 해당 run을 재개할 수 있다고 신뢰합니다. PID, process ancestry, executable 또는 code signing 증명은 추가하지 않습니다. adapter는 현재 단기 resume token을 우선하고 유효한 token route가 없으면 Codex, Claude Code, OpenCode 사이에서 canonical repository의 모호하지 않은 단 하나의 active run을 원자적으로 reroute합니다. reroute는 route epoch를 증가시켜 이전 token을 무효화하며 active WorkUnit execution lease가 있으면 차단됩니다. 후보가 여러 개면 어떤 run도 변경하지 않고 제어를 반환합니다. 공개 응답의 `clientBinding`은 현재 route를 나타내며 `bound`는 소유자를 뜻하지 않습니다. session별 continuation 한도에 도달하면 그 session의 자동 계속만 중지하며 run과 ledger는 다른 local project client가 재개할 수 있도록 active 상태를 유지합니다. Kiokuko는 Claude Code의 기본 8회 연속 Stop-block override보다 먼저 제어를 반환합니다. Hermes에는 자동 continuation hook이 없지만 같은 run identity를 사용하는 MCP 작업은 계속할 수 있습니다. adapter 실패 시 고정 warning과 함께 클라이언트가 중지될 수 있습니다. 외부 Skill은 신뢰할 수 없는 reference-only 자료이며 자동으로 설치되거나 실행되지 않습니다.

```bash
kiokuko setup --clients codex,opencode,claude --enno-oduno on
kiokuko enno run --role zenki --input-json -
```

실제 클라이언트 test는 선택 사항이며 release gate와 분리됩니다. 일치하는 환경 변수가 없으면 `not-run`으로 보고됩니다.

```bash
npm run test:e2e:codex
npm run test:e2e:opencode
npm run test:e2e:claude
npm run test:e2e:agents
```

`RUN_CODEX_E2E=1`을 지정하면 Codex runner가 실행 파일 version을 기록하고 agent 작업을 시작하기 전에 0.151.0 이상인지 확인합니다. 이어서 의도적으로 실패하는 `required = true` MCP server가 있는 격리 config를 사용하며, 명시적인 MCP startup failure를 관찰한 경우에만 계속합니다. 설치된 Codex CLI에는 이 repository에서 `ToolLifecycleContributor`를 주입하는 경로가 없습니다. 따라서 direct/Code Mode의 success/error result 교체, immutable provenance, repository-local marketplace 격리는 대응하는 외부 Codex fixture가 준비될 때까지 명시적인 `not-run` subcheck로 남으며 추론만으로 passed라고 보고하지 않습니다.

지원 클라이언트:

- Codex
- OpenCode
- Claude Code
- Hermes Agent

## 메모리는 프로젝트별로 분리됩니다

일반 검색에서는 관련 없는 프로젝트의 메모리를 섞지 않습니다.

- **Project 메모리**
  현재 저장소에서만 사용하는 지식

- **Global 메모리**
  언어, 프레임워크, 데이터베이스, 도구 등 여러 프로젝트에서 재사용할 수 있는 지식

프로젝트는 Git remote 또는 경로에서 자동으로 판별됩니다.

Project 메모리를 Global 메모리로 옮길 때는 Curator에서 후보를 확인하고 명시적으로 승인합니다.

```bash
kiokuko curator
```

## 메모리 확인하기

로컬 Web UI에서 저장된 메모리를 검색, 확인하고 편집할 수 있습니다.

```bash
kiokuko web
```

브라우저에서 다음 주소를 여십시오.

```text
http://127.0.0.1:4173
```

Web UI는 로컬 환경에서만 작동하며 외부 네트워크에 공개되지 않습니다.
Web UI와 명시적 memory CLI 명령은 사람/operator용 관리 화면입니다. 모델이
`task_prepare` / `task_answer`를 우회하여 작업 메모리를 가져오는 경로가 아닙니다.

## 외부 스킬

외부 스킬 검색은 참고 데이터 전용이며 Akinator task preparation에서 기본적으로
`official` 모드를 사용합니다. 현재 GitHub 커밋을 검증하고 제한된 내용을 신뢰할 수
없는 후보 메모리로 저장하지만 자동 설치나 실행은 하지 않습니다. 자동 검색을
중지하려면 `KIOKUKO_SKILL_DISCOVERY=off`를 지정합니다. `community`는 계속 명시적으로
활성화해야 합니다. 대화형 `kiokuko setup`에서 활성화 여부를 확인하며, 배치 실행은
`--skill-discovery community`를 사용할 수 있습니다.

명령 예시:

```bash
kiokuko skills find svelte --official-only --json
kiokuko skills list
kiokuko skills disable sveltejs/ai-tools/svelte-code-writer
kiokuko skills refresh sveltejs/ai-tools/svelte-code-writer
```

Web UI의 외부 스킬 화면에서는 출처 상태를 확인하고 가져온 매핑을 비활성화하거나
다시 활성화할 수 있습니다. 설치, 스크립트 실행, MCP 등록 기능은 없습니다.

## 안전성

Kiokuko는 전체 대화를 저장하지 않습니다.

비밀번호, API 키, 토큰, 개인 키 등 시크릿처럼 보이는 내용은 저장을 거부합니다.

저장된 메모리는 항상 참고 정보로 취급됩니다. 과거 메모리보다 현재 코드, 설정, 실행 결과가 우선합니다.

## MoA advisory round

ideal, planning, final review 단계에서는 parent host가 정확히 세 개의 고정된 격리 read-only Advisor slot을 fan-out할 수 있습니다. Advisor를 실행하는 것은 Kiokuko가 아니라 parent host이며 prompt만으로 격리를 증명하지 않습니다. 격리를 검증할 수 없는 slot은 `unavailable`로 보고하고, parent Aggregator만 identity가 없는 구조화 결과를 `enno_advice_submit`에 제출합니다. 결과는 `host_reported`로 기록하며 provider/model identity와 raw subagent 출력은 저장하지 않습니다. 각 Round는 phase, revision, mutation revision, policy, slot 정의와 context digest에 고정됩니다.

## 주의

Kiokuko는 프롬프트를 가로채는 방식이 아닙니다. 자동 사용은 각 AI 클라이언트와 모델의 MCP 호출에 의존하므로 모든 턴에서 반드시 호출된다는 보장은 없습니다.

자세한 명령어는 다음에서 확인할 수 있습니다.

```bash
kiokuko --help
kiokuko setup --help
```
