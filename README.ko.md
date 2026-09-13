# Kiokuko (記憶庫)

1.0에서는 기존 DB를 지원하지 않습니다. 새 DB를 사용하세요. [주요 변경 사항과 이전 설정 제거](docs/breaking-changes-1.0.md)를 확인하세요。

[English](README.md) | [日本語](README.ja.md) | [简体中文](README.zh-CN.md) | 한국어

**MCP로 연결하고, 필요한 기억을 검색하고, 작업 후 지식을 축적합니다.**

Kiokuko는 AI 코딩 에이전트를 위한 로컬 외부 메모리입니다. 지식을 SQLite에 저장하고 다음 작업에 관련된 문맥을 검색하며,
재사용 가능한 결과를 기록합니다.

```text
요청 → MCP 연결 → 관련 기억 검색 → 작업 수행
                             ↓
                         재사용 지식 저장
```

기억은 Project·Ecosystem·Global로 분리되고 현재 코드, 설정, 실행 결과가 과거 기억보다 우선합니다.

## 빠른 시작

Node.js 24.16.0 이상이 필요합니다（Node.js 26.1.0 이상도 지원）.

```bash
npm install --global @askdkc/kiokuko
kiokuko setup
```

`setup`은 데이터베이스, 표준 Skill, MCP 연결과 로컬 semantic 검색을 설정합니다.
처음 실행할 때 임베딩 런타임과 모델을 설치합니다. 이미 실행 중인 클라이언트는
설정 후 재시작하십시오. 정확한 규칙은 [영문 Getting started](docs/getting-started.md)를 참조하십시오.

임베딩 런타임과 모델을 설치하지 않고 클라이언트만 설정하려면:

```bash
kiokuko setup --no-embeddings
```

임베딩 설정 단계를 건너뛰며 기존 임베딩 설정은 변경하지 않습니다.

<a id="setup-messages"></a>

### npm 알림과 설정 오류

`install scripts not yet covered by allowScripts`는 해당 의존성 스크립트의 실행 승인이 npm에 기록되지 않았다는 뜻입니다.
`esbuild`는 빌드 도구이고, `fsevents`는 macOS 파일 감시에 사용됩니다. 이 알림만으로 설정이 실패했다고 볼 수는 없습니다.

알림이 발생한 패키지 디렉터리에서 확인하세요.

```bash
npm install-scripts ls
```

`esbuild`와 `fsevents`가 표시되고, 스크립트를 검토한 뒤 실행을 허용하려면 다음 명령으로 승인을 기록하세요.

```bash
npm install-scripts approve esbuild fsevents
```

승인은 해당 디렉터리의 `package.json`에 저장됩니다. macOS에 Kiokuko를 전역 설치했다면 오류에 표시된 Kiokuko 설치 디렉터리에서 실행하세요.
다른 프로젝트에서 실행하면 그 프로젝트의 승인 설정을 조회하고 변경합니다.
자세한 내용은 [npm 스크립트 승인 안내](https://docs.npmjs.com/cli/v11/commands/npm-install-scripts/)를 참조하세요.

설정이 `Local semantic retrieval dependencies remain unavailable`과 `Cannot find package ... @huggingface/hub/index.js`로 끝나면,
임베딩 런타임을 불러오지 못해 semantic 검색 설정이 완료되지 않은 상태입니다. 스크립트 승인으로 이 불러오기 오류가 해결되는지는 확인되지 않았습니다.
도움을 요청할 때는 전체 오류와 `kiokuko --version`, `node --version`, `npm --version`의 출력을 첨부하세요.

## 제거

Kiokuko를 사용하는 클라이언트와 `kiokuko serve`를 먼저 종료하세요.

```bash
kiokuko uninstall --dry-run
kiokuko uninstall
# 모든 에이전트를 선택하고 정리가 완료되면 표시된 명령을 실행합니다:
npm uninstall --global kiokuko
```

↑↓로 이동하고 Space로 선택을 전환하며 Enter로 확정하고 Esc로 취소합니다. 처음에는 모두 선택 해제되어 있습니다.
선택한 에이전트의 관리 설정과 Skill을 제거합니다. **4개 에이전트를 모두 선택하면 기억 DB, 임베딩 모델, 프로젝트 연결도 삭제**하고 npm 제거 명령을 표시합니다. 일부만 선택하면 공유 데이터와 npm 패키지를 유지합니다. 사용자 내용은 보존합니다.
스크립트에서는 `kiokuko uninstall --clients opencode,claude`, 완전 제거에는 `kiokuko uninstall --all`을 사용하세요. 사용자 지정 경로는 setup과 같은 환경 변수로 실행하세요.
[삭제 범위](docs/cli-contract.md#uninstall)를 참고하세요.

## 주요 기능

- RAG 기억（lexical 검색과 `setup`으로 구성하는 로컬 semantic 검색）
- 모호한 요청을 구체화하는 Akinator
- 기억을 검토하는 로컬 Web UI
- 자동 실행하지 않는 검증된 참조 전용 External Skill

`kiokuko embeddings setup`은 `kiokuko setup`과 동일한 처리를 하는 호환 명령으로 유지됩니다.

managed MCP block과 프로젝트 instructions를 갱신합니다. unmanaged identity 교체는 대화형 확인 후에만 수행되며,
비대화형 또는 `--dry-run --json` 실행은 변경 없이 fail closed합니다. 자세한 내용은 [영문 semantic retrieval](docs/semantic-retrieval.md)을 보십시오.

## 지원 클라이언트

Codex, OpenCode, Claude Code, Hermes Agent.

## 안전성과 제한

전체 대화를 저장하지 않으며 비밀번호, API key, token, private key처럼 보이는 내용은 거부합니다. 기억은 참고 정보이므로 현재 코드와 실행 결과를 확인하십시오.

MCP 호출 여부는 클라이언트와 모델이 결정하므로 **모든 턴에서 Kiokuko가 호출된다는 보장은 없습니다**. 자세한 신뢰 경계는 [영문 Security and trust](docs/security-and-trust.md)를 참조하십시오.

## 자세한 문서

[영문 문서 목차](docs/README.md)에서 Getting started, Concepts, Semantic retrieval, Security and trust와 구현자용 문서로 이동할 수 있습니다.
