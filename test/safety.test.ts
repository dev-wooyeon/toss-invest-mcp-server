import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AuditLogger } from "../src/audit.js";
import {
  TossInvestClient,
  buildOperationUrl,
  redact,
} from "../src/client.js";
import { getAuthStatus, getConfig } from "../src/config.js";
import { createServer } from "../src/server.js";
import {
  assertConditionalOrderPolicy,
  assertLiveTradingConfiguration,
  assertLiveTradingPolicy,
  assertOrderModificationPolicy,
  currencyForSymbol,
  evaluateOrderPolicy,
  parseOrderDraft,
} from "../src/policy.js";
import { orderPreflight } from "../src/workflows.js";
import { getOperation, operations, resolveParameter } from "../src/spec.js";
import type { CallArgs, OperationRecord } from "../src/types.js";

test("config defaults to READ_ONLY and auth status exposes booleans only", () => {
  const config = getConfig({});
  const status = getAuthStatus(config);

  assert.equal(config.tradingMode, "READ_ONLY");
  assert.equal(config.enableTrading, false);
  assert.equal(status.hasClientId, false);
  assert.equal(status.hasClientSecret, false);
  assert.equal(status.hasDefaultAccount, false);
  assert.equal("clientId" in status, false);
  assert.equal("clientSecret" in status, false);
  assert.equal("defaultAccount" in status, false);
});

test("config only permits the official API host or loopback test servers", () => {
  assert.equal(
    getConfig({ TOSSINVEST_BASE_URL: "https://openapi.tossinvest.com/" }).baseUrl,
    "https://openapi.tossinvest.com",
  );
  assert.equal(
    getConfig({ TOSSINVEST_BASE_URL: "http://127.0.0.1:4567" }).baseUrl,
    "http://127.0.0.1:4567",
  );
  assert.throws(
    () => getConfig({ TOSSINVEST_BASE_URL: "https://example.test" }),
    /must use https:\/\/openapi\.tossinvest\.com/,
  );
  assert.throws(
    () => getConfig({ TOSSINVEST_BASE_URL: "http://openapi.tossinvest.com" }),
    /must use https:\/\/openapi\.tossinvest\.com/,
  );
  assert.throws(
    () => getConfig({ TOSSINVEST_BASE_URL: "https://openapi.tossinvest.com/proxy" }),
    /must not include credentials, a path, query, or fragment/,
  );
});

test("invalid trading mode falls back to READ_ONLY", () => {
  const config = getConfig({
    TOSSINVEST_TRADING_MODE: "unexpected",
  });

  assert.equal(config.tradingMode, "READ_ONLY");
  assert.equal(config.enableTrading, false);
});

test("explicit READ_ONLY overrides the legacy trading switch", () => {
  const config = getConfig({
    TOSSINVEST_TRADING_MODE: "READ_ONLY",
    TOSSINVEST_ENABLE_TRADING: "true",
  });

  assert.equal(config.tradingMode, "READ_ONLY");
  assert.equal(config.enableTrading, false);
});

test("policy parses order drafts and blocks live execution outside LIVE_TRADING", () => {
  const config = getConfig({});
  const order = parseOrderDraft({
    clientOrderId: "order-1",
    symbol: "005930",
    side: "BUY",
    orderType: "LIMIT",
    quantity: "2",
    price: "70000",
  });

  const decision = evaluateOrderPolicy(config, order, { liveExecution: true });

  assert.equal(order.symbol, "005930");
  assert.equal(decision.allowed, false);
  assert.match(decision.errors.join(" "), /Live trading is disabled/);
  assert.throws(
    () =>
      assertLiveTradingPolicy(config, {
        clientOrderId: "order-1",
        symbol: "005930",
        side: "BUY",
        orderType: "LIMIT",
        quantity: "2",
        price: "70000",
      }),
    /Live trading is disabled/,
  );
});

test("policy applies allowlist, blocklist, amount, and clientOrderId guards", () => {
  const config = getConfig({
    TOSSINVEST_TRADING_MODE: "LIVE_TRADING",
    TOSSINVEST_ALLOWED_SYMBOLS: "AAPL",
    TOSSINVEST_BLOCKED_SYMBOLS: "005930",
    TOSSINVEST_MAX_ORDER_AMOUNT_KRW: "1000",
  });
  const order = parseOrderDraft({
    symbol: "005930",
    side: "BUY",
    orderType: "LIMIT",
    quantity: "1",
    price: "70000",
  });

  const decision = evaluateOrderPolicy(config, order, { liveExecution: true });

  assert.equal(decision.allowed, false);
  assert.match(decision.errors.join(" "), /blocked/);
  assert.match(decision.errors.join(" "), /not in TOSSINVEST_ALLOWED_SYMBOLS/);
  assert.match(decision.errors.join(" "), /clientOrderId is required/);
  assert.match(decision.errors.join(" "), /exceeds TOSSINVEST_MAX_ORDER_AMOUNT_KRW/);
});

test("policy preserves decimal precision at live-order amount boundaries", () => {
  const config = getConfig({
    TOSSINVEST_TRADING_MODE: "LIVE_TRADING",
    TOSSINVEST_ALLOWED_SYMBOLS: "AAPL",
    TOSSINVEST_MAX_ORDER_AMOUNT_USD: "100",
  });
  const order = parseOrderDraft({
    clientOrderId: "decimal-cap",
    symbol: "AAPL",
    side: "BUY",
    orderType: "MARKET",
    orderAmount: "100.0000000000000001",
  });

  const decision = evaluateOrderPolicy(config, order, {
    liveExecution: true,
    referenceCurrency: "USD",
  });

  assert.equal(decision.allowed, false);
  assert.equal(decision.estimatedNotional?.amount, "100.0000000000000001");
  assert.match(decision.errors.join(" "), /exceeds TOSSINVEST_MAX_ORDER_AMOUNT_USD=100/);
});

