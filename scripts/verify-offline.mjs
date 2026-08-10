#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bundledOpenApi = JSON.parse(
  await readFile(resolve(repoRoot, "spec/openapi.json"), "utf8"),
);
const requests = [];
let tokenIssueCount = 0;
let injectedInvalidToken = false;
let blockingScenario = false;

const EXPECTED_TOOLS = [
  "toss_invest_account_risk_summary",
  "toss_invest_auth_status",
  "toss_invest_cancel_conditional_order",
  "toss_invest_cancel_order",
  "toss_invest_create_conditional_order",
  "toss_invest_create_order",
  "toss_invest_create_order_dry_run",
  "toss_invest_get_accounts",
  "toss_invest_get_buying_power",
  "toss_invest_get_candles",
  "toss_invest_get_commissions",
  "toss_invest_get_conditional_order",
  "toss_invest_get_conditional_orders",
  "toss_invest_get_exchange_rate",
  "toss_invest_get_holdings",
  "toss_invest_get_kr_market_calendar",
  "toss_invest_get_market_indicator_candles",
  "toss_invest_get_market_indicator_investor_trading",
  "toss_invest_get_market_indicator_prices",
  "toss_invest_get_operation",
  "toss_invest_get_order",
  "toss_invest_get_orderbook",
  "toss_invest_get_orders",
  "toss_invest_get_price_limit",
  "toss_invest_get_prices",
  "toss_invest_get_rankings",
  "toss_invest_get_sellable_quantity",
  "toss_invest_get_stock_credit_trades",
  "toss_invest_get_stock_investor_trading",
  "toss_invest_get_stock_program_trades",
  "toss_invest_get_stock_securities_lending",
  "toss_invest_get_stock_short_selling",
  "toss_invest_get_stock_warnings",
  "toss_invest_get_stocks",
  "toss_invest_get_trades",
  "toss_invest_get_us_market_calendar",
  "toss_invest_list_operations",
  "toss_invest_market_status",
  "toss_invest_modify_conditional_order",
  "toss_invest_modify_order",
  "toss_invest_order_preflight",
  "toss_invest_portfolio_snapshot",
  "toss_invest_stock_snapshot",
].sort();

const TRADING_MUTATION_TOOLS = [
  "toss_invest_create_order",
  "toss_invest_modify_order",
  "toss_invest_cancel_order",
  "toss_invest_create_conditional_order",
  "toss_invest_modify_conditional_order",
  "toss_invest_cancel_conditional_order",
];

