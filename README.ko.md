# Kiokuko

[English](README.md) | [日本語](README.ja.md) | [简体中文](README.zh-CN.md) | 한국어

Kiokuko는 AI 코딩 에이전트를 위한 모델 독립적인 외부 메모리 도구입니다. npm으로 한 번 전역 설치하면 현재 운영체제 사용자의 SQLite 데이터베이스에 구조화된 메모리를 저장하고, native stdio MCP를 통해 Codex, OpenCode, Claude Code 및 Hermes Agent에 작업 준비와 recall/checkpoint 도구를 제공합니다.

## 전역 설치 및 활성화

Node.js 24 이상이 필요합니다.

```bash
npm install --global @askdkc/kiokuko
kiokuko setup
```

인자 없는 `setup`은 `PATH`에서 지원되는 각 클라이언트(`codex`, `opencode`, `claude`, `hermes`)의 실행 파일을 확인합니다. 대화형 터미널에서는 선택 목록을 표시하고 감지된 클라이언트를 미리 체크합니다. Enter를 누르면 현재 선택을 적용하며, 쉼표로 구분한 클라이언트 이름 또는 번호를 입력해 선택을 변경할 수 있고 `none`으로 클라이언트 설정 없음을 선택할 수 있습니다. 비대화형 터미널이나 `--json` 사용 시에는 프롬프트를 표시하지 않고 감지된 클라이언트만 설정합니다. `hermes`가 감지되면 `hermes config path`로 현재 profile을 확인하고, 그렇지 않으면 유효한 `active_profile` marker 또는 기본 `$HOME/.hermes`를 사용합니다. 지원되는 클라이언트를 하나도 감지하지 못해도 데이터베이스는 초기화하지만 클라이언트 설정은 작성하지 않습니다. 클라이언트를 명시적으로 설정하려면 `--clients`를 사용하십시오. `--clients`를 명시하면 항상 해당 선택이 우선됩니다.

npm 패키지 이름은 `@askdkc/kiokuko`이지만 설치되는 CLI 명령 이름은 계속 `kiokuko`입니다.

설정 후 setup 결과에 표시된 클라이언트를 다시 시작하십시오. Hermes의 `/reload-mcp`는 MCP 등록을 다시 불러오지만 업데이트된 표준 스킬을 찾으려면 재시작 또는 새 세션이 필요합니다. `hermes mcp test kiokuko`로 smoke test할 수 있습니다. Hermes는 유효한 profile의 native stdio MCP를 사용하며 전역 지침 파일, Hermes plugin 또는 hook을 만들지 않습니다.

`setup`은 명시적으로 실행하는 멱등 작업입니다. npm `postinstall`은 AI 클라이언트 설정을 수정하지 않습니다. 기존 TOML/JSON/JSONC/YAML 설정, 주석, 지침 내용, 줄바꿈 형식 및 파일 모드는 유지되며 Kiokuko는 관리 구역만 수정합니다. 기본적으로 setup은 고정된 로컬 매니페스트에서 `kiokuko-ui-design-soul` 표준 스킬도 설치하며, setup 중 다운로드나 HIG 페이지 스크래핑은 하지 않습니다.

기존 데이터베이스에 적용되지 않은 마이그레이션이 있으면 setup은 먼저 현재 사용자의 데이터 디렉터리 안에 있는 `backups/`에 백업을 만들고 무결성을 검사합니다. 현재 Kiokuko보다 새로운 버전에서 기록된 데이터베이스는 변경하지 않고 거부합니다.

```bash
# 아무것도 쓰지 않고 정확한 대상 파일과 예정된 변경 사항 확인
kiokuko setup --dry-run --json

# 클라이언트 하나만 설정
kiokuko setup --clients codex
kiokuko setup --clients opencode
kiokuko setup --clients claude
kiokuko setup --clients hermes

# 클라이언트 프로세스가 npm의 PATH를 상속하지 않는 경우 절대 경로 사용
kiokuko setup --command /absolute/path/to/kiokuko

# 새 표준 스킬 배치를 건너뜀; 기존 복사본은 삭제하지 않음
kiokuko setup --no-standard-skills
```