test("policy warns on dry-run clientOrderId and market notional gaps", () => {
  const config = getConfig({});
  const order = parseOrderDraft({
    symbol: "AAPL",
    side: "BUY",
    orderType: "MARKET",
    quantity: "1",
  });

  const decision = evaluateOrderPolicy(config, order, { liveExecution: false });

  assert.equal(decision.allowed, true);
  assert.match(decision.warnings.join(" "), /clientOrderId is required/);
  assert.match(decision.warnings.join(" "), /no deterministic notional estimate/);
});

test("policy rejects malformed order drafts before policy evaluation", () => {
  assert.throws(
    () =>
      parseOrderDraft({
        symbol: "005930",
        side: "BUY",
        orderType: "LIMIT",
        quantity: "1",
      }),
    /LIMIT orders require price/,
  );
  assert.throws(
    () =>
      parseOrderDraft({
        clientOrderId: "bad id",
        symbol: "AAPL",
        side: "BUY",
        orderType: "MARKET",
        quantity: "1",
      }),
    /clientOrderId must be/,
  );
});

test("live trading requires an allowlist, amount limit, and idempotency policy", () => {
  const config = getConfig({
    TOSSINVEST_TRADING_MODE: "LIVE_TRADING",
  });

  assert.throws(
    () => assertLiveTradingConfiguration(config),
    /TOSSINVEST_ALLOWED_SYMBOLS/,
  );
  assert.throws(
    () =>
      assertLiveTradingPolicy(config, {
        clientOrderId: "order-1",
        symbol: "005930",
        side: "BUY",
        orderType: "LIMIT",
        quantity: "1",
        price: "70000",
      }),
    /TOSSINVEST_ALLOWED_SYMBOLS.*TOSSINVEST_MAX_ORDER_AMOUNT_KRW/,
  );
});

test("conditional order creation applies allowlist, notional, and idempotency guards", () => {
  const config = getConfig({
    TOSSINVEST_TRADING_MODE: "LIVE_TRADING",
    TOSSINVEST_ALLOWED_SYMBOLS: "005930",
    TOSSINVEST_MAX_ORDER_AMOUNT_KRW: "1000000",
  });

  assert.throws(
    () =>
      assertConditionalOrderPolicy(
        config,
        {
          symbol: "005930",
          type: "SINGLE",
          quantity: "20",
          orderType: "LIMIT",
          expireDate: "2026-12-31",
          first: {
            orderSide: "BUY",
            triggerPrice: "70000",
            orderPrice: "70000",
          },
        },
        { requireClientOrderId: true },
      ),
    /clientOrderId is required.*exceeds TOSSINVEST_MAX_ORDER_AMOUNT_KRW/,
  );
});

test("conditional-order policy enforces the official expiry and OCO/OTO invariants", () => {
  const config = getConfig({
    TOSSINVEST_TRADING_MODE: "LIVE_TRADING",
    TOSSINVEST_ALLOWED_SYMBOLS: "005930",
    TOSSINVEST_MAX_ORDER_AMOUNT_KRW: "10000000",
    TOSSINVEST_ALLOW_MARKET_ORDER_WITHOUT_PRICE: "true",
  });
  const base = {
    clientOrderId: "conditional-guard",
    symbol: "005930",
    quantity: "1",
    expireDate: "2026-12-31",
  };

  assert.throws(
    () =>
      assertConditionalOrderPolicy(
        config,
        {
          ...base,
          expireDate: undefined,
          type: "SINGLE",
          orderType: "LIMIT",
          first: { orderSide: "SELL", triggerPrice: "70000", orderPrice: "70000" },
        },
        { requireClientOrderId: true, referenceCurrency: "KRW" },
      ),
    /expireDate is required/,
  );
  assert.throws(
    () =>
      assertConditionalOrderPolicy(
        config,
        {
          ...base,
          type: "OCO",
          orderType: "MARKET",
          first: { orderSide: "BUY", triggerPrice: "71000" },
          second: { orderSide: "BUY", triggerPrice: "69000" },
        },
        {
          requireClientOrderId: true,
          referenceCurrency: "KRW",
          currentPrice: "70000",
        },
      ),
    /support only LIMIT/,
  );
  assert.throws(
    () =>
      assertConditionalOrderPolicy(
        config,
        {
          ...base,
          type: "OCO",
          orderType: "LIMIT",
          first: { orderSide: "BUY", triggerPrice: "71000", orderPrice: "71000" },
          second: { orderSide: "SELL", triggerPrice: "69000", orderPrice: "69000" },
        },
        {
          requireClientOrderId: true,
          referenceCurrency: "KRW",
          currentPrice: "70000",
        },
      ),
    /require SELL for both legs/,
  );
  assert.throws(
    () =>
      assertConditionalOrderPolicy(
        config,
        {
          ...base,
          type: "OTO",
          orderType: "LIMIT",
          first: { orderSide: "BUY", triggerPrice: "69000", orderPrice: "69000" },
          second: { orderSide: "BUY", triggerPrice: "71000", orderPrice: "71000" },
        },
        { requireClientOrderId: true, referenceCurrency: "KRW" },
      ),
    /first=BUY and second=SELL/,
  );
});

test("order modification enforces KR and US wire quantity rules", () => {
  const config = getConfig({
    TOSSINVEST_TRADING_MODE: "LIVE_TRADING",
    TOSSINVEST_ALLOWED_SYMBOLS: "005930,AAPL",
    TOSSINVEST_MAX_ORDER_AMOUNT_KRW: "1000000",
    TOSSINVEST_MAX_ORDER_AMOUNT_USD: "1000",
  });

  assert.throws(
    () =>
      assertOrderModificationPolicy(
        config,
        { symbol: "005930", side: "BUY", currency: "KRW", quantity: "1" },
        { orderType: "LIMIT", price: "70000" },
      ),
    /quantity is required when modifying a KR order/,
  );
  assert.throws(
    () =>
      assertOrderModificationPolicy(
        config,
        { symbol: "AAPL", side: "BUY", currency: "USD", quantity: "1" },
        { orderType: "LIMIT", quantity: "1", price: "200" },
      ),
    /quantity must be omitted when modifying a US order/,
  );
  assert.equal(currencyForSymbol("ABC123"), "USD");
  assert.equal(currencyForSymbol("005930"), "KRW");
});

