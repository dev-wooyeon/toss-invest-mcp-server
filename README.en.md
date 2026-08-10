# toss-invest-mcp-server

[한국어](README.md) | [English](README.en.md)

Installable local MCP server for the official Toss Securities Open API. It lets MCP clients such as ChatGPT, Codex, and Claude Desktop call Toss Invest tools without sending each user's `ClientId` or `Secret` to a shared remote server.

The default distribution model is **local installation**, not hosted operation. Each user's Open API credentials must stay on that user's machine or MCP client environment.

## LLM installation context

LLM agents installing this MCP server for a user should read this section first.

### Ground rules

- Do not expose `TOSSINVEST_CLIENT_ID` or `TOSSINVEST_CLIENT_SECRET` in chat.
- Do not pass credentials as MCP tool input.
- Use stdio MCP by default.
- Use `READ_ONLY` as the default trading mode.
- Use `LIVE_TRADING` only when the user explicitly asks for it and has configured limits, allowlists, and blocklists.
- Never commit `.env.local`, `node_modules`, `dist`, or `audit`.

### Git clone install

```bash
git clone https://github.com/dev-wooyeon/toss-invest-mcp-server.git
cd toss-invest-mcp-server
npm install
npm run build
npm run verify:offline
```

If using an env file:

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

`npm run verify:offline` is the default installation check; it uses dummy credentials and a loopback mock API only. Run `npm run verify` optionally, and only after configuring real credentials, when you intentionally want to verify Toss API authentication and read paths. `npm run verify` forces `READ_ONLY` but still calls real account and market-data endpoints.

### Codex MCP registration

Using a local clone:

```bash
codex mcp add toss-invest \
  --env TOSSINVEST_CLIENT_ID="..." \
  --env TOSSINVEST_CLIENT_SECRET="..." \
  --env TOSSINVEST_ACCOUNT="1" \
  --env TOSSINVEST_TRADING_MODE="READ_ONLY" \
  -- node /absolute/path/to/toss-invest-mcp-server/dist/index.js
```

After the package is published to npm:

```bash
codex mcp add toss-invest \
  --env TOSSINVEST_CLIENT_ID="..." \
  --env TOSSINVEST_CLIENT_SECRET="..." \
  --env TOSSINVEST_ACCOUNT="1" \
  --env TOSSINVEST_TRADING_MODE="READ_ONLY" \
  -- npx -y toss-invest-mcp-server
```

Before npm publishing, running directly from GitHub:

```bash
codex mcp add toss-invest \
  --env TOSSINVEST_CLIENT_ID="..." \
  --env TOSSINVEST_CLIENT_SECRET="..." \
  --env TOSSINVEST_ACCOUNT="1" \
  --env TOSSINVEST_TRADING_MODE="READ_ONLY" \
  -- npx -y github:dev-wooyeon/toss-invest-mcp-server
```

### Claude Desktop example

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

### Installation check

Call this metadata tool from the MCP client. It does not return secret or token values.

```text
toss_invest_auth_status
```

Expected booleans:

- `hasClientId`
- `hasClientSecret`
- `hasDefaultAccount`

### Optional Streamable HTTP transport

stdio is the default. Use HTTP only for local or explicitly protected self-hosted environments. `--http` refuses to start without a bearer token and binds to `127.0.0.1` by default.

Set these values in `.env.local`, then run `npm run start:http`. Never put the real token in chat, Git, or MCP tool inputs.

```bash
# Use at least 32 cryptographically random characters: openssl rand -hex 32
MCP_HTTP_HOST=127.0.0.1
PORT=3000
MCP_HTTP_PATH=/mcp
MCP_HTTP_BEARER_TOKEN="<output from openssl rand -hex 32>"
MCP_HTTP_MAX_BODY_BYTES=1048576
MCP_HTTP_HEADERS_TIMEOUT_MS=10000
MCP_HTTP_REQUEST_TIMEOUT_MS=30000
MCP_HTTP_KEEP_ALIVE_TIMEOUT_MS=5000
MCP_HTTP_MAX_CONCURRENT_REQUESTS=32
```

Only browser clients need an exact, comma-separated origin allowlist. Wildcard `*` is rejected.

```bash
MCP_ALLOWED_ORIGIN=https://client.example.com
```

The built-in server is plain HTTP, so non-loopback binds are blocked by default. Prefer a TLS reverse proxy that connects to the loopback server. If an isolated container network genuinely requires `0.0.0.0`, first add TLS termination, firewall/access controls, and a smaller request limit, then explicitly set `MCP_HTTP_ALLOW_INSECURE_EXTERNAL_BIND=true`. This opt-in does not add TLS and is not a recommendation for public hosting.

