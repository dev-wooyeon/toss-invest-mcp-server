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
npm run verify:offline
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

`npm run verify:offline`은 dummy credential과 loopback mock API만 사용하는 기본 설치 검증입니다. 실제 자격증명을 설정한 뒤 토스증권 API 인증과 조회 경로까지 의도적으로 확인하려는 경우에만 `npm run verify`를 선택적으로 실행하세요. `npm run verify`도 거래 모드는 `READ_ONLY`로 고정하지만 실제 계좌·시장 조회 API를 호출합니다.

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

### 선택적 Streamable HTTP 실행

stdio가 기본이며, HTTP는 로컬 또는 직접 보호하는 self-hosted 환경에서만 선택적으로 사용하세요. `--http` 모드는 bearer token이 없으면 시작하지 않고 기본적으로 `127.0.0.1`에만 바인딩됩니다.

`.env.local`에 다음 값을 설정한 뒤 `npm run start:http`로 실행합니다. 실제 token 값은 채팅, Git, MCP 도구 입력에 넣지 마세요.

```bash
# 32자 이상의 암호학적 난수 사용: openssl rand -hex 32
MCP_HTTP_HOST=127.0.0.1
PORT=3000
MCP_HTTP_PATH=/mcp
MCP_HTTP_BEARER_TOKEN="<openssl rand -hex 32 출력값>"
MCP_HTTP_MAX_BODY_BYTES=1048576
MCP_HTTP_HEADERS_TIMEOUT_MS=10000
MCP_HTTP_REQUEST_TIMEOUT_MS=30000
MCP_HTTP_KEEP_ALIVE_TIMEOUT_MS=5000
MCP_HTTP_MAX_CONCURRENT_REQUESTS=32
```

브라우저 클라이언트가 필요한 경우에만 정확한 origin을 쉼표로 구분해 추가합니다. wildcard `*`는 허용되지 않습니다.

```bash
MCP_ALLOWED_ORIGIN=https://client.example.com
```

내장 서버는 plain HTTP이므로 non-loopback bind를 기본 차단합니다. 가능하면 TLS reverse proxy가 loopback 서버에 연결하게 하세요. 격리된 container network 등에서 `0.0.0.0`이 꼭 필요하면 TLS 종료, 방화벽/접근 제어, 더 작은 요청 본문 한도를 먼저 적용하고 `MCP_HTTP_ALLOW_INSECURE_EXTERNAL_BIND=true`를 명시해야 합니다. 이 opt-in은 TLS를 제공하지 않으며 외부 공개를 권장한다는 의미도 아닙니다.

토스 API 호출은 요청당 기본 15초에 중단됩니다. `TOSSINVEST_REQUEST_TIMEOUT_MS`는 1,000~120,000ms 범위에서만 설정할 수 있습니다. 내장 HTTP 서버는 헤더 10초·요청 30초·활성 요청 32개를 기본 상한으로 둡니다. `TOSSINVEST_BASE_URL`은 `https://openapi.tossinvest.com`만 허용하며, offline 검증을 위한 loopback HTTP(S) 주소만 예외입니다. 이 제한은 OAuth ClientId와 Secret이 임의 호스트로 전송되는 것을 막습니다.

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

이 서버는 번들된 공식 OpenAPI 1.2.2의 `operationId`를 기준으로 29개 callable operation을 MCP 도구로 제공합니다. 토스증권 Open API의 기능과 실제 호출 가능한 MCP 도구가 어떻게 연결되는지는 아래 표에서 확인할 수 있습니다.

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
| 종목 랭킹 조회 | `getRankings` | `toss_invest_get_rankings` | 조회 |
| 시장지표 현재가 조회 | `getMarketIndicatorPrices` | `toss_invest_get_market_indicator_prices` | 조회 |
| 시장지표 캔들 조회 | `getMarketIndicatorCandles` | `toss_invest_get_market_indicator_candles` | 조회 |
| 시장지표 투자자별 매매대금 조회 | `getMarketIndicatorInvestorTrading` | `toss_invest_get_market_indicator_investor_trading` | 조회 |
| 계좌 목록 조회 | `getAccounts` | `toss_invest_get_accounts` | 조회 |
| 보유 주식 조회 | `getHoldings` | `toss_invest_get_holdings` | 조회 |
| 주문 목록 조회 | `getOrders` | `toss_invest_get_orders` | 조회 |
| 주문 상세 조회 | `getOrder` | `toss_invest_get_order` | 조회 |
| 조건주문 목록 조회 | `getConditionalOrders` | `toss_invest_get_conditional_orders` | 조회 |
| 조건주문 상세 조회 | `getConditionalOrder` | `toss_invest_get_conditional_order` | 조회 |
| 매수 가능 금액 조회 | `getBuyingPower` | `toss_invest_get_buying_power` | 조회 |
| 판매 가능 수량 조회 | `getSellableQuantity` | `toss_invest_get_sellable_quantity` | 조회 |
| 매매 수수료 조회 | `getCommissions` | `toss_invest_get_commissions` | 조회 |
| 주문 생성 | `createOrder` | `toss_invest_create_order` | 실제 주문, 기본 차단 |
| 주문 정정 | `modifyOrder` | `toss_invest_modify_order` | 실제 주문, 기본 차단 |
| 주문 취소 | `cancelOrder` | `toss_invest_cancel_order` | 실제 주문, 기본 차단 |
| 조건주문 생성 | `createConditionalOrder` | `toss_invest_create_conditional_order` | 실제 주문, 기본 차단 |
| 조건주문 정정 | `modifyConditionalOrder` | `toss_invest_modify_conditional_order` | 실제 주문, 기본 차단 |
| 조건주문 취소 | `cancelConditionalOrder` | `toss_invest_cancel_conditional_order` | 실제 주문, 기본 차단 |

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
- `LIVE_TRADING`: 일반 주문과 조건주문의 생성, 정정, 취소 엔드포인트 호출을 허용합니다.