test("audit sanitizes account values and respects disabled audit logging", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "toss-invest-audit-"));
  const enabledLogPath = join(tempDir, "audit.jsonl");
  const enabledConfig = getConfig({
    TOSSINVEST_ACCOUNT: "123456",
    TOSSINVEST_AUDIT_LOG_PATH: enabledLogPath,
  });
  const enabledAudit = new AuditLogger(enabledConfig);
  const sanitized = enabledAudit.sanitizeArgs({
    body: {
      clientOrderId: "order-1",
      symbol: "005930",
      side: "BUY",
      orderType: "LIMIT",
      quantity: "1",
      price: "70000",
    },
    confirmTrading: true,
  });

  assert.equal(sanitized.accountHash, "8d969eef6ecad3c2".slice(0, 12));
  assert.equal(sanitized.accountHash, "8d969eef6eca");
  assert.equal(sanitized.accountHash === "123456", false);

  await enabledAudit.write({
    type: "tool_call",
    tool: "toss_invest_create_order",
    details: sanitized,
  });
  const logContents = await readFile(enabledLogPath, "utf8");
  assert.match(logContents, /"accountHash":"8d969eef6eca"/);
  assert.equal(logContents.includes("123456"), false);

  const disabledLogPath = join(tempDir, "disabled.jsonl");
  const disabledAudit = new AuditLogger(
    getConfig({
      TOSSINVEST_AUDIT_LOG: "false",
      TOSSINVEST_AUDIT_LOG_PATH: disabledLogPath,
    }),
  );
  await disabledAudit.write({
    type: "tool_call",
    tool: "toss_invest_auth_status",
  });
  assert.equal(existsSync(disabledLogPath), false);
});

test("post-call audit failure never turns an accepted order into an MCP error", async () => {
  const config = getConfig({
    TOSSINVEST_ACCOUNT: "1",
    TOSSINVEST_TRADING_MODE: "LIVE_TRADING",
    TOSSINVEST_ALLOWED_SYMBOLS: "005930",
    TOSSINVEST_MAX_ORDER_AMOUNT_KRW: "1000000",
  });
  class AcceptedOrderClient extends TossInvestClient {
    override async callOperation(_record: OperationRecord, _args: CallArgs) {
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        headers: {},
        body: { result: { orderId: "accepted-order" } },
        attempts: 1,
      };
    }
  }
  class PostCallFailingAudit extends AuditLogger {
    writes = 0;

    override async write(_event: Parameters<AuditLogger["write"]>[0]) {
      this.writes += 1;
      if (this.writes === 2) {
        throw new Error("audit disk full");
      }
    }
  }

  const audit = new PostCallFailingAudit(config);
  const server = createServer({
    config,
    client: new AcceptedOrderClient(config),
    audit,
  });
  const client = new Client({ name: "audit-outcome-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({
      name: "toss_invest_create_order",
      arguments: {
        accountSeq: 1,
        confirmTrading: true,
        body: {
          clientOrderId: "accepted-audit-id",
          symbol: "005930",
          side: "BUY",
          orderType: "LIMIT",
          quantity: "1",
          price: "70000",
        },
      },
    });

    assert.notEqual(result.isError, true);
    assert.equal(result.structuredContent?.body?.result?.orderId, "accepted-order");
    assert.match(
      String(result.structuredContent?.auditWarning),
      /API outcome is authoritative/,
    );
    assert.equal(audit.writes, 2);
  } finally {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
});

test("ambiguous mutation outcomes are returned and written to audit details", async () => {
  const config = getConfig({
    TOSSINVEST_ACCOUNT: "1",
    TOSSINVEST_TRADING_MODE: "LIVE_TRADING",
    TOSSINVEST_ALLOWED_SYMBOLS: "005930",
    TOSSINVEST_MAX_ORDER_AMOUNT_KRW: "1000000",
  });
  class UnknownOutcomeClient extends TossInvestClient {
    override async callOperation(_record: OperationRecord, _args: CallArgs) {
      return {
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        headers: {},
        body: { error: { code: "internal-error" } },
        error: {
          code: "internal-error",
          message: "ambiguous failure",
          status: 500,
        },
        attempts: 1,
        outcomeUnknown: true,
        submissionPhase: "response_received" as const,
      };
    }
  }
  class CapturingAudit extends AuditLogger {
    events: Array<Parameters<AuditLogger["write"]>[0]> = [];

    override async write(event: Parameters<AuditLogger["write"]>[0]) {
      this.events.push(event);
    }
  }

  const audit = new CapturingAudit(config);
  const server = createServer({
    config,
    client: new UnknownOutcomeClient(config),
    audit,
  });
  const client = new Client({ name: "audit-unknown-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({
      name: "toss_invest_cancel_order",
      arguments: {
        accountSeq: 1,
        orderId: "order-to-cancel",
        confirmTrading: true,
      },
    });

    assert.equal(result.isError, true);
    assert.equal(result.structuredContent?.outcomeUnknown, true);
    assert.equal(result.structuredContent?.submissionPhase, "response_received");
    assert.equal(audit.events[1]?.details?.outcomeUnknown, true);
    assert.equal(
      audit.events[1]?.details?.submissionPhase,
      "response_received",
    );
  } finally {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
});

