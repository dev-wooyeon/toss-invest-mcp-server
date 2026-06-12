# AGENTS.md

## Codex 작업 규칙

- 사용자의 `TOSSINVEST_CLIENT_ID`, `TOSSINVEST_CLIENT_SECRET` 값을 채팅에 노출하거나 MCP 도구 입력값으로 전달하지 마세요.
- 기본 거래 모드는 `READ_ONLY`로 유지하세요.
- `LIVE_TRADING`은 사용자가 명시적으로 요구하고 주문 한도와 허용/차단 목록을 설정한 경우에만 사용하세요.
- `.env.local`, `node_modules`, `dist`, `audit`은 Git에 올리지 마세요.

## 커밋 규칙

커밋을 작성할 때는 항상 Angular Conventional Commit 형식을 따르고, 커밋 메시지는 한국어로 작성하세요.

```text
<type>(<domain>): <한글 요약>

<변경 이유와 방식>
```

- 커밋 헤더는 `type(domain): 한글 요약` 형식으로 작성하세요.
- `domain`은 Conventional Commit의 scope 자리에 들어가는 값입니다. 변경된 모듈이나 책임 영역을 쓰고 생략하지 마세요.
- 헤더는 50자 이내로 작성하고 마침표를 붙이지 마세요.
- 헤더는 완전한 문장보다 핵심 변경을 드러내는 명사구로 요약하세요.
- `type`은 `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`, `perf`, `ci` 중 하나만 사용하세요.
- `domain`은 `mcp`, `openapi`, `workflow`, `policy`, `audit`, `env`, `docs`, `infra`, `convention`처럼 저장소의 실제 변경 범위에 맞게 고르세요.
- 기술 용어와 코드 식별자는 원어를 유지하고, 나머지 설명은 한국어로 작성하세요.
- 본문에는 변경 이유와 방식을 한국어 문장으로 설명하세요. 사소한 변경이 아니라면 본문을 비우지 마세요.

좋은 예:

```text
docs(convention): 커밋 규칙 한국어 가이드 추가

Codex가 영어 커밋 메시지를 만들면서
규칙이 일관되지 않은 문제가 있었습니다.

Angular Conventional Commit 형식은 유지하되
헤더와 본문을 한국어로 작성하도록 규칙을 명시했습니다.
```

나쁜 예:

```text
docs: update commit rules
chore: fix stuff
fix(policy): 정책 오류를 수정했습니다.
```

각각 `domain` 누락, 불명확한 요약, 문장형 헤더와 마침표 때문에 피해야 하는 예시입니다.