const mockApi = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const body = await readBody(req);
  requests.push({
    method: req.method,
    path: url.pathname,
    search: url.search,
    authorization: req.headers.authorization,
    account: req.headers["x-tossinvest-account"],
    body,
  });

  if (req.method === "POST" && url.pathname === "/oauth2/token") {
    assert.match(body, /client_id=offline-client/);
    assert.match(body, /client_secret=offline-secret/);
    tokenIssueCount += 1;
    json(res, 200, {
      access_token: `offline-access-token-${tokenIssueCount}`,
      token_type: "Bearer",
      expires_in: 3600,
    });
    return;
  }

  const authorization = req.headers.authorization;
  if (!/^Bearer offline-access-token-[12]$/.test(authorization ?? "")) {
    json(res, 401, {
      error: {
        code: "login-user-not-found",
        message: "unknown offline access token",
      },
    });
    return;
  }

  if (
    !injectedInvalidToken &&
    authorization === "Bearer offline-access-token-1" &&
    req.method === "GET" &&
    url.pathname === "/api/v1/stocks"
  ) {
    injectedInvalidToken = true;
    json(res, 401, {
      error: {
        code: "invalid-token",
        message: "offline token rotation check",
      },
    });
    return;
  }

  if (req.method !== "GET") {
    json(res, 500, {
      error: {
        code: "offline-live-mutation-called",
        message: "offline verification must never call trading mutations",
      },
    });
    return;
  }

  if (url.pathname === "/api/v1/trades") {
    json(res, 401, {
      error: {
        code: "login-user-not-found",
        message: "offline non-refreshable 401 check",
      },
    });
    return;
  }

  if (url.pathname === "/api/v1/stocks") {
    json(res, 200, {
      result: [
        {
          symbol: "005930",
          name: "Samsung Electronics",
          marketCountry: "KR",
          currency: "KRW",
          status: blockingScenario ? "HALTED" : "ACTIVE",
        },
      ],
    });
    return;
  }

  if (url.pathname === "/api/v1/prices") {
    json(res, 200, {
      result: [
        {
          symbol: "005930",
          lastPrice: "70000",
          currency: "KRW",
        },
      ],
    });
    return;
  }

  if (url.pathname === "/api/v1/price-limits") {
    json(res, 200, {
      result: {
        symbol: "005930",
        currency: "KRW",
        lowerLimitPrice: "49000",
        upperLimitPrice: "91000",
      },
    });
    return;
  }

  if (url.pathname === "/api/v1/stocks/005930/warnings") {
    json(res, 200, {
      result: blockingScenario
        ? [{ warningType: "OVERHEATED", exchange: "KRX" }]
        : [],
    });
    return;
  }

  if (
    [
      "/api/v1/stocks/005930/investor-trading",
      "/api/v1/stocks/005930/program-trades",
      "/api/v1/stocks/005930/short-selling",
      "/api/v1/stocks/005930/securities-lending",
      "/api/v1/stocks/005930/credit-trades",
    ].includes(url.pathname)
  ) {
    json(res, 200, {
      result: {
        nextUntil: null,
        records: [],
      },
    });
    return;
  }

  if (url.pathname === "/api/v1/commissions") {
    assert.equal(req.headers["x-tossinvest-account"], "1");
    json(res, 200, {
      result: [
        {
          marketCountry: "KR",
          commissionRate: "0.015",
          startDate: "2026-01-01",
          endDate: null,
        },
      ],
    });
    return;
  }

  if (url.pathname === "/api/v1/buying-power") {
    assert.equal(req.headers["x-tossinvest-account"], "1");
    json(res, 200, {
      result: {
        currency: url.searchParams.get("currency") ?? "KRW",
        cashBuyingPower: blockingScenario ? "0" : "1000000",
      },
    });
    return;
  }

  if (url.pathname === "/api/v1/market-calendar/KR") {
    const now = Date.now();
    json(res, 200, {
      result: {
        today: blockingScenario
          ? {
              date: new Date(now).toISOString().slice(0, 10),
              integrated: null,
            }
          : {
              date: new Date(now).toISOString().slice(0, 10),
              integrated: {
                preMarket: null,
                regularMarket: {
                  startTime: new Date(now - 60 * 60 * 1000).toISOString(),
                  singlePriceAuctionStartTime: new Date(
                    now + 30 * 60 * 1000,
                  ).toISOString(),
                  endTime: new Date(now + 60 * 60 * 1000).toISOString(),
                },
                afterMarket: null,
              },
            },
      },
    });
    return;
  }

  if (url.pathname === "/api/v1/orders") {
    assert.equal(req.headers["x-tossinvest-account"], "1");
    assert.equal(url.searchParams.get("status"), "OPEN");
    json(res, 200, {
      result: {
        orders: blockingScenario
          ? [{ orderId: "offline-open-order", symbol: "005930" }]
          : [],
        nextCursor: null,
        hasNext: false,
      },
    });
    return;
  }

  json(res, 404, {
    error: {
      code: "offline-route-not-found",
      message: `${req.method} ${url.pathname}`,
    },
  });
});

await listen(mockApi);
const address = mockApi.address();
assert(address && typeof address === "object");
const baseUrl = `http://127.0.0.1:${address.port}`;
const isolatedCwd = await mkdtemp(resolve(tmpdir(), "toss-invest-offline-"));

