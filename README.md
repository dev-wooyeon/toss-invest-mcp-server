# toss-invest-mcp-server

[한국어](README.md) | [English](README.en.md)

토스증권 공식 Open API를 로컬 MCP 서버로 연결해 ChatGPT, Codex, Claude Desktop 같은 MCP 클라이언트에서 사용할 수 있게 하는 설치형 오픈소스 프로젝트입니다.

이 프로젝트의 기본 배포 모델은 **원격 서버 운영이 아니라 사용자 로컬 실행**입니다. 각 사용자의 `ClientId`와 `Secret`은 사용자의 머신 또는 MCP 클라이언트 환경변수에만 존재해야 하며, 이 프로젝트나 운영자가 수집하지 않습니다.

## LLM 설치 컨텍스트

LLM 에이전트가 사용자의 개발 환경에 이 MCP 서버를 설치할 때는 이 섹션을 우선 읽으세요.

### 기본 원칙

- 사용자의 `TOSSINVEST_CLIENT_ID`, `TOSSINVEST_CLIENT_SECRET` 값을 채팅에 노출하거나 MCP 도구 입력값으로 전달하지 마세요.
- 기본 실행 방식은 stdio MCP입니다.
- 기본 거래 모드는 `READ_ONLY`입니다.
- `LIVE_TRADING`은 사용자가 명시적으로 요구하고 주문 한도와 허용/차단 목록을 설정한 뒤에만 사용하세요.
- `.env.local`, `node_modules`, `dist`, `audit`은 Git에 올리지 마세요.

### Git clone으로 설치

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

클론한 로컬 경로를 사용하는 방식:

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

npm에 공개되기 전 GitHub 소스에서 직접 실행하려면:

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

MCP 클라이언트에서 다음 도구를 호출해 설정 상태만 확인하세요. 이 도구는 Secret이나 access token 값을 반환하지 않습니다.

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

이 서버는 번들된 `spec/openapi.json`의 `operationId`를 기준으로 MCP 도구를 제공합니다. 토스증권 Open API의 기능과 실제 호출 가능한 MCP 도구가 어떻게 연결되는지는 아래 표에서 확인할 수 있습니다.

### OpenAPI 기반 도구 매핑

| 토스증권 API 기능 | operationId | MCP 도구 | 비고 |
|---|---|---|---|
| OAuth2 액세스 토큰 발급 | `issueOAuth2Token` | 미노출 | 서버 내부 인증에만 사용 |
| 호가 조회 | `getOrderbook` | `toss_invest_get_orderbook` | 조회 |
| 현재가 조회 | `getPrices` | `toss_invest_get_prices` | 조회 |
| 최근 체결 내역 조회 | `getTrades` | `toss_invest_get_trades` | 조회 |
| 상/하한가 조회 | `getPriceLimit` | `toss_invest_get_price_limit` | 조회 |
| 캔들 차트 조회 | `getCandles` | `toss_invest_get_candles` | 조회 |
| 종목 기본 정보 조회 | `getStocks` | `toss_invest_get_stocks` | 조회 |
| 매수 유의사항 조회 | `getStockWarnings` | `toss_invest_get_stock_warnings` | 조회 |
| 환율 조회 | `getExchangeRate` | `toss_invest_get_exchange_rate` | 조회 |
| 국내 장 운영 정보 조회 | `getKrMarketCalendar` | `toss_invest_get_kr_market_calendar` | 조회 |
| 해외 장 운영 정보 조회 | `getUsMarketCalendar` | `toss_invest_get_us_market_calendar` | 조회 |
| 계좌 목록 조회 | `getAccounts` | `toss_invest_get_accounts` | 조회 |
| 보유 주식 조회 | `getHoldings` | `toss_invest_get_holdings` | 조회 |
| 주문 목록 조회 | `getOrders` | `toss_invest_get_orders` | 조회 |
| 주문 상세 조회 | `getOrder` | `toss_invest_get_order` | 조회 |
| 매수 가능 금액 조회 | `getBuyingPower` | `toss_invest_get_buying_power` | 조회 |
| 판매 가능 수량 조회 | `getSellableQuantity` | `toss_invest_get_sellable_quantity` | 조회 |
| 매매 수수료 조회 | `getCommissions` | `toss_invest_get_commissions` | 조회 |
| 주문 생성 | `createOrder` | `toss_invest_create_order` | 실제 주문, 기본 차단 |
| 주문 정정 | `modifyOrder` | `toss_invest_modify_order` | 실제 주문, 기본 차단 |
| 주문 취소 | `cancelOrder` | `toss_invest_cancel_order` | 실제 주문, 기본 차단 |

