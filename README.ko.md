# Kiokuko(기억 저장소)

[English](README.md) | [日本語](README.ja.md) | [简体中文](README.zh-CN.md) | 한국어

**MCP로 연결하고, RAG로 떠올리고, 작업 후에 기억합니다.**

Kiokuko는 AI 코딩 에이전트를 위한 외부 메모리입니다.

이전 작업에서 얻은 지식을 로컬 SQLite에 저장하고, 다음 요청에서 관련된 메모리만 검색해 AI에 전달합니다.

사용자는 매번 프롬프트에 과거의 경위를 붙여넣거나 메모리를 직접 찾을 필요가 없습니다. 평소처럼 AI를 사용하기만 하면 프로젝트 고유의 지식이 조금씩 쌓이고 다음 작업에 재사용됩니다.

## 바로 시작하기

Node.js 26.1.0 이상이 필요합니다.
다음 두 명령어로 쉽게 시작할 수 있습니다 💕

```bash
npm install --global @askdkc/kiokuko
kiokuko setup
```

`setup`은 설치된 지원 클라이언트를 감지하고 SQLite 데이터베이스와 MCP 연결을 자동으로 설정합니다.
대화형 setup은 감사된 community Skill도 참고 자료로 사용할지 묻고, 기본 응답은 아니요입니다.
Codex, Claude Code, OpenCode를 새로 설정할 때는 Enno-Oduno 에이전트 루프도 활성화됩니다. 기존 관리 환경은 `--enno-oduno on`을 명시적으로 선택할 때까지 유지되며, `--enno-oduno off`는 Enno-Oduno가 소유한 hook 또는 plugin만 제거합니다.
setup은 번들된 `kiokuko-enno-oduno` controller Skill을 `kiokuko-single-purpose-functions`, `kiokuko-ui-design-soul`과 함께 선택한 모든 지원 클라이언트에 설치합니다.
모델용 메모리는 capability gate를 거치는 MCP 도구 `task_prepare`와
`task_answer`를 통해서만 작업에 전달됩니다. `task_prepare`는 Enno-Oduno의 진입점이기도 합니다. Enno-Oduno는 호출한 harness를 식별하고 Akinator intake를 소유하며, 실행 가능한 요청을 Zenki에 넘기기 전에 Oduno 이상 상태를 도출합니다. hook은 메모리를 암묵적으로 불러오거나 계획을 우회하지 않습니다. canonical repository에서 모호하지 않은 단 하나의 pending active run만 client session에 바인딩한 뒤 Oduno, Zenki, Goki 또는 최종 review의 계속 여부를 gate합니다. repository 전체의 최신 run을 선택하지 않습니다.

모든 `task_prepare` 호출은 클라이언트 모델이 해당 논리 요청을 위해 로컬 `kiokuko-soul` Skill 전체를 읽은 후 `soulRead: true`를 전달해야 합니다. 또한 모든 작업에서 정확히 일치하는 로컬 `kiokuko-soul` capability가 필요하며, 누락되었거나 availability를 알 수 없으면 intake가 완료되지 않았더라도 fail-close합니다. 이 boolean은 클라이언트의 명시적 attestation이며, 모델이 Skill을 이해하고 준수했다는 remote proof는 아닙니다.

설정 후 대상 AI 클라이언트를 실행하고 평소처럼 사용하면 됩니다. 이미 실행 중이라면 한 번 종료한 후 다시 시작하십시오. setup이 Codex Stop hook을 생성하거나 업데이트했다면 Codex에서 `/hooks`를 열고 해당 hook을 명시적으로 신뢰하십시오.

### Enno-Oduno 에이전트 루프

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
  -> Enno-Oduno가 새로운 final-verifier 증거를 review
       -> 성공: Enno-Oduno가 수락하고 읽기 전용 Oduno meditation으로 전환
            -> 변경되었거나 승인된 path에서 근거가 있는 오래된 test 또는 함수를 탐색
            -> enno_meditation_submit이 삭제하지 않고 후보를 저장한 뒤 run을 완료
       -> 실패: Enno-Oduno가 revision을 올리고 feedback을 Zenki에 반환
  -> Zenki가 수정된 plan을 제출하고 확인이 성공한 뒤에만 Goki를 재개할 수 있음