Hermes 설정은 profile 범위입니다. `$HOME/.hermes/profiles/work/config.yaml` 같은 named profile에는 해당 profile의 MCP 설정과 표준 skill만 배치하고 root 및 비활성 profile은 변경하지 않습니다. 다른 프로세스에서 임시로 지정한 `hermes -p <name>`은 자동 추측하지 않습니다. named profile을 확실히 지정하려면 다음처럼 `HERMES_HOME`에 profile 디렉터리를 전달하십시오.

```bash
HERMES_HOME="$HOME/.hermes/profiles/work" kiokuko setup --clients hermes
```

Desktop 프로세스가 `PATH`에서 `kiokuko`를 찾지 못하면 빈 `command -v` 결과를 넘기지 말고 절대 경로로 전환하십시오.

```bash
KIOKUKO_BIN="$(command -v kiokuko)"
test -n "$KIOKUKO_BIN" && test -x "$KIOKUKO_BIN" || { echo "kiokuko executable not found" >&2; exit 1; }
kiokuko setup --clients hermes --command "$KIOKUKO_BIN"
```

설정 대상은 다음과 같습니다.

| 클라이언트 | MCP 설정 | 전역 지침 | 런타임 가드 | 표준 스킬 |
|---|---|---|---|---|
| Codex | `$CODEX_HOME/config.toml` 또는 `~/.codex/config.toml` | `$CODEX_HOME/AGENTS.md` 또는 `~/.codex/AGENTS.md` | — | `~/.agents/skills/kiokuko-ui-design-soul` |
| OpenCode | `$XDG_CONFIG_HOME/opencode/opencode.json` 또는 `~/.config/opencode/opencode.json` | 같은 디렉터리의 `AGENTS.md` | `plugins/kiokuko-loop-guard.js` | 전역 설정의 `skills/kiokuko-ui-design-soul` |
| Claude Code | `$CLAUDE_CONFIG_DIR/.claude.json` 또는 `~/.claude.json` | `$CLAUDE_CONFIG_DIR/CLAUDE.md` 또는 `~/.claude/CLAUDE.md` | — | Claude 설정의 `skills/kiokuko-ui-design-soul` |
| Hermes Agent | 유효한 profile의 `config.yaml` (`$HERMES_HOME`, `$HOME/.hermes` 또는 `%LOCALAPPDATA%/hermes`) | 없음 | 없음 | 유효한 profile의 `skills/kiokuko-ui-design-soul` |

Hermes 설정은 profile 범위의 native stdio MCP입니다. `mcp_servers.kiokuko`에 `command: kiokuko`, `args: [mcp]`를 등록합니다. 관리되는 canonical entry는 `--command`로 command만 변경할 수 있으며 args, 주석, 다른 server는 유지됩니다. 관리되지 않은 entry, 추가 field, `mcp`가 아닌 args는 계속 conflict입니다. Hermes의 내장 memory와 skills는 Kiokuko와 별개이며, 모델이 MCP tool descriptions를 사용할지는 best effort입니다.

OpenCode의 `opencode.jsonc`가 이미 있으면 Kiokuko는 주석을 유지하면서 해당 파일을 수정합니다. Codex에 Kiokuko가 관리하지 않는 `[mcp_servers.kiokuko]` 테이블이 이미 있으면 어떤 설정을 덮어쓸지 추측하지 않고 설정을 중단합니다. 관리되는 OpenCode 가드는 보이는 에이전트를 12 step으로 제한하고, 사용자 요청마다 `task_prepare`와 `memory_checkpoint`를 각각 한 번만 허용하며, 체크포인트 후 도구 단계를 닫고, 동일 호출 또는 읽기 전용 탐색 결과가 세 번 연속 나온 뒤의 재실행을 차단합니다. 카운터와 지문은 프로세스 메모리에만 보관됩니다.

