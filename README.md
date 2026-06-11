# toss-invest-mcp-server

MCP server for the official Toss Securities Open API. v1.0 exposes both low-level OpenAPI tools and higher-level ChatGPT-friendly workflows for market context, portfolio context, order preflight, and dry-run order preparation.

The bundled API source is the official OpenAPI document from:

- https://developers.tossinvest.com/llms.txt
- https://openapi.tossinvest.com/openapi-docs/overview.md
- https://openapi.tossinvest.com/openapi-docs/latest/openapi.json

## Security model

Users must issue their own Toss Invest Open API `ClientId` and `Secret`.

This server does not collect, persist, print, or return `ClientId`, `Secret`, access tokens, or the default `accountSeq` environment value through metadata tools. Credentials are read only from the MCP server process environment:

- `TOSSINVEST_CLIENT_ID`
- `TOSSINVEST_CLIENT_SECRET`
- `TOSSINVEST_ACCOUNT` optional default accountSeq

OAuth access tokens are cached in memory only.

Live order creation, modification, and cancellation are disabled by default. The supported modes are:

- `READ_ONLY`: default. Read tools and dry-run/preflight tools only.
- `DRY_RUN`: order preparation workflows are allowed, but live order endpoints remain blocked.
- `LIVE_TRADING`: live create/modify/cancel endpoints can execute, with per-call `confirmTrading: true` and local policy checks.

To enable live trading, the server process must set:

```bash
TOSSINVEST_TRADING_MODE=LIVE_TRADING
```

Every trading mutation tool also requires `confirmTrading: true` in the tool input.

The live order policy can require idempotency keys, symbol allow/block lists, notional limits, and market-order restrictions:

- `TOSSINVEST_ALLOWED_SYMBOLS`
- `TOSSINVEST_BLOCKED_SYMBOLS`
- `TOSSINVEST_MAX_ORDER_AMOUNT_KRW`
- `TOSSINVEST_MAX_ORDER_AMOUNT_USD`
- `TOSSINVEST_REQUIRE_CLIENT_ORDER_ID`
- `TOSSINVEST_ALLOW_MARKET_ORDER_WITHOUT_PRICE`

Audit logging is local JSONL and enabled by default at `audit/toss-invest-mcp-audit.jsonl`. It does not log ClientId, Secret, access tokens, or raw account values.

## Install

```bash
npm install
npm run build
npm run verify
```

## Environment

The server automatically loads `.env`, `.env.local`, and an optional file pointed to by `TOSSINVEST_ENV_FILE` at startup. Shell or MCP-client-provided environment variables take precedence over file values. Do not commit real values.

Recommended local setup:

```bash
cp .env.example .env.local
```

Then edit `.env.local`:

```bash
TOSSINVEST_CLIENT_ID="..."
TOSSINVEST_CLIENT_SECRET="..."
TOSSINVEST_ACCOUNT="1"
TOSSINVEST_TRADING_MODE="READ_ONLY"
```

`.env.local` is ignored by git.

## Run over stdio

```bash
npm start
```

Example MCP client configuration:

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

## Run over Streamable HTTP

Use this for MCP clients that connect to an HTTP MCP endpoint. For remote exposure, set `MCP_HTTP_BEARER_TOKEN` and run a self-hosted single-user instance.

```bash
MCP_HTTP_BEARER_TOKEN="change-me" npm run start:http
```

Endpoint:

```text
POST http://localhost:3000/mcp
Authorization: Bearer change-me
```

## Tools

Metadata tools:

- `toss_invest_auth_status`
- `toss_invest_list_operations`
- `toss_invest_get_operation`

High-level workflow tools:

- `toss_invest_stock_snapshot`
- `toss_invest_market_status`
- `toss_invest_portfolio_snapshot`
- `toss_invest_account_risk_summary`
- `toss_invest_order_preflight`
- `toss_invest_create_order_dry_run`

API call tools are generated from the bundled OpenAPI operation IDs:

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

The OAuth token endpoint is not exposed as a tool. The server handles token issuance internally.

## Reliability behavior

- 429 and 5xx responses retry with bounded exponential backoff.
- `Retry-After` is respected when present.
- Toss error envelopes are normalized into `error` with `status`, `code`, `message`, `requestId`, and `retryAfter`.
- OpenAPI query/path inputs enforce enum, regex pattern, and min/max constraints where available.

## Example calls

Current price:

```json
{
  "symbols": "005930,AAPL"
}
```

Holdings with default account from `TOSSINVEST_ACCOUNT`:

```json
{
  "symbol": "005930"
}
```

Holdings with explicit account:

```json
{
  "accountSeq": 1,
  "symbol": "005930"
}
```

Create order, only when live trading is intentionally enabled:

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

Dry-run order preparation, safe in `READ_ONLY` mode:

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

The dry-run response includes:

- `executed: false`
- `preflight.policy`
- `preflight.summary.readyForLiveOrder`
- supporting API checks such as stock info, current price, price limits, buying power, commissions, market calendar, and open orders

## Live trading checklist

Before setting `TOSSINVEST_TRADING_MODE=LIVE_TRADING`, configure at least:

```bash
TOSSINVEST_REQUIRE_CLIENT_ORDER_ID=true
TOSSINVEST_MAX_ORDER_AMOUNT_KRW=1000000
TOSSINVEST_MAX_ORDER_AMOUNT_USD=1000
TOSSINVEST_BLOCKED_SYMBOLS=
TOSSINVEST_ALLOWED_SYMBOLS=
```

For each live order call, pass `confirmTrading: true`. For high-value KRW orders, Toss Invest also requires `confirmHighValueOrder: true` in the order body.

## Refresh OpenAPI spec

```bash
curl -fsSL https://openapi.tossinvest.com/openapi-docs/latest/openapi.json -o spec/openapi.json
npm run build
```
