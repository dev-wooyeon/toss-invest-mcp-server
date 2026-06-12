# toss-invest-mcp-server

[한국어](README.md) | [English](README.en.md)

토스증권 공식 Open API를 로컬 MCP 서버로 연결해 ChatGPT, Codex, Claude Desktop 같은 MCP 클라이언트에서 사용할 수 있게 하는 설치형 오픈소스 프로젝트입니다.

이 프로젝트의 기본 배포 모델은 **원격 서버 운영이 아니라 사용자 로컬 실행**입니다. 각 사용자의 `ClientId`와 `Secret`은 사용자의 머신 또는 MCP 클라이언트 환경변수에만 존재해야 하며, 이 프로젝트나 운영자가 수집하지 않습니다.

## LLM 설치 컨텍스트

LLM 에이전트가 사용자의 개발 환경에 이 MCP 서버를 설치할 때는 이 섹션을 우선 읽으세요.

### 기본 원칙

- 사용자의 `TOSSINVEST_CLIENT_ID`, `TOSSINVEST_CLIENT_SECRET` 값을 채팅에 노출하거나 tool input으로 전달하지 마세요.
- 기본 실행 방식은 stdio MCP입니다.
- 기본 거래 모드는 `READ_ONLY`입니다.
- `LIVE_TRADING`은 사용자가 명시적으로 요구하고 주문 한도/allowlist/blocklist를 설정한 뒤에만 사용하세요.
- `.env.local`, `node_modules`, `dist`, `audit`은 git에 올리지 마세요.

### Git clone 설치

```bash
git clone https://github.com/dev-wooyeon/toss-invest-mcp-server.git
cd toss-invest-mcp-server
npm install
npm run build
npm run verify
```

환경변수 파일을 사용할 경우:

```bash
cp .env.example .env.local
```

`.env.local`:

```bash
TOSSINVEST_CLIENT_ID="..."
TOSSINVEST_CLIENT_SECRET="..."
TOSSINVEST_ACCOUNT="1"
TOSSINVEST_TRADING_MODE="READ_ONLY"
```

### Codex MCP 등록

clone한 로컬 경로를 사용하는 방식:

```bash
codex mcp add toss-invest \
  --env TOSSINVEST_CLIENT_ID="..." \
  --env TOSSINVEST_CLIENT_SECRET="..." \
  --env TOSSINVEST_ACCOUNT="1" \
  --env TOSSINVEST_TRADING_MODE="READ_ONLY" \
  -- node /absolute/path/to/toss-invest-mcp-server/dist/index.js
```

npm 패키지로 공개된 뒤에는 다음 방식도 사용할 수 있습니다.

```bash
codex mcp add toss-invest \
  --env TOSSINVEST_CLIENT_ID="..." \
  --env TOSSINVEST_CLIENT_SECRET="..." \
  --env TOSSINVEST_ACCOUNT="1" \
  --env TOSSINVEST_TRADING_MODE="READ_ONLY" \
  -- npx -y toss-invest-mcp-server
```

npm 공개 전 GitHub 소스에서 직접 실행하려면:

```bash
codex mcp add toss-invest \
  --env TOSSINVEST_CLIENT_ID="..." \
  --env TOSSINVEST_CLIENT_SECRET="..." \
  --env TOSSINVEST_ACCOUNT="1" \
  --env TOSSINVEST_TRADING_MODE="READ_ONLY" \
  -- npx -y github:dev-wooyeon/toss-invest-mcp-server
```

### Claude Desktop 설정 예시

```json
{
  "mcpServers": {
    "toss-invest": {
      "command": "node",
      "args": [
        "/absolute/path/to/toss-invest-mcp-server/dist/index.js"
      ],
      "env": {
        "TOSSINVEST_CLIENT_ID": "your-client-id",
        "TOSSINVEST_CLIENT_SECRET": "your-client-secret",
        "TOSSINVEST_ACCOUNT": "1",
        "TOSSINVEST_TRADING_MODE": "READ_ONLY"
      }
    }
  }
}
```

### 설치 확인

MCP 클라이언트에서 다음 도구를 호출해 설정 상태만 확인하세요. 이 도구는 secret/token 값을 반환하지 않습니다.

```text
toss_invest_auth_status
```

정상이라면 다음 값이 `true`입니다.

- `hasClientId`
- `hasClientSecret`
- `hasDefaultAccount`

## 사람을 위한 소개