const client = new Client({
  name: "toss-invest-offline-verify",
  version: "1.0.0",
});
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve(repoRoot, "dist/index.js")],
  env: offlineEnv(baseUrl),
  cwd: isolatedCwd,
});

try {
  await client.connect(transport);

  const listedTools = await client.listTools();
  const toolNames = listedTools.tools.map((tool) => tool.name).sort();
  assert.deepEqual(
    toolNames,
    EXPECTED_TOOLS,
    "MCP tool list must exactly match the supported OpenAPI and workflow contract",
  );
  assertRequiredQuerySchemas(listedTools.tools, bundledOpenApi);
  assertStructuredRequestBodySchemas(listedTools.tools);

  const status = parseToolJson(
    await client.callTool({
      name: "toss_invest_auth_status",
      arguments: {},
    }),
  );
  assert.equal(status.tradingMode, "READ_ONLY");
  assert.equal(status.hasClientId, true);
  assert.equal(status.hasClientSecret, true);
  assert.equal(status.hasDefaultAccount, true);
  assert.equal(status.audit.enabled, false);

  const requestCountBeforeMissingQuery = requests.length;
  const missingRequiredQuery = await client.callTool({
    name: "toss_invest_get_orders",
    arguments: { accountSeq: 1 },
  });
  assert.equal(missingRequiredQuery.isError, true);
  assert.match(toolText(missingRequiredQuery), /status/i);
  assert.equal(
    requests.length,
    requestCountBeforeMissingQuery,
    "missing required query input must fail before an API request",
  );

  const dryRun = parseToolJson(
    await client.callTool({
      name: "toss_invest_create_order_dry_run",
      arguments: {
        accountSeq: 1,
        body: {
          clientOrderId: "verify-offline-dry-run",
          symbol: "005930",
          side: "BUY",
          orderType: "LIMIT",
          quantity: "1",
          price: "70000",
        },
      },
    }),
  );
  assert.equal(dryRun.executed, false);
  assert.equal(dryRun.preflight.summary.apiChecksOk, true);
  assert.equal(dryRun.preflight.summary.readyForLiveOrder, true);
  assert.deepEqual(dryRun.preflight.summary.blockingIssues, []);

  blockingScenario = true;
  const blockedDryRun = parseToolJson(
    await client.callTool({
      name: "toss_invest_create_order_dry_run",
      arguments: {
        accountSeq: 1,
        body: {
          clientOrderId: "verify-offline-blocked-dry-run",
          symbol: "005930",
          side: "BUY",
          orderType: "LIMIT",
          quantity: "1",
          price: "70000",
        },
      },
    }),
  );
  assert.equal(blockedDryRun.executed, false);
  assert.equal(blockedDryRun.preflight.summary.apiChecksOk, true);
  assert.equal(blockedDryRun.preflight.summary.readyForLiveOrder, false);
  assert(
    blockedDryRun.preflight.summary.blockingIssues.length >= 4,
    "semantic preflight must block inactive stock, warnings, no buying power, closed market, and open orders",
  );
  blockingScenario = false;

  assert.equal(injectedInvalidToken, true);
  assert.equal(tokenIssueCount, 2);
  assert(
    requests.some(
      (request) =>
        request.method === "GET" &&
        request.path === "/api/v1/stocks" &&
        request.authorization === "Bearer offline-access-token-2",
    ),
    "built MCP server must retry invalid-token once with a refreshed token",
  );

  const tokenCountBeforeNonRefreshable401 = tokenIssueCount;
  const nonRefreshable401 = await client.callTool({
    name: "toss_invest_get_trades",
    arguments: { symbol: "005930" },
  });
  assert.equal(nonRefreshable401.isError, true);
  assert.match(toolText(nonRefreshable401), /login-user-not-found/);
  assert.equal(
    tokenIssueCount,
    tokenCountBeforeNonRefreshable401,
    "login-user-not-found must not rotate the access token",
  );

  for (const toolName of TRADING_MUTATION_TOOLS) {
    const tool = listedTools.tools.find((candidate) => candidate.name === toolName);
    assert(tool, `Missing trading mutation tool: ${toolName}`);
    const mutationAttempt = await client.callTool({
      name: toolName,
      arguments: mutationArgumentsFor(toolName, tool),
    });
    assert.equal(mutationAttempt.isError, true, `${toolName} must be blocked`);
    assert.match(toolText(mutationAttempt), /LIVE_TRADING/);
  }

  assertRequest("POST", "/oauth2/token");
  assertRequest("GET", "/api/v1/stocks");
  assertRequest("GET", "/api/v1/prices");
  assertRequest("GET", "/api/v1/price-limits");
  assertRequest("GET", "/api/v1/stocks/005930/warnings");
  assertRequest("GET", "/api/v1/commissions");
  assertRequest("GET", "/api/v1/buying-power");
  assertRequest("GET", "/api/v1/market-calendar/KR");
  assertRequest("GET", "/api/v1/orders");
  assert.equal(
    requests.some(
      (request) =>
        request.method !== "GET" && request.path !== "/oauth2/token",
    ),
    false,
    "offline verification must not call any trading mutation endpoint",
  );
} finally {
  await client.close().catch(() => undefined);
  await close(mockApi);
  await rm(isolatedCwd, { recursive: true, force: true });
}