`LIVE_TRADING`에서도 다음 조건을 만족해야 일반 주문과 조건주문의 mutation 도구가 실행됩니다.

- 서버 환경변수 `TOSSINVEST_TRADING_MODE=LIVE_TRADING`
- 도구 입력값 `confirmTrading: true`
- 로컬 정책 엔진 통과

OpenAPI operation 이름이 바뀌거나 새 API가 추가되어도 조회로 오인하지 않도록 `GET`만 read-only로 취급합니다. 새 `GET` operation은 OpenAPI에서 자동으로 MCP 도구가 되지만, 그 외 method는 모두 fail-closed 거래 mutation으로 분류됩니다. 모든 mutation은 `confirmTrading: true`와 `LIVE_TRADING` 설정을 먼저 검사하고, 명시적인 local policy handler가 없으면 API 호출 전에 차단됩니다. 조건주문 생성과 정정에는 allowlist, blocklist, 주문 한도, 주문 본문의 조건 leg를 검사하는 전용 handler가 적용되며, 조건주문 취소도 공통 LIVE_TRADING 설정과 명시적 확인 guard를 통과해야 합니다.

정책 환경변수:

- `TOSSINVEST_ALLOWED_SYMBOLS`
- `TOSSINVEST_BLOCKED_SYMBOLS`
- `TOSSINVEST_MAX_ORDER_AMOUNT_KRW`
- `TOSSINVEST_MAX_ORDER_AMOUNT_USD`
- `TOSSINVEST_REQUIRE_CLIENT_ORDER_ID`
- `TOSSINVEST_ALLOW_MARKET_ORDER_WITHOUT_PRICE`

주문 한도·가격·수량은 IEEE-754 `Number`가 아닌 decimal 정밀도로 비교합니다. 따라서 환경변수 한도와 주문 금액은 지수 표기법 없이 양의 decimal 문자열로 설정하세요.

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
TOSSINVEST_ALLOWED_SYMBOLS=005930,AAPL
```

allowlist에는 실제로 허용할 종목만 넣으세요. 주문 종목 통화에 대응하는 한도가 없거나 allowlist가 비어 있으면 mutation은 API 호출 전에 거부됩니다. 각 실제 주문 호출에는 `confirmTrading: true`를 전달해야 합니다. KRW 기준 고액 주문은 토스증권 API 요구사항에 따라 주문 본문에 `confirmHighValueOrder: true`도 포함해야 합니다.

Mutation의 429/5xx, 전송 중 transport 오류, 필수 주문 ID가 없는 비정상 2xx는 단순 실패가 아니라 `outcomeUnknown: true`로 반환되고 감사 로그에도 `submissionPhase`와 함께 기록됩니다. 이 경우 계좌 주문 내역과 대조하기 전에는 같은 주문을 재시도하지 마세요. API 결과가 확정된 뒤 audit write만 실패한 경우에는 주문 결과를 바꾸지 않고 `auditWarning`을 함께 반환합니다.

OAuth 토큰 요청이 `403 access_denied`로 실패하면, 실행 서버의 egress IP가 토스증권 WTS의 Open API 허용 IP에 등록되지 않은 상태입니다. WTS 설정에서 해당 IP를 등록한 뒤 다시 시도하세요.

### 배치 시장가 매도

`scripts/spcx-market-sell.mjs`는 ignored JSON plan을 읽어 조회와 검증만 수행하는 dry-run을 기본으로 제공합니다. `PriceResponse.currency`가 `KRW`이면 국내 장과 KRW 한도를, `USD`이면 미국 장과 USD 한도를 사용합니다.

```bash
npm run build
node scripts/spcx-market-sell.mjs --plan-file audit/spcx-market-sell.plan.json
node scripts/spcx-market-sell.mjs --plan-file audit/spcx-market-sell.plan.json --execute
```

실행 모드에서는 주문 직전에 장 운영 시간, OPEN 주문, 매도 가능 수량, 현재가와 통화별 한도를 다시 확인합니다. 또한 기본 audit 디렉터리 아래 `spcx-market-sell/`에 전역·plan lock과 journal을 원자적으로 생성합니다. 완료, 진행 중, 부분 실패, 결과 불확실 journal이 남아 있으면 같은 plan의 자동 재실행을 차단합니다. 특히 `outcome: "outcome_unknown"`은 주문 전송 후 응답을 확정하지 못한 상태이므로 journal과 계좌 주문 내역을 대조하기 전에는 lock이나 journal을 삭제하거나 새 plan으로 재주문하지 마세요.

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