Each Toss API attempt has a 15-second deadline by default. `TOSSINVEST_REQUEST_TIMEOUT_MS` accepts only 1,000-120,000 ms. The built-in HTTP server defaults to a 10-second header limit, 30-second request limit, and 32 active requests. `TOSSINVEST_BASE_URL` accepts only `https://openapi.tossinvest.com`, with HTTP(S) loopback URLs allowed solely for offline/local tests; this prevents OAuth ClientId and Secret from being sent to an arbitrary host.

## Product overview

This MCP server wraps Toss Invest Open API as AI-callable tools. Users keep their API credentials local and grant the AI access only to controlled tools.

Example prompts:

```text
Analyze my account and guide a SOL US Aerospace TOP10 rebalance based on SpaceX inclusion mechanics.
```

```text
Summarize my holdings, unrealized P/L, cash ratio, open orders, and buying power.
```

```text
Before placing a 10-share Samsung Electronics limit buy, check buying power, price limits, commission, and market status.
```

Live trading is blocked by default. The intended flow is: read account and market context first, prepare or dry-run an order second, and only execute when the user has deliberately enabled live trading.

## Capabilities

### Metadata tools

- `toss_invest_auth_status`
- `toss_invest_list_operations`
- `toss_invest_get_operation`

### High-level workflow tools

- `toss_invest_stock_snapshot`: stock info, current price, price limits, and warnings
- `toss_invest_market_status`: KR/US market calendar
- `toss_invest_portfolio_snapshot`: accounts, holdings, commissions, and open orders
- `toss_invest_account_risk_summary`: best-effort account risk summary from holdings
- `toss_invest_order_preflight`: pre-order market/account/policy checks
- `toss_invest_create_order_dry_run`: order request body and preflight output without execution

### OpenAPI-based tools

Tools are generated from the 34 callable operation IDs in the bundled official OpenAPI 1.2.13 document:

- `toss_invest_get_orderbook`
- `toss_invest_get_prices`
- `toss_invest_get_trades`
- `toss_invest_get_price_limit`
- `toss_invest_get_candles`
- `toss_invest_get_stocks`
- `toss_invest_get_stock_warnings`
- `toss_invest_get_stock_investor_trading`
- `toss_invest_get_stock_program_trades`
- `toss_invest_get_stock_short_selling`
- `toss_invest_get_stock_securities_lending`
- `toss_invest_get_stock_credit_trades`
- `toss_invest_get_exchange_rate`
- `toss_invest_get_kr_market_calendar`
- `toss_invest_get_us_market_calendar`
- `toss_invest_get_rankings`
- `toss_invest_get_market_indicator_prices`
- `toss_invest_get_market_indicator_candles`
- `toss_invest_get_market_indicator_investor_trading`
- `toss_invest_get_accounts`
- `toss_invest_get_holdings`
- `toss_invest_get_orders`
- `toss_invest_get_order`
- `toss_invest_get_conditional_orders`
- `toss_invest_get_conditional_order`
- `toss_invest_get_buying_power`
- `toss_invest_get_sellable_quantity`
- `toss_invest_get_commissions`
- `toss_invest_create_order`
- `toss_invest_modify_order`
- `toss_invest_cancel_order`
- `toss_invest_create_conditional_order`
- `toss_invest_modify_conditional_order`
- `toss_invest_cancel_conditional_order`

The OAuth token endpoint is not exposed as a tool. The server issues and caches tokens internally.

## Security model

Users must issue their own Toss Invest Open API `ClientId` and `Secret`.

This server does not collect, persist, print, or return `ClientId`, `Secret`, access tokens, or the default `accountSeq` environment value. Credentials are read only from the MCP server process environment.

Trading modes:

- `READ_ONLY`: default. Read tools and preflight/dry-run tools only.
- `DRY_RUN`: order preparation workflows are allowed, but live order endpoints remain blocked.
- `LIVE_TRADING`: standard and conditional create/modify/cancel endpoints can execute.

Even in `LIVE_TRADING`, live order mutation tools require:

- `TOSSINVEST_TRADING_MODE=LIVE_TRADING`
- `confirmTrading: true` in the tool input
- local policy engine approval

Only `GET` operations are classified as read-only. New `GET` operations are automatically exposed as MCP tools, while every other callable method fails closed as a trading mutation. Each mutation must first pass `confirmTrading: true` and `LIVE_TRADING`, and it is blocked before any API call unless an explicit local policy handler exists. Conditional-order creation and modification use dedicated handlers for symbol lists, order limits, and conditional legs; cancellation still requires the common LIVE_TRADING configuration and explicit confirmation guards.

Policy environment variables:

- `TOSSINVEST_ALLOWED_SYMBOLS`
- `TOSSINVEST_BLOCKED_SYMBOLS`
- `TOSSINVEST_MAX_ORDER_AMOUNT_KRW`
- `TOSSINVEST_MAX_ORDER_AMOUNT_USD`
- `TOSSINVEST_REQUIRE_CLIENT_ORDER_ID`
- `TOSSINVEST_ALLOW_MARKET_ORDER_WITHOUT_PRICE`