### 상위 워크플로우 도구

상위 워크플로우 도구는 토스증권 Open API 여러 개를 묶어 한 번에 확인하기 위한 편의 도구입니다. 실제 주문을 실행하지 않는 점검 도구는 `READ_ONLY`나 `DRY_RUN` 모드에서도 사용할 수 있습니다.

| MCP 도구 | 조합하는 OpenAPI operation | 용도 |
|---|---|---|
| `toss_invest_stock_snapshot` | `getStocks`, `getPrices`, `getPriceLimit`, `getStockWarnings` | 종목 정보, 현재가, 상/하한가, 매수 유의사항을 한 번에 조회 |
| `toss_invest_market_status` | `getKrMarketCalendar`, `getUsMarketCalendar` | 국내/미국 장 운영 정보 조회 |
| `toss_invest_portfolio_snapshot` | `getAccounts`, `getHoldings`, `getCommissions`, `getOrders` | 계좌, 보유 종목, 수수료, 미체결 주문 조회 |
| `toss_invest_account_risk_summary` | `getHoldings`, `getBuyingPower`, `getOrders` | 보유 종목, 매수 가능 금액, 미체결 주문 기반 요약 |
| `toss_invest_order_preflight` | `getStocks`, `getPrices`, `getPriceLimit`, `getStockWarnings`, `getCommissions`, `getBuyingPower`, `getSellableQuantity`, `getKrMarketCalendar`, `getUsMarketCalendar`, `getOrders` | 주문 전 시세, 계좌, 장 상태, 로컬 정책 점검 |
| `toss_invest_create_order_dry_run` | 위 항목과 동일 | 실제 주문 없이 주문 요청 본문과 점검 결과 생성 |

### 메타데이터 도구

MCP 클라이언트 안에서도 지원 범위와 입력 스키마를 확인할 수 있습니다.

- `toss_invest_auth_status`: 인증 설정 상태 확인
- `toss_invest_list_operations`: 지원하는 OpenAPI operation과 MCP 도구 목록 조회
- `toss_invest_get_operation`: 특정 operation의 입력 스키마와 예시 조회

## 보안 모델

사용자는 토스증권 Open API `ClientId`와 `Secret`을 직접 발급받아야 합니다.

이 서버는 `ClientId`, `Secret`, access token, 기본 `accountSeq` 환경변수 값을 수집, 저장, 출력, 반환하지 않습니다. 인증 정보는 MCP 서버 프로세스의 환경변수에서만 읽습니다.

지원 거래 모드:

- `READ_ONLY`: 기본값. 조회, 사전 점검, dry-run 도구만 사용합니다.
- `DRY_RUN`: 주문 준비 워크플로우는 허용하지만 실제 주문 엔드포인트는 차단합니다.
- `LIVE_TRADING`: 실제 주문 생성, 정정, 취소 엔드포인트 호출을 허용합니다.

`LIVE_TRADING`에서도 다음 조건을 만족해야 주문 생성, 정정, 취소 도구가 실행됩니다.

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

실제 주문 없는 주문 준비(dry-run):

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

각 실제 주문 호출에는 `confirmTrading: true`를 전달해야 합니다. KRW 기준 고액 주문은 토스증권 API 요구사항에 따라 주문 본문에 `confirmHighValueOrder: true`도 포함해야 합니다.

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