test("redact removes configured secrets, default account, and bearer tokens", () => {
  const config = getConfig({
    TOSSINVEST_CLIENT_ID: "client-id",
    TOSSINVEST_CLIENT_SECRET: "client-secret",
    TOSSINVEST_ACCOUNT: "123456",
  });

  const redacted = redact(
    "client-id client-secret 123456 Bearer abc.def-123",
    config,
  );

  assert.equal(redacted.includes("client-id"), false);
  assert.equal(redacted.includes("client-secret"), false);
  assert.equal(redacted.includes("123456"), false);
  assert.equal(redacted, "[REDACTED] [REDACTED] [REDACTED] Bearer [REDACTED]");
});

test("OAuth IP denial gives the WTS allowlist recovery action", async () => {
  const config = getConfig({
    TOSSINVEST_CLIENT_ID: "client-id",
    TOSSINVEST_CLIENT_SECRET: "client-secret",
    TOSSINVEST_MAX_RETRIES: "0",
  });
  const client = new TossInvestClient(config);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    jsonResponse(403, {
      error: "access_denied",
      error_description: "IP address not allowed",
    })) as typeof fetch;

  try {
    await assert.rejects(
      client.callOperation(testOperation("getTest", "get"), {}),
      /source IP is not allowlisted.*WTS.*Allowed IP management/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("client attaches the configured timeout to every upstream attempt", async () => {
  const config = getConfig({
    TOSSINVEST_CLIENT_ID: "client-id",
    TOSSINVEST_CLIENT_SECRET: "client-secret",
    TOSSINVEST_MAX_RETRIES: "0",
    TOSSINVEST_REQUEST_TIMEOUT_MS: "1000",
  });
  const client = new TossInvestClient(config);
  const signals: AbortSignal[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input, init) => {
    assert.ok(init?.signal instanceof AbortSignal);
    signals.push(init.signal);
    return jsonResponse(200, { access_token: "token", expires_in: 3600 });
  }) as typeof fetch;

  try {
    await client.callOperation(testOperation("getTest", "get"), {});
    assert.equal(signals.length, 2);
    assert.equal(signals.every((signal) => !signal.aborted), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("client refreshes access token once after API 401", async () => {
  const config = getConfig({
    TOSSINVEST_BASE_URL: "https://openapi.tossinvest.com",
    TOSSINVEST_CLIENT_ID: "client-id",
    TOSSINVEST_CLIENT_SECRET: "client-secret",
    TOSSINVEST_MAX_RETRIES: "0",
  });
  const client = new TossInvestClient(config);
  const record: OperationRecord = {
    method: "get",
    path: "/v1/test",
    operation: {
      operationId: "getTest",
    },
    tags: [],
    summary: "Test",
    description: "",
    requiresAccount: false,
    isTradingMutation: false,
  };
  const calls: Array<{ path: string; authorization?: string }> = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    calls.push({
      path: url.pathname,
      authorization: headers.get("authorization") ?? undefined,
    });

    if (url.pathname === "/oauth2/token") {
      const token = calls.filter((call) => call.path === "/oauth2/token").length === 1
        ? "stale-token"
        : "fresh-token";
      return jsonResponse(200, { access_token: token, expires_in: 3600 });
    }

    if (headers.get("authorization") === "Bearer stale-token") {
      return jsonResponse(401, {
        error: {
          code: "invalid-token",
          message: "invalid token",
        },
      });
    }

    assert.equal(headers.get("authorization"), "Bearer fresh-token");
    return jsonResponse(200, { result: "ok" });
  }) as typeof fetch;

  try {
    const response = await client.callOperation(record, {});

    assert.equal(response.ok, true);
    assert.equal(response.status, 200);
    assert.equal(response.attempts, 2);
    assert.deepEqual(
      calls.map((call) => [call.path, call.authorization]),
      [
        ["/oauth2/token", undefined],
        ["/v1/test", "Bearer stale-token"],
        ["/oauth2/token", undefined],
        ["/v1/test", "Bearer fresh-token"],
      ],
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("client does not rotate tokens for non-token 401 errors", async () => {
  const config = getConfig({
    TOSSINVEST_BASE_URL: "https://openapi.tossinvest.com",
    TOSSINVEST_CLIENT_ID: "client-id",
    TOSSINVEST_CLIENT_SECRET: "client-secret",
    TOSSINVEST_MAX_RETRIES: "0",
  });
  const client = new TossInvestClient(config);
  const record = testOperation("getTest", "get");
  let tokenCalls = 0;
  let apiCalls = 0;
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/oauth2/token") {
      tokenCalls += 1;
      return jsonResponse(200, { access_token: "valid-token", expires_in: 3600 });
    }
    apiCalls += 1;
    return jsonResponse(401, {
      error: {
        code: "login-user-not-found",
        message: "login user not found",
      },
    });
  }) as typeof fetch;

  try {
    const first = await client.callOperation(record, {});
    const second = await client.callOperation(record, {});
    assert.equal(first.status, 401);
    assert.equal(second.status, 401);
    assert.equal(tokenCalls, 1);
    assert.equal(apiCalls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("non-idempotent trading mutations do not retry ambiguous 5xx responses", async () => {
  const config = getConfig({
    TOSSINVEST_BASE_URL: "https://openapi.tossinvest.com",
    TOSSINVEST_CLIENT_ID: "client-id",
    TOSSINVEST_CLIENT_SECRET: "client-secret",
    TOSSINVEST_ACCOUNT: "1",
    TOSSINVEST_TRADING_MODE: "LIVE_TRADING",
    TOSSINVEST_ALLOWED_SYMBOLS: "005930",
    TOSSINVEST_MAX_ORDER_AMOUNT_KRW: "1000000",
    TOSSINVEST_MAX_RETRIES: "2",
    TOSSINVEST_RETRY_BASE_DELAY_MS: "0",
    TOSSINVEST_RETRY_MAX_DELAY_MS: "0",
  });
  const client = new TossInvestClient(config);
  const record: OperationRecord = {
    ...testOperation("cancelOrder", "post"),
    requiresAccount: true,
    isTradingMutation: true,
  };
  let mutationCalls = 0;
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/oauth2/token") {
      return jsonResponse(200, { access_token: "valid-token", expires_in: 3600 });
    }
    mutationCalls += 1;
    return jsonResponse(500, {
      error: { code: "internal-error", message: "ambiguous failure" },
    });
  }) as typeof fetch;

  try {
    const response = await client.callOperation(record, { confirmTrading: true });
    assert.equal(response.status, 500);
    assert.equal(response.attempts, 1);
    assert.equal(response.outcomeUnknown, true);
    assert.equal(response.submissionPhase, "response_received");
    assert.equal(mutationCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("create mutations do not retry ambiguous 5xx responses past the idempotency boundary", async () => {
  const config = getConfig({
    TOSSINVEST_BASE_URL: "https://openapi.tossinvest.com",
    TOSSINVEST_CLIENT_ID: "client-id",
    TOSSINVEST_CLIENT_SECRET: "client-secret",
    TOSSINVEST_ACCOUNT: "1",
    TOSSINVEST_TRADING_MODE: "LIVE_TRADING",
    TOSSINVEST_ALLOWED_SYMBOLS: "005930",
    TOSSINVEST_MAX_ORDER_AMOUNT_KRW: "1000000",
    TOSSINVEST_MAX_RETRIES: "2",
    TOSSINVEST_RETRY_BASE_DELAY_MS: "600001",
    TOSSINVEST_RETRY_MAX_DELAY_MS: "600001",
  });
  const client = new TossInvestClient(config);
  const record = getOperation("createOrder");
  assert.ok(record);
  let mutationCalls = 0;
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/oauth2/token") {
      return jsonResponse(200, { access_token: "valid-token", expires_in: 3600 });
    }
    if (url.pathname === "/api/v1/prices") {
      return jsonResponse(200, {
        result: [{ symbol: "005930", lastPrice: "70000", currency: "KRW" }],
      });
    }
    if (url.pathname === "/api/v1/orders" && init?.method === "POST") {
      mutationCalls += 1;
      return jsonResponse(500, {
        error: { code: "internal-error", message: "ambiguous failure" },
      });
    }
    throw new Error(`Unexpected mock route: ${url.pathname}`);
  }) as typeof fetch;

  try {
    const response = await client.callOperation(record, {
      accountSeq: 1,
      confirmTrading: true,
      body: {
        clientOrderId: "stable-create-id",
        symbol: "005930",
        side: "BUY",
        orderType: "LIMIT",
        quantity: "1",
        price: "70000",
      },
    });
    assert.equal(response.status, 500);
    assert.equal(response.attempts, 1);
    assert.equal(response.outcomeUnknown, true);
    assert.equal(response.submissionPhase, "response_received");
    assert.equal(mutationCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("quantity MARKET order enforces the configured cap using a current quote", async () => {
  const config = getConfig({
    TOSSINVEST_BASE_URL: "https://openapi.tossinvest.com",
    TOSSINVEST_CLIENT_ID: "client-id",
    TOSSINVEST_CLIENT_SECRET: "client-secret",
    TOSSINVEST_ACCOUNT: "1",
    TOSSINVEST_TRADING_MODE: "LIVE_TRADING",
    TOSSINVEST_ALLOWED_SYMBOLS: "005930",
    TOSSINVEST_MAX_ORDER_AMOUNT_KRW: "100000",
    TOSSINVEST_ALLOW_MARKET_ORDER_WITHOUT_PRICE: "true",
    TOSSINVEST_MAX_RETRIES: "0",
  });
  const client = new TossInvestClient(config);
  const record = getOperation("createOrder");
  assert.ok(record);
  let mutationCalls = 0;
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/oauth2/token") {
      return jsonResponse(200, { access_token: "valid-token", expires_in: 3600 });
    }
    if (url.pathname === "/api/v1/prices") {
      return jsonResponse(200, {
        result: [{ symbol: "005930", lastPrice: "70000", currency: "KRW" }],
      });
    }
    if (url.pathname === "/api/v1/orders" && init?.method === "POST") {
      mutationCalls += 1;
    }
    throw new Error(`Unexpected mock route: ${url.pathname}`);
  }) as typeof fetch;

  try {
    await assert.rejects(
      client.callOperation(record, {
        accountSeq: 1,
        confirmTrading: true,
        body: {
          clientOrderId: "market-cap-id",
          symbol: "005930",
          side: "BUY",
          orderType: "MARKET",
          quantity: "2",
        },
      }),
      /Estimated KRW notional 140000 exceeds/,
    );
    assert.equal(mutationCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("mutation transport failures return a typed outcome_unknown result", async () => {
  const config = getConfig({
    TOSSINVEST_BASE_URL: "https://openapi.tossinvest.com",
    TOSSINVEST_CLIENT_ID: "client-id",
    TOSSINVEST_CLIENT_SECRET: "client-secret",
    TOSSINVEST_ACCOUNT: "1",
    TOSSINVEST_TRADING_MODE: "LIVE_TRADING",
    TOSSINVEST_ALLOWED_SYMBOLS: "005930",
    TOSSINVEST_MAX_ORDER_AMOUNT_KRW: "1000000",
    TOSSINVEST_MAX_RETRIES: "0",
  });
  const client = new TossInvestClient(config);
  const record = getOperation("createOrder");
  assert.ok(record);
  let mutationCalls = 0;
  let tokenCalls = 0;
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/oauth2/token") {
      tokenCalls += 1;
      return jsonResponse(200, {
        access_token: `valid-token-${tokenCalls}`,
        expires_in: 3600,
      });
    }
    if (url.pathname === "/api/v1/prices") {
      return jsonResponse(200, {
        result: [{ symbol: "005930", lastPrice: "70000", currency: "KRW" }],
      });
    }
    if (url.pathname === "/api/v1/orders" && init?.method === "POST") {
      mutationCalls += 1;
      if (mutationCalls === 1) {
        return jsonResponse(401, {
          error: { code: "invalid-token", message: "rotate token" },
        });
      }
      throw new TypeError("socket reset");
    }
    throw new Error(`Unexpected mock route: ${url.pathname}`);
  }) as typeof fetch;

  try {
    const response = await client.callOperation(record, {
      accountSeq: 1,
      confirmTrading: true,
      body: {
        clientOrderId: "transport-unknown",
        symbol: "005930",
        side: "BUY",
        orderType: "LIMIT",
        quantity: "1",
        price: "70000",
      },
    });
    assert.equal(response.ok, false);
    assert.equal(response.status, 0);
    assert.equal(response.error?.code, "mutation-outcome-unknown");
    assert.equal(response.outcomeUnknown, true);
    assert.equal(response.submissionPhase, "submission_started");
    assert.equal(response.attempts, 2);
    assert.equal(tokenCalls, 2);
    assert.equal(mutationCalls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("malformed HTTP success for a mutation is treated as outcome_unknown", async () => {
  const config = getConfig({
    TOSSINVEST_BASE_URL: "https://openapi.tossinvest.com",
    TOSSINVEST_CLIENT_ID: "client-id",
    TOSSINVEST_CLIENT_SECRET: "client-secret",
    TOSSINVEST_ACCOUNT: "1",
    TOSSINVEST_TRADING_MODE: "LIVE_TRADING",
    TOSSINVEST_ALLOWED_SYMBOLS: "005930",
    TOSSINVEST_MAX_ORDER_AMOUNT_KRW: "1000000",
    TOSSINVEST_MAX_RETRIES: "0",
  });
  const client = new TossInvestClient(config);
  const record = getOperation("createOrder");
  assert.ok(record);
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/oauth2/token") {
      return jsonResponse(200, { access_token: "valid-token", expires_in: 3600 });
    }
    if (url.pathname === "/api/v1/prices") {
      return jsonResponse(200, {
        result: [{ symbol: "005930", lastPrice: "70000", currency: "KRW" }],
      });
    }
    if (url.pathname === "/api/v1/orders" && init?.method === "POST") {
      return jsonResponse(200, { result: {} });
    }
    throw new Error(`Unexpected mock route: ${url.pathname}`);
  }) as typeof fetch;

  try {
    const response = await client.callOperation(record, {
      accountSeq: 1,
      confirmTrading: true,
      body: {
        clientOrderId: "malformed-success",
        symbol: "005930",
        side: "BUY",
        orderType: "LIMIT",
        quantity: "1",
        price: "70000",
      },
    });
    assert.equal(response.ok, false);
    assert.equal(response.status, 200);
    assert.equal(response.error?.code, "mutation-outcome-unknown");
    assert.match(response.error?.message ?? "", /without a valid orderId/);
    assert.equal(response.outcomeUnknown, true);
    assert.equal(response.submissionPhase, "response_received");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("conditional-order cancellation accepts the official 204 No Content response", async () => {
  const config = getConfig({
    TOSSINVEST_BASE_URL: "https://openapi.tossinvest.com",
    TOSSINVEST_CLIENT_ID: "client-id",
    TOSSINVEST_CLIENT_SECRET: "client-secret",
    TOSSINVEST_ACCOUNT: "1",
    TOSSINVEST_TRADING_MODE: "LIVE_TRADING",
    TOSSINVEST_ALLOWED_SYMBOLS: "005930",
    TOSSINVEST_MAX_ORDER_AMOUNT_KRW: "1000000",
    TOSSINVEST_MAX_RETRIES: "0",
  });
  const client = new TossInvestClient(config);
  const record = getOperation("cancelConditionalOrder");
  assert.ok(record);
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/oauth2/token") {
      return jsonResponse(200, { access_token: "valid-token", expires_in: 3600 });
    }
    if (
      url.pathname === "/api/v1/conditional-orders/conditional-1" &&
      init?.method === "DELETE"
    ) {
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected mock route: ${url.pathname}`);
  }) as typeof fetch;

  try {
    const response = await client.callOperation(record, {
      accountSeq: 1,
      conditionalOrderId: "conditional-1",
      confirmTrading: true,
    });
    assert.equal(response.ok, true);
    assert.equal(response.status, 204);
    assert.equal(response.error, undefined);
    assert.equal(response.outcomeUnknown, false);
    assert.equal(response.submissionPhase, "response_received");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("unknown future mutations are blocked before network access", async () => {
  const config = getConfig({
    TOSSINVEST_TRADING_MODE: "LIVE_TRADING",
    TOSSINVEST_ALLOWED_SYMBOLS: "005930",
    TOSSINVEST_MAX_ORDER_AMOUNT_KRW: "1000000",
  });
  const client = new TossInvestClient(config);
  const record: OperationRecord = {
    ...testOperation("futureMutation", "post"),
    isTradingMutation: true,
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("network must not be reached");
  }) as typeof fetch;

  try {
    await assert.rejects(
      client.callOperation(record, { confirmTrading: true }),
      /no local trading-policy handler/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("order modification resolves the original symbol before applying live policy", async () => {
  const config = getConfig({
    TOSSINVEST_BASE_URL: "https://openapi.tossinvest.com",
    TOSSINVEST_CLIENT_ID: "client-id",
    TOSSINVEST_CLIENT_SECRET: "client-secret",
    TOSSINVEST_ACCOUNT: "1",
    TOSSINVEST_TRADING_MODE: "LIVE_TRADING",
    TOSSINVEST_ALLOWED_SYMBOLS: "AAPL",
    TOSSINVEST_MAX_ORDER_AMOUNT_USD: "1000",
    TOSSINVEST_MAX_RETRIES: "0",
  });
  const client = new TossInvestClient(config);
  const record = getOperation("modifyOrder");
  assert.ok(record);
  let mutationCalls = 0;
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/oauth2/token") {
      return jsonResponse(200, { access_token: "valid-token", expires_in: 3600 });
    }
    if (url.pathname === "/api/v1/orders/order-1") {
      return jsonResponse(200, {
        result: {
          orderId: "order-1",
          symbol: "005930",
          side: "BUY",
          currency: "KRW",
          orderType: "LIMIT",
          quantity: "1",
          price: "70000",
        },
      });
    }
    if (url.pathname === "/api/v1/prices") {
      return jsonResponse(200, {
        result: [{ symbol: "005930", lastPrice: "70000", currency: "KRW" }],
      });
    }
    mutationCalls += 1;
    return jsonResponse(200, { result: { orderId: "modified-order" } });
  }) as typeof fetch;

  try {
    await assert.rejects(
      client.callOperation(record, {
        accountSeq: 1,
        orderId: "order-1",
        confirmTrading: true,
        body: {
          orderType: "LIMIT",
          quantity: "1",
          price: "70000",
        },
      }),
      /TOSSINVEST_MAX_ORDER_AMOUNT_KRW.*not in TOSSINVEST_ALLOWED_SYMBOLS/,
    );
    assert.equal(mutationCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("every required OpenAPI query parameter is serialized onto the wire URL", () => {
  let checked = 0;
  for (const record of operations) {
    const args: Record<string, unknown> = {};
    const expected: Array<[string, unknown]> = [];
    for (const parameter of record.operation.parameters ?? []) {
      const resolved = resolveParameter(parameter);
      if (!resolved.required) {
        continue;
      }
      const value = queryExample(resolved);
      args[resolved.name] = value;
      if (resolved.in === "query") {
        expected.push([resolved.name, value]);
      }
    }
    if (!expected.length) {
      continue;
    }
    const url = buildOperationUrl("https://example.test", record, args);
    for (const [name, value] of expected) {
      assert.equal(
        url.searchParams.get(name),
        String(value),
        `${record.operation.operationId}.${name} wire serialization mismatch`,
      );
      checked += 1;
    }
  }
  assert.equal(checked > 0, true);
});

test("preflight is not ready when cash, market, warnings, and open orders block it", async () => {
  const config = getConfig({
    TOSSINVEST_BASE_URL: "https://openapi.tossinvest.com",
    TOSSINVEST_CLIENT_ID: "client-id",
    TOSSINVEST_CLIENT_SECRET: "client-secret",
    TOSSINVEST_ACCOUNT: "1",
    TOSSINVEST_TRADING_MODE: "DRY_RUN",
    TOSSINVEST_ALLOWED_SYMBOLS: "005930",
    TOSSINVEST_MAX_ORDER_AMOUNT_KRW: "1000000",
    TOSSINVEST_MAX_RETRIES: "0",
  });
  const client = new TossInvestClient(config);
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/oauth2/token") {
      return jsonResponse(200, { access_token: "valid-token", expires_in: 3600 });
    }
    if (url.pathname === "/api/v1/stocks") {
      return jsonResponse(200, {
        result: [{ symbol: "005930", status: "ACTIVE", currency: "KRW" }],
      });
    }
    if (url.pathname === "/api/v1/prices") {
      return jsonResponse(200, {
        result: [{ symbol: "005930", lastPrice: "70000", currency: "KRW" }],
      });
    }
    if (url.pathname === "/api/v1/price-limits") {
      return jsonResponse(200, {
        result: { lowerLimitPrice: "50000", upperLimitPrice: "90000" },
      });
    }
    if (url.pathname.endsWith("/warnings")) {
      return jsonResponse(200, {
        result: [{ warningType: "INVESTMENT_RISK" }],
      });
    }
    if (url.pathname === "/api/v1/commissions") {
      return jsonResponse(200, { result: {} });
    }
    if (url.pathname === "/api/v1/buying-power") {
      return jsonResponse(200, {
        result: { currency: "KRW", cashBuyingPower: "0" },
      });
    }
    if (url.pathname === "/api/v1/market-calendar/KR") {
      return jsonResponse(200, {
        result: { today: { date: "2026-07-10", integrated: null } },
      });
    }
    if (url.pathname === "/api/v1/orders") {
      return jsonResponse(200, {
        result: { orders: [{ symbol: "005930", status: "PENDING" }] },
      });
    }
    throw new Error(`Unexpected mock route: ${url.pathname}`);
  }) as typeof fetch;

  try {
    const result = await orderPreflight(
      { client, config },
      {
        body: {
          clientOrderId: "preflight-blocked",
          symbol: "005930",
          side: "BUY",
          orderType: "LIMIT",
          quantity: "1",
          price: "70000",
        },
      },
    );
    assert.equal(result.summary.readyForLiveOrder, false);
    assert.match(result.summary.blockingIssues.join(" "), /stock warnings/);
    assert.match(result.summary.blockingIssues.join(" "), /Buying power 0/);
    assert.match(result.summary.blockingIssues.join(" "), /market session is currently open|No supported market session/);
    assert.match(result.summary.blockingIssues.join(" "), /open order already exists/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("preflight blocks US fractional orders in the last regular-market hour", async () => {
  const config = getConfig({
    TOSSINVEST_BASE_URL: "https://openapi.tossinvest.com",
    TOSSINVEST_CLIENT_ID: "client-id",
    TOSSINVEST_CLIENT_SECRET: "client-secret",
    TOSSINVEST_ACCOUNT: "1",
    TOSSINVEST_TRADING_MODE: "DRY_RUN",
    TOSSINVEST_ALLOWED_SYMBOLS: "AAPL",
    TOSSINVEST_MAX_ORDER_AMOUNT_USD: "1000000",
    TOSSINVEST_ALLOW_MARKET_ORDER_WITHOUT_PRICE: "true",
    TOSSINVEST_MAX_RETRIES: "0",
  });
  const client = new TossInvestClient(config);
  const originalFetch = globalThis.fetch;
  const now = Date.now();

  globalThis.fetch = (async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/oauth2/token") {
      return jsonResponse(200, { access_token: "valid-token", expires_in: 3600 });
    }
    if (url.pathname === "/api/v1/stocks") {
      return jsonResponse(200, {
        result: [{ symbol: "AAPL", status: "ACTIVE", currency: "USD" }],
      });
    }
    if (url.pathname === "/api/v1/prices") {
      return jsonResponse(200, {
        result: [{ symbol: "AAPL", lastPrice: "200", currency: "USD" }],
      });
    }
    if (url.pathname === "/api/v1/price-limits") {
      return jsonResponse(200, {
        result: {
          currency: "USD",
          lowerLimitPrice: "1",
          upperLimitPrice: "1000",
        },
      });
    }
    if (url.pathname.endsWith("/warnings")) {
      return jsonResponse(200, { result: [] });
    }
    if (url.pathname === "/api/v1/commissions") {
      return jsonResponse(200, {
        result: [{ marketCountry: "US", commissionRate: "0.01" }],
      });
    }
    if (url.pathname === "/api/v1/sellable-quantity") {
      return jsonResponse(200, { result: { sellableQuantity: "1" } });
    }
    if (url.pathname === "/api/v1/market-calendar/US") {
      return jsonResponse(200, {
        result: {
          today: {
            regularMarket: {
              startTime: new Date(now - 60 * 60 * 1000).toISOString(),
              endTime: new Date(now + 30 * 60 * 1000).toISOString(),
            },
          },
        },
      });
    }
    if (url.pathname === "/api/v1/orders") {
      return jsonResponse(200, { result: { orders: [] } });
    }
    throw new Error(`Unexpected mock route: ${url.pathname}`);
  }) as typeof fetch;

  try {
    const result = await orderPreflight(
      { client, config },
      {
        body: {
          clientOrderId: "fractional-last-hour",
          symbol: "AAPL",
          side: "SELL",
          orderType: "MARKET",
          quantity: "0.5",
        },
      },
    );
    assert.equal(result.summary.readyForLiveOrder, false);
    assert.match(
      result.summary.blockingIssues.join(" "),
      /one hour before regular market close/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("preflight fails closed for empty, malformed, or wrong-currency 200 payloads", async () => {
  const config = getConfig({
    TOSSINVEST_BASE_URL: "https://openapi.tossinvest.com",
    TOSSINVEST_CLIENT_ID: "client-id",
    TOSSINVEST_CLIENT_SECRET: "client-secret",
    TOSSINVEST_ACCOUNT: "1",
    TOSSINVEST_TRADING_MODE: "DRY_RUN",
    TOSSINVEST_ALLOWED_SYMBOLS: "005930",
    TOSSINVEST_MAX_ORDER_AMOUNT_KRW: "1000000",
    TOSSINVEST_MAX_RETRIES: "0",
  });
  const client = new TossInvestClient(config);
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/oauth2/token") {
      return jsonResponse(200, { access_token: "valid-token", expires_in: 3600 });
    }
    if (url.pathname === "/api/v1/stocks") {
      return jsonResponse(200, {
        result: [{ symbol: "005930", status: "ACTIVE", currency: "KRW" }],
      });
    }
    if (url.pathname === "/api/v1/prices") {
      return jsonResponse(200, { result: [] });
    }
    if (url.pathname === "/api/v1/price-limits") {
      return jsonResponse(200, { result: {} });
    }
    if (url.pathname.endsWith("/warnings")) {
      return jsonResponse(200, { result: null });
    }
    if (url.pathname === "/api/v1/commissions") {
      return jsonResponse(200, { result: [] });
    }
    if (url.pathname === "/api/v1/buying-power") {
      return jsonResponse(200, {
        result: { currency: "USD", cashBuyingPower: "999999999" },
      });
    }
    if (url.pathname === "/api/v1/market-calendar/KR") {
      return jsonResponse(200, { result: { open: true } });
    }
    if (url.pathname === "/api/v1/orders") {
      return jsonResponse(200, { result: {} });
    }
    throw new Error(`Unexpected mock route: ${url.pathname}`);
  }) as typeof fetch;

  try {
    const result = await orderPreflight(
      { client, config },
      {
        body: {
          clientOrderId: "malformed-preflight",
          symbol: "005930",
          side: "BUY",
          orderType: "LIMIT",
          quantity: "1",
          price: "70000",
        },
      },
    );
    const issues = result.summary.blockingIssues.join(" ");
    assert.equal(result.summary.apiChecksOk, true);
    assert.equal(result.summary.semanticChecksOk, false);
    assert.equal(result.summary.readyForLiveOrder, false);
    assert.match(issues, /Price lookup did not return/);
    assert.match(issues, /Stock-warning response was malformed/);
    assert.match(issues, /Price-limit response was malformed/);
    assert.match(issues, /Commission response did not contain/);
    assert.match(issues, /Buying-power response used the wrong currency/);
    assert.match(issues, /Open-order response was malformed/);
    assert.match(issues, /No supported market session is currently open/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function testOperation(
  operationId: string,
  method: OperationRecord["method"],
): OperationRecord {
  return {
    method,
    path: "/v1/test",
    operation: { operationId },
    tags: [],
    summary: "Test",
    description: "",
    requiresAccount: false,
    isTradingMutation: false,
  };
}

function queryExample(parameter: ReturnType<typeof resolveParameter>) {
  if (parameter.example !== undefined) {
    return parameter.example;
  }
  const schema = parameter.schema;
  if (schema?.enum?.length) {
    return schema.enum[0];
  }
  const type = Array.isArray(schema?.type) ? schema.type[0] : schema?.type;
  if (type === "integer" || type === "number") {
    return 1;
  }
  if (type === "boolean") {
    return true;
  }
  return "test";
}

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}
