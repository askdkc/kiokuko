# 설정 및 문제 해결

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

### 저장소 지침 파일

`kiokuko use`는 저장소의 `AGENTS.md` 또는 설정한 지침 파일에 짧고 안정적인 참조를 두며,
생성된 지침은 `.kiokuko/AGENTS.md`에 저장합니다. 템플릿과 저장소 식별 정보의 변경은 생성 파일에 반영하고,
이전 버전의 관리 블록은 다음 use/setup 갱신에서 참조로 바뀝니다. 사용자 지침은 Kiokuko 관리 마커 밖에 두십시오.
사용자 텍스트와 다른 제품의 영역은 보존합니다.

일반 setup은 누락된 루트 지침 파일을 건너뜁니다. 일반 `kiokuko doctor`는 등록된 저장소에서 누락된
루트 지침 및 생성 지침 파일을 TTY와 비TTY 실행 모두에서 확인 대기나 추가 복구 플래그 없이 자동 생성합니다.
등록된 저장소 ID, workspace, binding, 정규 경로가 일치해야 합니다. 없는 파일만 생성하고 기존 사용자 내용을 보존하며,
삭제된 사용자 지침을 복원할 수는 없습니다. 권한 부족, 안전하지 않은 심볼릭 링크, 동시 변경은 대상별로 보고하고
다른 대상의 처리를 계속합니다. 누락되거나 충돌하는 binding은 추측해서 대체하지 않고 진단합니다.

```bash
kiokuko doctor
kiokuko doctor --json
kiokuko doctor --fix --repair-root /absolute/path/to/project
```

`kiokuko doctor --json`은 누락된 지침을 생성하지 않고 진단합니다. `--fix`는 등록된 binding을 명시적으로 복구하는 모드이며,
`--repair-root`에는 `--fix`가 필요합니다. `--fix --json`도 binding 복구를 수행합니다.
기존 관리 영역의 갱신은 별도의 대화형 확인이 필요하며 비TTY 실행은 승인으로 간주하지 않습니다.
누락된 생성 지침은 use/setup으로도 복원할 수 있습니다. 제거 시 두 파일에서 Kiokuko 관리 영역만 삭제합니다.
자세한 내용은 [CLI 계약(영문)](cli-contract.md)을 참조하십시오.

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
[삭제 범위](cli-contract.md#uninstall)를 참고하세요.

<a id="chatgpt"></a>

## ChatGPT에서 사용하기(미리 보기)

Developer mode에서 개인용 플러그인으로 연결해 기억을 저장하고 검색합니다. 스토어 배포 버전은 없습니다.

1. **Kiokuko를 준비합니다.** `kiokuko mcp --help`에 `--profile`과 `--access`가 있는 버전을 사용합니다. 없다면 [소스에서 설치](chatgpt.md)합니다. DB가 없으면 `kiokuko init`을 실행합니다.
2. **Tunnel 클라이언트를 설치합니다.** macOS에서는 [공식 Homebrew 설치 방법](https://github.com/openai/tunnel-client#install-with-homebrew)을 사용합니다.

   ```bash
   brew install openai/tools/tunnel-client
   tunnel-client --version
   ```

   다른 OS는 [공식 배포 페이지](https://github.com/openai/tunnel-client/releases/latest)를 참고합니다. [Tunnel 설정](https://platform.openai.com/settings/organization/tunnels)에서 ChatGPT workspace에 연결된 Tunnel ID와 Tunnels Read + Use 권한이 있는 [실행용 API 키](https://platform.openai.com/settings/organization/api-keys)를 준비합니다.

3. **컴퓨터에서 연결을 시작합니다.** `<tunnel_id>`와 `<runtime_api_key>`를 발급받은 값으로 바꿉니다.

   ```bash
   export CONTROL_PLANE_API_KEY="<runtime_api_key>"
   tunnel-client init \
     --sample sample_mcp_stdio_local \
     --profile kiokuko-chatgpt \
     --tunnel-id "<tunnel_id>" \
     --mcp-command "kiokuko mcp --profile chatgpt-memory --access read-write"
   tunnel-client doctor --profile kiokuko-chatgpt --explain
   kiokuko chatgpt run --profile kiokuko-chatgpt
   ```

   사용하는 동안 계속 실행해 둡니다. 새 터미널에서는 API 키를 다시 설정한 뒤 마지막 `run` 명령을 실행합니다.

4. **ChatGPT에 등록합니다.** **Settings → Security and login → Developer mode**를 켭니다. **Plugins → ＋**에서 이름을 `Kiokuko`, 설명을 “기억 저장 및 검색”으로 입력하고 **Connection → Tunnel**에 같은 ID를 지정합니다. 새 대화의 도구 메뉴에서 Kiokuko를 선택합니다. [공식 화면 안내](https://developers.openai.com/plugins/deploy/connect-chatgpt)

사용 예: “이 내용을 Kiokuko에 저장해 줘” 또는 “Kiokuko에서 [주제]에 관한 기억을 찾아 줘”. 쓰기 확인이 나오면 내용을 확인하고 승인합니다.

검색만 사용하려면 실행 명령의 `read-write`를 `read`로 바꿉니다. ChatGPT 기본 메모리의 저장소는 바뀌지 않습니다. **ChatGPT 실제 연결 시험은 아직 하지 않았습니다.** [문제 해결](chatgpt.md)