Order caps, prices, and quantities are compared as exact decimals rather than IEEE-754 `Number` values. Set limits and order amounts as positive non-exponential decimal strings.

Audit logging is local JSONL at `audit/toss-invest-mcp-audit.jsonl` by default. It does not log ClientId, Secret, access tokens, or raw account values.

## Technical architecture

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

Stack:

- Runtime: Node.js
- Language: TypeScript
- MCP SDK: `@modelcontextprotocol/sdk`
- Validation: `zod`
- Default transport: stdio
- Optional transport: Streamable HTTP for local/self-hosted use
- OpenAPI source: `spec/openapi.json`

Main modules:

- `src/index.ts`: stdio/HTTP entrypoint
- `src/server.ts`: MCP tool/resource registration
- `src/client.ts`: Toss Open API HTTP client, OAuth token cache, retry, error normalization
- `src/workflows.ts`: portfolio, stock, and order preflight workflow tools
- `src/policy.ts`: trading mode and order policy engine
- `src/audit.ts`: local audit log without secrets
- `src/spec.ts`: OpenAPI loading and tool schema generation
- `src/env.ts`: `.env`, `.env.local`, and `TOSSINVEST_ENV_FILE` loading

## Reliability behavior

- Read requests retry 429/5xx responses with bounded exponential backoff. No trading mutation, including create requests with `clientOrderId`, retries an ambiguous 429/5xx response because Toss idempotency keys expire after 10 minutes.
- `Retry-After` is respected for retryable requests.
- Mutation 429/5xx responses, transport failures after submission starts, and malformed 2xx responses without the required order identifier return `outcomeUnknown: true` plus `submissionPhase`; reconcile account orders before retrying. A post-call audit write failure preserves the authoritative API result and adds `auditWarning`.
- Only `invalid-token` and `expired-token` 401 responses rotate the cached access token; other 401 errors are returned without token churn.
- Toss error envelopes are normalized into `error` with `status`, `code`, `message`, `requestId`, and `retryAfter`.
- OpenAPI query/path inputs enforce enum, regex pattern, and min/max constraints where available.
- Toss Invest Open API allows one valid access token per client, so concurrent requests use a single-flight OAuth token refresh.
- OAuth `403 access_denied` means the server egress IP is not registered in Toss Securities WTS Open API allowed-IP management; register the IP before retrying.

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

Dry-run order preparation:

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

## Live trading checklist

Before setting `TOSSINVEST_TRADING_MODE=LIVE_TRADING`, configure at least:

```bash
TOSSINVEST_REQUIRE_CLIENT_ORDER_ID=true
TOSSINVEST_MAX_ORDER_AMOUNT_KRW=1000000
TOSSINVEST_MAX_ORDER_AMOUNT_USD=1000
TOSSINVEST_BLOCKED_SYMBOLS=
TOSSINVEST_ALLOWED_SYMBOLS=005930,AAPL
```

Put only intentionally permitted symbols in the allowlist. A mutation is rejected before any API call when the allowlist is empty or the matching currency limit is missing. For each live order call, pass `confirmTrading: true`. For high-value KRW orders, Toss Invest also requires `confirmHighValueOrder: true` in the order body.

### Batch market sells

`scripts/spcx-market-sell.mjs` reads an ignored JSON plan and defaults to a read-only dry run. It uses `PriceResponse.currency` to select the KR market calendar and KRW cap for `KRW`, or the US market calendar and USD cap for `USD`.

```bash
npm run build
node scripts/spcx-market-sell.mjs --plan-file audit/spcx-market-sell.plan.json
node scripts/spcx-market-sell.mjs --plan-file audit/spcx-market-sell.plan.json --execute
```

Execution mode rechecks market hours, OPEN orders, sellable quantity, current price, and the matching currency cap immediately before each mutation. It also atomically creates global and per-plan locks plus a journal under `spcx-market-sell/` in the configured audit directory. A journal for a completed, active, partially failed, or uncertain plan blocks automatic reuse of that plan. In particular, `outcome: "outcome_unknown"` means the request was sent without a conclusive response; reconcile the journal against account orders before deleting locks or journals or submitting a new plan.

## Official API source

The bundled API source is the official documentation from:

- https://developers.tossinvest.com/llms.txt
- https://openapi.tossinvest.com/openapi-docs/overview.md
- https://openapi.tossinvest.com/openapi-docs/latest/openapi.json

Refresh OpenAPI spec:

```bash
curl -fsSL https://openapi.tossinvest.com/openapi-docs/latest/openapi.json -o spec/openapi.json
npm run build
```
