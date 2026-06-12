# toss-invest-mcp-server

[한국어](README.md) | [English](README.en.md)

토스증권 공식 Open API를 ChatGPT, Codex, Claude Desktop 같은 MCP 클라이언트에서 안전하게 사용하기 위한 MCP 서버입니다.

v1.0은 공식 OpenAPI 엔드포인트를 1:1 MCP 도구로 노출하는 것에 더해, 시세 컨텍스트, 포트폴리오 컨텍스트, 주문 사전 점검, 주문 dry-run 같은 상위 워크플로우 도구를 제공합니다.

번들된 API 기준 문서는 다음 공식 자료입니다.

- https://developers.tossinvest.com/llms.txt
- https://openapi.tossinvest.com/openapi-docs/overview.md
- https://openapi.tossinvest.com/openapi-docs/latest/openapi.json

## 보안 모델

사용자는 토스증권 Open API `ClientId`와 `Secret`을 직접 발급받아야 합니다.

이 서버는 `ClientId`, `Secret`, access token, 기본 `accountSeq` 환경변수 값을 수집, 저장, 출력, 반환하지 않습니다. 인증 정보는 MCP 서버 프로세스의 환경변수에서만 읽습니다.

- `TOSSINVEST_CLIENT_ID`
- `TOSSINVEST_CLIENT_SECRET`
- `TOSSINVEST_ACCOUNT`: 선택값. 계좌 API 호출 시 기본 accountSeq로 사용

OAuth access token은 메모리에만 캐시됩니다.

실제 주문 생성, 정정, 취소는 기본적으로 비활성화되어 있습니다. 지원 모드는 다음과 같습니다.

- `READ_ONLY`: 기본값. 조회 도구와 preflight/dry-run 도구만 사용합니다.
- `DRY_RUN`: 주문 준비 워크플로우는 허용하지만 실제 주문 엔드포인트는 차단합니다.
- `LIVE_TRADING`: 실제 주문 생성, 정정, 취소 엔드포인트 호출을 허용합니다. 각 호출마다 `confirmTrading: true`와 로컬 정책 검사를 요구합니다.

실제 주문을 활성화하려면 서버 프로세스에 다음 값을 명시해야 합니다.

```bash
TOSSINVEST_TRADING_MODE=LIVE_TRADING
```

모든 실제 주문 mutation 도구는 입력값에 `confirmTrading: true`도 요구합니다.

실제 주문 정책은 다음 환경변수로 제한할 수 있습니다.

- `TOSSINVEST_ALLOWED_SYMBOLS`
- `TOSSINVEST_BLOCKED_SYMBOLS`
- `TOSSINVEST_MAX_ORDER_AMOUNT_KRW`
- `TOSSINVEST_MAX_ORDER_AMOUNT_USD`
- `TOSSINVEST_REQUIRE_CLIENT_ORDER_ID`
- `TOSSINVEST_ALLOW_MARKET_ORDER_WITHOUT_PRICE`

감사 로그는 로컬 JSONL 파일로 남으며 기본 경로는 `audit/toss-invest-mcp-audit.jsonl`입니다. 감사 로그에는 ClientId, Secret, access token, 원본 계좌 값이 기록되지 않습니다.

## 설치

```bash
npm install
npm run build
npm run verify
```

## 환경변수

서버는 시작 시 `.env`, `.env.local`, `TOSSINVEST_ENV_FILE`로 지정한 파일을 자동으로 읽습니다. 셸이나 MCP 클라이언트 설정에서 이미 전달한 환경변수가 있으면 파일 값보다 우선합니다. 실제 키는 커밋하지 마세요.

권장 로컬 설정:

```bash
cp .env.example .env.local
```

그 다음 `.env.local`을 수정합니다.

```bash
TOSSINVEST_CLIENT_ID="..."
TOSSINVEST_CLIENT_SECRET="..."
TOSSINVEST_ACCOUNT="1"
TOSSINVEST_TRADING_MODE="READ_ONLY"
```

`.env.local`은 git ignore 처리되어 있습니다.

## stdio 실행

```bash
npm start
```

MCP 클라이언트 설정 예시:

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
        "TOSSINVEST_TRADING_MODE": "READ_ONLY",
        "TOSSINVEST_AUDIT_LOG": "true"
      }
    }
  }
}
```

## Streamable HTTP 실행

HTTP MCP endpoint가 필요한 클라이언트에서 사용합니다. 원격으로 노출할 경우 `MCP_HTTP_BEARER_TOKEN`을 설정하고, 단일 사용자 self-host 환경에서만 운영하는 것을 권장합니다.

```bash
MCP_HTTP_BEARER_TOKEN="change-me" npm run start:http
```

Endpoint:

```text
POST http://localhost:3000/mcp
Authorization: Bearer change-me
```

## 도구

메타데이터 도구:

- `toss_invest_auth_status`
- `toss_invest_list_operations`
- `toss_invest_get_operation`

상위 워크플로우 도구:

- `toss_invest_stock_snapshot`
- `toss_invest_market_status`
- `toss_invest_portfolio_snapshot`
- `toss_invest_account_risk_summary`
- `toss_invest_order_preflight`
- `toss_invest_create_order_dry_run`

번들된 OpenAPI operationId 기반 API 호출 도구:

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

OAuth token 발급 엔드포인트는 도구로 노출하지 않습니다. 서버 내부에서만 토큰을 발급하고 캐시합니다.

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

명시 계좌로 보유 종목 조회:

```json
{
  "accountSeq": 1,
  "symbol": "005930"
}
```

주문 dry-run. `READ_ONLY` 모드에서도 안전합니다.

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

dry-run 응답에는 다음 정보가 포함됩니다.

- `executed: false`
- `preflight.policy`
- `preflight.summary.readyForLiveOrder`
- 종목 정보, 현재가, 상하한가, 매수 가능 금액, 수수료, 장 운영 정보, 미체결 주문 같은 지원 API 점검 결과

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

## OpenAPI 스펙 갱신

```bash
curl -fsSL https://openapi.tossinvest.com/openapi-docs/latest/openapi.json -o spec/openapi.json
npm run build
```