console.log(
  `Offline verified ${EXPECTED_TOOLS.length} MCP tools, ${requiredQueryParameters(bundledOpenApi).length} required query parameters, ${TRADING_MUTATION_TOOLS.length} READ_ONLY mutation guards, and ${requests.length} mock API requests.`,
);

function offlineEnv(baseUrl) {
  const inheritedKeys = [
    "HOME",
    "PATH",
    "TMPDIR",
    "TEMP",
    "TMP",
    "SystemRoot",
    "ComSpec",
  ];
  const env = {};
  for (const key of inheritedKeys) {
    if (process.env[key]) {
      env[key] = process.env[key];
    }
  }

  return {
    ...env,
    NODE_ENV: "test",
    TOSSINVEST_BASE_URL: baseUrl,
    TOSSINVEST_CLIENT_ID: "offline-client",
    TOSSINVEST_CLIENT_SECRET: "offline-secret",
    TOSSINVEST_ACCOUNT: "1",
    TOSSINVEST_TRADING_MODE: "READ_ONLY",
    TOSSINVEST_AUDIT_LOG: "false",
    TOSSINVEST_MAX_RETRIES: "0",
    TOSSINVEST_ALLOWED_SYMBOLS: "005930",
    TOSSINVEST_MAX_ORDER_AMOUNT_KRW: "1000000",
    TOSSINVEST_REQUIRE_CLIENT_ORDER_ID: "true",
  };
}

function assertRequiredQuerySchemas(tools, openApi) {
  for (const { operationId, name } of requiredQueryParameters(openApi)) {
    const toolName = `toss_invest_${camelToSnake(operationId)}`;
    const tool = tools.find((candidate) => candidate.name === toolName);
    assert(tool, `Missing tool for required query parameter: ${operationId}`);
    assert(
      tool.inputSchema?.required?.includes(name),
      `${toolName} input schema must require query parameter ${name}`,
    );
  }
}