각 표준 스킬 파일에는 Kiokuko 관리 마커가 있습니다. setup은 고정된 알려진 파일만 업데이트하고 완전 일치는 `unchanged`로 보고하며 관련 없는 형제 파일은 유지합니다. 같은 이름의 파일에 관리 마커가 없으면 파일이나 데이터베이스를 쓰기 전에 `CONFLICT`로 중단합니다.

## 메모리 범위

데이터베이스는 운영체제 사용자 전체에서 공유되지만 일반 recall은 전역 데이터베이스 전체를 검색하지 않습니다.

- `project` 메모리는 `.kiokuko.json`, 알려진 정규 경로 또는 Git remote에서 자동으로 확인됩니다. 다른 프로젝트의 메모리는 제외됩니다.
- `global` 메모리는 실제로 여러 프로젝트에 적용되는 선호 사항과 교훈을 위해 예약됩니다.
- 기본 `auto` recall은 현재 프로젝트와 global 메모리만 반환합니다.
- remote가 없는 저장소에는 경로에서 파생된 안정적인 식별자가 할당됩니다. 자동 확인 중 Kiokuko는 저장소에 어떤 파일도 쓰지 않습니다.

MCP 인터페이스는 의도적으로 작게 유지됩니다.

- `task_prepare`: 사용자 요청마다 한 번만 Akinator 방식 수집, 제한된 메모리/참조 검색, 현재 클라이언트가 제공한 스킬 및 MCP 도구 이름과의 매칭을 수행합니다.
- `task_answer`: 사용자 요청 또는 검증된 저장소 근거로 뒷받침되는 답변만 사용해 수집을 계속합니다.
- `memory_recall`: 제한된 project/global 컨텍스트를 읽으며 항상 untrusted로 표시합니다.
- `memory_checkpoint`: 사용자 요청 마지막에 한 번만 제한된 지속성 항목을 `candidate` 및 `untrusted`로 저장합니다. 비밀 정보로 보이는 내용은 거부됩니다.

이는 지침에 기반한 자동 사용이며 프롬프트 가로채기가 아닙니다. Codex, OpenCode, Claude Code 및 Hermes Agent가 특정 턴에서 도구를 호출하지 않을 가능성은 여전히 있습니다. Hermes의 자동/모델 사용은 MCP tool descriptions에 따른 best effort입니다. Hermes의 내장 memory와 skills는 분리되어 있습니다. Kiokuko는 Hermes 전역 지침 파일, plugin 또는 hook을 만들지 않으며 전체 대화를 수집하거나 외부에서 가져온 스킬을 자동 설치하거나 메모리를 조용히 verified 상태로 승격하지 않습니다. OpenCode에 설치하는 유일한 plugin은 위의 제한된 로컬 루프 가드이며 동봉 표준 스킬은 plugin이 아니라 클라이언트 native skill입니다.

## 개발

```bash
npm install
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

## 개발 환경에서 사용

```bash
npm exec -- tsx src/bin/kiokuko.ts setup --dry-run --json
npm exec -- tsx src/bin/kiokuko.ts mcp
```

`kiokuko use`는 이식 가능한 명시적 바인딩이 필요한 경우를 위한 선택 기능으로 유지됩니다. `.kiokuko.json`과 `AGENTS.md`의 관리 블록을 생성하지만 일반적인 MCP 사용에는 더 이상 필요하지 않습니다.

## Akinator 방식 지식 수집

중요한 작업에서는 설정된 에이전트 지침이 `task_prepare`를 호출합니다. 이 도구는 작업 유형, 대상 및 성공 조건과 같이 누락된 고가치 필드만 질문한 뒤 쿼리와 역할과 용도 태그를 사용하여 로컬 메모리를 선택합니다. 클라이언트가 현재 사용 가능한 스킬과 MCP 도구 이름을 제공하면 필요한 기능을 매칭하고 `available`, `missing`, `unknown`을 구분해 반환합니다. 이 목록은 일시적으로만 사용되며 저장되지 않습니다. CLI의 `guide` 명령으로 같은 수집을 수동 실행할 수 있습니다.

작업에 UI, UX, frontend, screen, SwiftUI, 화면 또는 accessibility 같은 구체적인 인터페이스 용어가 있으면 `task_prepare`는 클라이언트 capability 목록의 `kiokuko-ui-design-soul`을 명시적으로 추천합니다. 일반적인 `design`, backend-only 작업 또는 이미지 생성만 있는 요청에서는 발동하지 않습니다.

```bash
kiokuko guide start "Implement the API change and add tests" \
  --workspace <workspace> --json