이 MCP 서버는 토스증권 Open API를 “AI가 안전하게 호출할 수 있는 도구 모음”으로 감싸는 프로젝트입니다. 사용자는 자신의 Open API 키를 로컬에만 저장하고, AI에게는 도구 호출 권한만 제공합니다.

예를 들어 다음과 같은 요청을 할 수 있습니다.

```text
내 계좌 분석하고 스페이스X 편입 구조 기준으로 SOL 미국우주항공TOP10 리밸런싱 가이드해줘.
```

```text
현재 보유 종목의 평가손익, 현금 비중, 미체결 주문, 매수 가능 금액을 요약해줘.
```

```text
삼성전자 10주 지정가 매수를 넣기 전에 주문 가능 금액, 상하한가, 수수료, 장 상태를 먼저 점검해줘.
```

실제 주문은 기본적으로 막혀 있습니다. AI가 바로 주문을 넣는 구조가 아니라, 먼저 계좌/시세/주문 가능성을 확인하고 사용자가 명시적으로 허용한 경우에만 실제 주문 도구가 열립니다.

## 제공 기능

### 메타데이터 도구

- `toss_invest_auth_status`
- `toss_invest_list_operations`
- `toss_invest_get_operation`

### 상위 워크플로우 도구

- `toss_invest_stock_snapshot`: 종목 정보, 현재가, 상하한가, 유의사항 조회
- `toss_invest_market_status`: 국내/미국 장 운영 정보 조회
- `toss_invest_portfolio_snapshot`: 계좌, 보유 종목, 수수료, 미체결 주문 조회
- `toss_invest_account_risk_summary`: 보유 종목 기반 계좌 리스크 요약
- `toss_invest_order_preflight`: 주문 전 시세/계좌/정책 점검
- `toss_invest_create_order_dry_run`: 실제 주문 없이 주문 요청 본문과 사전 점검 결과 생성

### OpenAPI 기반 도구

공식 OpenAPI operationId를 기준으로 다음 도구를 제공합니다.

- `toss_invest_get_orderbook`
- `toss_invest_get_prices`
- `toss_invest_get_trades`
- `toss_invest_get_price_limit`
- `toss_invest_get_candles`
- `toss_invest_get_stocks`
- `toss_invest_get_stock_warnings`
- `toss_invest_get_exchange_rate`
- `toss_invest_get_kr_market_calendar`
- `toss_invest_get_us_market_calendar`
- `toss_invest_get_accounts`
- `toss_invest_get_holdings`
- `toss_invest_get_orders`
- `toss_invest_get_order`
- `toss_invest_get_buying_power`
- `toss_invest_get_sellable_quantity`
- `toss_invest_get_commissions`
- `toss_invest_create_order`
- `toss_invest_modify_order`
- `toss_invest_cancel_order`

OAuth token 발급 엔드포인트는 MCP 도구로 노출하지 않습니다. 서버 내부에서만 토큰을 발급하고 메모리에 캐시합니다.

## 보안 모델

사용자는 토스증권 Open API `ClientId`와 `Secret`을 직접 발급받아야 합니다.

이 서버는 `ClientId`, `Secret`, access token, 기본 `accountSeq` 환경변수 값을 수집, 저장, 출력, 반환하지 않습니다. 인증 정보는 MCP 서버 프로세스의 환경변수에서만 읽습니다.

지원 거래 모드:

- `READ_ONLY`: 기본값. 조회 도구와 preflight/dry-run 도구만 사용합니다.
- `DRY_RUN`: 주문 준비 워크플로우는 허용하지만 실제 주문 엔드포인트는 차단합니다.
- `LIVE_TRADING`: 실제 주문 생성, 정정, 취소 엔드포인트 호출을 허용합니다.

`LIVE_TRADING`에서도 다음 조건을 만족해야 실제 주문 mutation 도구가 실행됩니다.

- 서버 환경변수 `TOSSINVEST_TRADING_MODE=LIVE_TRADING`
- 도구 입력값 `confirmTrading: true`
- 로컬 정책 엔진 통과

정책 환경변수:

- `TOSSINVEST_ALLOWED_SYMBOLS`
- `TOSSINVEST_BLOCKED_SYMBOLS`
- `TOSSINVEST_MAX_ORDER_AMOUNT_KRW`
- `TOSSINVEST_MAX_ORDER_AMOUNT_USD`
- `TOSSINVEST_REQUIRE_CLIENT_ORDER_ID`
- `TOSSINVEST_ALLOW_MARKET_ORDER_WITHOUT_PRICE`

