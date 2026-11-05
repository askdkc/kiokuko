# Kiokuko (記憶庫)

[English](README.md) | [日本語](README.ja.md) | [简体中文](README.zh-CN.md) | 한국어

AI 에이전트를 위한 로컬 메모리입니다. 선호 사항, 결정, 수정 내용을 SQLite에
저장하고 MCP를 통해 관련 문맥을 검색합니다.

**Codex, OpenCode, Claude Code, Hermes Agent**를 지원합니다.
[ChatGPT 연결은 미리 보기 버전입니다](docs/setup-notes.ko.md#chatgpt).

## 설치

Node.js **24.16.0 이상**이 필요합니다.

```bash
npm i -g kiokuko
kiokuko setup
```

클라이언트를 재시작하세요. 임베딩 모델 설정을 건너뛸 때만
`--no-embeddings`를 추가하세요.

1.0 이전 버전에서 업데이트하려면 새 데이터베이스가 필요합니다.
[마이그레이션 및 이전 설정 정리](docs/breaking-changes-1.0.md).

### Codex 데스크톱 기록 (macOS)

Codex에 프로젝트를 추가한 뒤 어느 디렉터리에서든 실행하세요.

```bash
kiokuko setup --clients codex --codex-dock-record
```

Codex에 추가한 Git 프로젝트만 기록됩니다. 기록 대상에 없는 프로젝트는 Codex에
추가한 뒤 위 명령을 다시 실행하세요. 기존 채팅만으로는 등록되지 않습니다.
Codex를 완전히 종료하고 Dock에서 다시 실행하세요. 이후 추가한 프로젝트도
처음 사용할 때 등록됩니다. 기억은 승인 후에만 저장됩니다.

## 문서

<a id="setup-messages"></a>

- [시작하기 (영문)](docs/getting-started.md)
- [설정, 문제 해결 및 제거](docs/setup-notes.ko.md)
- [메모리와 검색 (영문)](docs/concepts.md)
- [이력과 코드 증거 (영문)](docs/history-evidence.md)
- [전체 문서 (영문)](docs/README.md)

저장된 기억은 틀릴 수 있습니다. 비밀 정보로 보이는 내용은 거부하고 전체 대화는
저장하지 않습니다. MCP 호출은 클라이언트와 모델의 판단에 달려 있습니다.
[보안과 신뢰 (영문)](docs/security-and-trust.md).