kiokuko guide answer <session-id> --workspace <workspace> \
  --question-id target --value src/api.ts --json
kiokuko guide answer <session-id> --workspace <workspace> \
  --question-id expected --value "All tests pass" --json
kiokuko guide context <session-id> --workspace <workspace> --json
```

로컬 검색에서 관련 항목을 찾지 못하고 클라이언트가 사용 가능한 스킬이 0개라고 명시한 경우에만 `task_prepare`가 다음 단일 허용 목록 공개 저장소에서 현재 `main` 트리를 가져올 수 있습니다.

- https://github.com/mattpocock/skills

capability 목록 생략은 0개가 아니라 "알 수 없음"으로 처리되어 폴백을 비활성화합니다. 스킬이 하나라도 있어도 비활성화됩니다. 수동 CLI 사용은 `guide context ... --no-client-skills`로 같은 조건을 명시해야 합니다. `disable-model-invocation: true`로 표시된 스킬은 자동 선택에서 제외됩니다.

가져온 각 항목에는 저장소, commit SHA 및 소스 경로가 기록됩니다. 신뢰되지 않은 참조 자료이므로 자동으로 `verified`로 승격되거나 명령으로 실행되지 않습니다. 반복 동기화는 콘텐츠 해시를 통해 멱등성을 유지합니다.

## 로컬 Web UI

루프백 전용 HTTP 서버를 시작하면 역할과 용도, 메모리 유형 및 교차 태그별로 메모리 항목을 탐색하고 브라우저에서 candidate 항목을 편집할 수 있습니다.

```bash
kiokuko web
# http://127.0.0.1:4173 열기
```

UI는 영어, 일본어, 중국어 간체 및 한국어를 지원합니다. 처음에는 브라우저 언어를 사용하고 명시적으로 선택한 언어는 브라우저에 저장합니다. `?lang=en`, `?lang=ja`, `?lang=zh-CN`, `?lang=ko`로 재정의할 수도 있습니다.

`--port 0`을 사용하면 사용 가능한 포트를 자동으로 선택하고, `--json`을 사용하면 선택된 URL을 JSON으로 출력합니다. Web UI는 루프백이 아닌 인터페이스에 서버를 노출하지 않습니다. verified 및 superseded 항목은 읽기 전용이며 candidate 편집에는 낙관적 리비전 검사를 사용하고 감사 기록을 유지합니다.

`bot:researcher`, `bot:builder`, `bot:reviewer` 같은 태그를 유형 간 필터로 사용할 수 있습니다. 항목 또는 사이드바의 태그를 클릭하면 메모리 유형과 관계없이 일치하는 모든 항목을 표시합니다.

메모리 항목은 신뢰되지 않은 저장 데이터입니다. 과거 항목을 사용하기 전에 현재 파일과 런타임 상태를 확인하십시오. 비밀번호, API 키, 토큰, 개인 키 또는 세션 쿠키를 저장하지 마십시오.

이 저장소는 자동으로 게시되지 않습니다. `npm publish`, commit 및 push에는 사용자의 명시적 승인이 필요합니다.