감사 로그는 로컬 JSONL 파일로 남으며 기본 경로는 `audit/toss-invest-mcp-audit.jsonl`입니다. 감사 로그에는 ClientId, Secret, access token, 원본 계좌 값이 기록되지 않습니다.

## 기술 아키텍처

```text
MCP Client
  └─ stdio
      └─ toss-invest-mcp-server
          ├─ MCP tools/resources
          ├─ workflow layer
          ├─ policy layer
          ├─ Toss OpenAPI client
          ├─ OAuth token cache
          └─ Toss Invest Open API
```

구성:

- Runtime: Node.js
- Language: TypeScript
- MCP SDK: `@modelcontextprotocol/sdk`
- Validation: `zod`
- 기본 transport: stdio
- 선택 transport: Streamable HTTP, 로컬/self-host 용도
- OpenAPI source: `spec/openapi.json`

주요 모듈:

- `src/index.ts`: stdio/HTTP 실행 진입점
- `src/server.ts`: MCP tool/resource 등록
- `src/client.ts`: Toss Open API HTTP client, OAuth token cache, retry, error normalization
- `src/workflows.ts`: 계좌/종목/주문 사전 점검 상위 도구
- `src/policy.ts`: 거래 모드와 주문 정책 엔진
- `src/audit.ts`: 민감정보를 제외한 로컬 감사 로그
- `src/spec.ts`: OpenAPI 문서 로딩과 tool schema 생성
- `src/env.ts`: `.env`, `.env.local`, `TOSSINVEST_ENV_FILE` 로딩

## 안정성 동작

- 429와 5xx 응답은 제한된 지수 백오프로 재시도합니다.
- `Retry-After` 헤더가 있으면 우선 적용합니다.
- Toss 에러 envelope은 `status`, `code`, `message`, `requestId`, `retryAfter`를 포함한 `error` 객체로 정규화합니다.
- OpenAPI query/path 입력값은 enum, regex pattern, min/max 제약을 가능한 범위에서 검증합니다.
- 토스증권 Open API는 client당 유효 access token이 1개이므로, 동시 요청 시 OAuth 토큰 발급은 single-flight로 한 번만 수행합니다.

## 호출 예시

현재가 조회:

```json
{
  "symbols": "005930,AAPL"
}
```

`TOSSINVEST_ACCOUNT` 기본 계좌로 보유 종목 조회:

```json
{
  "symbol": "005930"
}
```

주문 dry-run:

```json
{
  "accountSeq": 1,
  "body": {
    "clientOrderId": "my-order-001",
    "symbol": "005930",
    "side": "BUY",
    "orderType": "LIMIT",
    "quantity": "10",
    "price": "70000"
  }
}
```

실제 주문은 `LIVE_TRADING` 모드에서 의도적으로 활성화한 경우에만 사용하세요.

```json
{
  "accountSeq": 1,
  "confirmTrading": true,
  "body": {
    "clientOrderId": "my-order-001",
    "symbol": "005930",
    "side": "BUY",
    "orderType": "LIMIT",
    "quantity": "10",
    "price": "70000"
  }
}
```

## 실제 주문 체크리스트

`TOSSINVEST_TRADING_MODE=LIVE_TRADING`을 설정하기 전에 최소한 다음 정책을 먼저 정하세요.

```bash
TOSSINVEST_REQUIRE_CLIENT_ORDER_ID=true
TOSSINVEST_MAX_ORDER_AMOUNT_KRW=1000000
TOSSINVEST_MAX_ORDER_AMOUNT_USD=1000
TOSSINVEST_BLOCKED_SYMBOLS=
TOSSINVEST_ALLOWED_SYMBOLS=
```

각 실제 주문 호출에는 `confirmTrading: true`를 전달해야 합니다. KRW 기준 고액 주문은 토스증권 API 요구사항에 따라 주문 body에 `confirmHighValueOrder: true`도 필요합니다.

## 공식 API 기준

번들된 API 기준 문서는 다음 공식 자료입니다.

- https://developers.tossinvest.com/llms.txt
- https://openapi.tossinvest.com/openapi-docs/overview.md
- https://openapi.tossinvest.com/openapi-docs/latest/openapi.json

OpenAPI 스펙 갱신:

```bash
curl -fsSL https://openapi.tossinvest.com/openapi-docs/latest/openapi.json -o spec/openapi.json
npm run build
```