function assertStructuredRequestBodySchemas(tools) {
  const createOrder = tools.find(
    (tool) => tool.name === "toss_invest_create_order",
  );
  const createConditional = tools.find(
    (tool) => tool.name === "toss_invest_create_conditional_order",
  );
  assert(createOrder);
  assert(createConditional);

  const orderBody = createOrder.inputSchema?.properties?.body;
  assert.equal(orderBody?.anyOf?.length, 2);
  assert.deepEqual(orderBody.anyOf[0].required, [
    "symbol",
    "side",
    "orderType",
    "quantity",
  ]);
  assert.deepEqual(orderBody.anyOf[1].required, [
    "symbol",
    "side",
    "orderType",
    "orderAmount",
  ]);

  const conditionalBody = createConditional.inputSchema?.properties?.body;
  assert.deepEqual(conditionalBody?.required, [
    "symbol",
    "type",
    "quantity",
    "orderType",
    "expireDate",
    "first",
  ]);
  assert.deepEqual(conditionalBody.properties.type.enum, [
    "SINGLE",
    "OCO",
    "OTO",
  ]);
  assert.deepEqual(conditionalBody.properties.first.required, [
    "orderSide",
    "triggerPrice",
  ]);
}

function requiredQueryParameters(openApi) {
  const parameters = [];
  for (const methods of Object.values(openApi.paths ?? {})) {
    for (const operation of Object.values(methods ?? {})) {
      if (!operation?.operationId || operation.operationId === "issueOAuth2Token") {
        continue;
      }
      for (const parameterOrRef of operation.parameters ?? []) {
        const parameter = parameterOrRef.$ref
          ? resolveOpenApiRef(openApi, parameterOrRef.$ref)
          : parameterOrRef;
        if (parameter?.in === "query" && parameter.required) {
          parameters.push({
            operationId: operation.operationId,
            name: parameter.name,
          });
        }
      }
    }
  }
  return parameters;
}

function resolveOpenApiRef(openApi, ref) {
  assert(ref.startsWith("#/"), `Only local OpenAPI refs are supported: ${ref}`);
  return ref
    .slice(2)
    .split("/")
    .reduce((value, part) => value?.[part.replace(/~1/g, "/").replace(/~0/g, "~")], openApi);
}

function requiredArgumentsFor(tool) {
  const args = {};
  for (const name of tool.inputSchema?.required ?? []) {
    if (name === "confirmTrading") {
      args[name] = true;
    } else if (name === "accountSeq") {
      args[name] = 1;
    } else if (name === "body") {
      args[name] = {};
    } else {
      const property = tool.inputSchema?.properties?.[name];
      args[name] = property?.type === "integer" || property?.type === "number"
        ? 1
        : "offline-id";
    }
  }
  return args;
}

function mutationArgumentsFor(toolName, tool) {
  const args = requiredArgumentsFor(tool);
  const bodies = {
    toss_invest_create_order: {
      clientOrderId: "verify-offline-live-blocked",
      symbol: "005930",
      side: "BUY",
      orderType: "LIMIT",
      quantity: "1",
      price: "70000",
    },
    toss_invest_modify_order: {
      orderType: "LIMIT",
      quantity: "1",
      price: "70000",
    },
    toss_invest_create_conditional_order: {
      clientOrderId: "verify-offline-conditional-blocked",
      symbol: "005930",
      type: "SINGLE",
      quantity: "1",
      orderType: "LIMIT",
      expireDate: "2026-09-10",
      first: {
        orderSide: "SELL",
        triggerPrice: "70000",
        orderPrice: "70000",
      },
    },
    toss_invest_modify_conditional_order: {
      type: "SINGLE",
      quantity: "1",
      orderType: "LIMIT",
      expireDate: "2026-09-10",
      first: {
        orderSide: "SELL",
        triggerPrice: "70000",
        orderPrice: "70000",
      },
    },
  };
  if (bodies[toolName]) {
    args.body = bodies[toolName];
  }
  return args;
}

function camelToSnake(value) {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

function parseToolJson(result) {
  return JSON.parse(toolText(result));
}

function toolText(result) {
  assert(result.content?.[0]?.text, "Expected text tool response");
  return result.content[0].text;
}

function assertRequest(method, path) {
  assert(
    requests.some((request) => request.method === method && request.path === path),
    `Expected mock API request ${method} ${path}`,
  );
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