```

따라서 intake가 완료되지 않으면 Enno-Oduno directive와 `answer_intake`를 반환하며, `requiredSkills`에는 `kiokuko-enno-oduno`가 포함되고 Zenki는 아직 시작되지 않습니다. 준비된 intake는 먼저 `oduno_ideal`과 `submit_ideal`을 반환합니다. `enno_ideal_submit`은 Akinator가 선택한 discovery set의 모든 Skill에 대해 정확히 하나의 기여를 요구하며, 외부 Skill은 신뢰할 수 없는 reference-only 지침으로 유지됩니다. 그 후에만 run은 revision-bound Zenki directive를 반환합니다. 이 directive의 `requiredSkills`에는 draft Skill snapshot이 비어 있어도 compact index인 `kiokuko-single-purpose-functions`가 포함됩니다. Zenki는 WorkUnit을 선택하기 전에 이 index를 사용해 의미 없는 micro-function을 만들지 않고 code 변경을 응집된 함수 또는 유스케이스 계약과 focused test target으로 나눕니다. code를 변경하는 각 WorkUnit은 이유와 함께 등록된 `expertRefs`를 1~3개 선택해야 하며, UI WorkUnit은 `code.*`와 `ui.*` expert를 각각 하나 이상 요구합니다. `enno_plan_submit`은 누락, 중복, 알 수 없음 또는 제한을 초과한 조합을 거부하고 정확한 선택을 revision과 함께 저장합니다. Goki는 모든 Skill reference가 아니라 해당 fragment만 읽습니다. controller Skill은 role 수준이며 WorkUnit Skill snapshot에 삽입되지 않습니다. Zenki의 전체 plan이 승인되고 필요한 확인이 성공하기 전에는 Goki로 전환할 수 없습니다. 최종 review가 실패해도 이전 Goki WorkUnit을 직접 재개하지 않습니다. 거부된 plan과 verifier 증거를 이전 revision의 기록으로 보존하고 `zenki_planning`으로 이동해 새로운 revision-bound plan을 요구합니다. 승인된 review는 직접 완료되지 않고 `oduno_meditation`으로 이동합니다. `enno_meditation_submit`은 repository를 변경하지 않고 검사한 repository-relative path와 근거가 있는 오래된 test 또는 함수 후보를 저장한 뒤 run을 완료합니다. 응답의 `orchestrationId`는 모든 Enno MCP 작업에서 사용되며 host session identity와 분리됩니다. 추론한 scope, acceptance criteria, Skill, expert 선택 또는 verifier command가 있으면 구현 전에 일반 클라이언트 UI로 확인을 반환합니다. `needs_confirmation` 응답에는 확정된 계약의 결정적 표시 projection인 `ennoOduno.directive.userFacingConfirmation`이 포함됩니다. scope, 제외 항목, 완료 조건, 표시 번호 의존성을 가진 작업 항목, reference-only 상태를 포함한 Skill, 선택 이유가 있는 전문 관점, focused/final checks, 시도 상한이 각각 provenance basis(사용자 지정, 저장소 검증, 제안) 라벨과 함께 한 번씩 나타납니다. 클라이언트 모델은 raw directive JSON이나 내부 식별자를 노출하지 않고 모든 항목을 사용자 언어로 제시한 뒤 명시적인 approve, revise, cancel을 기다립니다. 기밀처럼 보이는 표시 값이나 64 KiB를 초과하는 projection은 가리거나 잘라내는 대신 plan 제출을 거부합니다.

세 역할은 현재 클라이언트 모델을 사용합니다. Kiokuko는 별도의 모델을 호출하지 않으며 OpenAI, Anthropic 또는 OpenCode API credential을 요구하지 않습니다. Codex와 Claude Code는 횟수가 제한된 Stop hook을 사용하고 OpenCode는 횟수가 제한된 `session.idle` plugin을 사용합니다. OpenCode는 child-session idle event를 무시하고 같은 완료 turn의 반복 delivery를 deduplicate합니다. `task_prepare`에서 host session을 사용할 수 없었다면 최초의 일치 hook은 pending active run이 정확히 하나일 때만 원자적으로 바인딩합니다. 모호하면 추측하지 않고 제어를 반환하며 완료된 binding은 변경할 수 없습니다. Kiokuko는 Claude Code의 기본 8회 연속 Stop-block override보다 먼저 제어를 반환합니다. adapter 실패 시 고정 warning과 함께 클라이언트가 중지될 수 있습니다. 외부 Skill은 신뢰할 수 없는 reference-only 자료이며 자동으로 설치되거나 실행되지 않습니다.

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

지원 클라이언트:

- Codex
- OpenCode
- Claude Code
- Hermes Agent

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
