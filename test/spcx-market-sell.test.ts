import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  executionPaths,
  runMarketSellPlan,
} from "../scripts/spcx-market-sell.mjs";

const KR_NOW = new Date("2026-07-10T02:00:00.000Z");
const US_NOW = new Date("2026-07-10T14:00:00.000Z");

test("PriceResponse.currency selects the matching calendar and amount cap", async (t) => {
  const cwd = await temporaryDirectory(t);

  const us = fakeApi({
    currencies: { SPCX: "USD" },
    prices: { SPCX: "50" },
  });
  const usReport = await runMarketSellPlan({
    plan: plan("us-dry-run", { symbol: "SPCX", quantity: "2" }),
    execute: false,
    config: config(cwd, ["SPCX"], {
      tradingMode: "READ_ONLY",
      maxOrderAmountKrw: 1,
      maxOrderAmountUsd: 100,
    }),
    api: us.api,
    clock: () => new Date(US_NOW),
    cwd,
  });

  assert.equal(usReport.succeeded, true);
  assert.equal(usReport.orders[0].currency, "USD");
  assert.deepEqual(usReport.orders[0].estimatedNotional, {
    amount: "100",
    currency: "USD",
    referencePrice: "50",
  });
  assert.equal(callCount(us.calls, "getUsMarketCalendar"), 1);
  assert.equal(callCount(us.calls, "getKrMarketCalendar"), 0);

  const overUsdCap = fakeApi({
    currencies: { SPCX: "USD" },
    prices: { SPCX: "50" },
  });
  await assert.rejects(
    runMarketSellPlan({
      plan: plan("us-over-cap", { symbol: "SPCX", quantity: "2" }),
      execute: false,
      config: config(cwd, ["SPCX"], {
        tradingMode: "READ_ONLY",
        maxOrderAmountKrw: 1_000_000,
        maxOrderAmountUsd: 99,
      }),
      api: overUsdCap.api,
      clock: () => new Date(US_NOW),
      cwd,
    }),
    /estimated USD notional 100 exceeds USD max 99/,
  );

  const kr = fakeApi({
    currencies: { "005930": "KRW" },
    prices: { "005930": "70000" },
  });
  const krReport = await runMarketSellPlan({
    plan: plan("kr-dry-run", { symbol: "005930", quantity: "1" }),
    execute: false,
    config: config(cwd, ["005930"], {
      tradingMode: "READ_ONLY",
      maxOrderAmountKrw: 70_000,
      maxOrderAmountUsd: 1,
    }),
    api: kr.api,
    clock: () => new Date(KR_NOW),
    cwd,
  });
  assert.equal(krReport.orders[0].currency, "KRW");
  assert.equal(callCount(kr.calls, "getKrMarketCalendar"), 1);
  assert.equal(callCount(kr.calls, "getUsMarketCalendar"), 0);
});

test("live execution revalidates immediately, journals completion, and blocks reruns", async (t) => {
  const cwd = await temporaryDirectory(t);
  const currentPlan = plan("completed-plan", {
    symbol: "SPCX",
    quantity: "1",
  });
  const currentConfig = config(cwd, ["SPCX"]);
  const fake = fakeApi({ currencies: { SPCX: "USD" } });

  const report = await runMarketSellPlan({
    plan: currentPlan,
    execute: true,
    config: currentConfig,
    api: fake.api,
    clock: () => new Date(US_NOW),
    cwd,
  });

  assert.equal(report.succeeded, true);
  assert.equal(report.outcome, "completed");
  assert.equal(report.orders[0].outcome, "accepted");
  assert.equal(callCount(fake.calls, "getUsMarketCalendar"), 2);
  assert.equal(callCount(fake.calls, "getOrders"), 2);
  assert.equal(callCount(fake.calls, "getSellableQuantity"), 2);
  assert.equal(callCount(fake.calls, "getPrices"), 2);
  assert.equal(callCount(fake.calls, "createOrder"), 1);

  const paths = executionPaths(currentConfig, currentPlan.planId, cwd);
  const journal = JSON.parse(await readFile(paths.journal, "utf8"));
  assert.equal(journal.status, "completed");
  assert.equal(journal.orders[0].outcome, "accepted");
  await assert.rejects(access(paths.globalLock), { code: "ENOENT" });
  await assert.rejects(access(paths.planLock), { code: "ENOENT" });

  const callsBeforeRerun = fake.calls.length;
  await assert.rejects(
    runMarketSellPlan({
      plan: currentPlan,
      execute: true,
      config: currentConfig,
      api: fake.api,
      clock: () => new Date(US_NOW),
      cwd,
    }),
    /Execution journal already exists.*Automatic rerun is blocked/,
  );
  assert.equal(fake.calls.length, callsBeforeRerun);
});

test("partial success plus a thrown mutation is persisted as outcome_unknown", async (t) => {
  const cwd = await temporaryDirectory(t);
  const currentPlan = plan(
    "unknown-plan",
    { symbol: "SPCX", quantity: "1" },
    { symbol: "QQQ", quantity: "2" },
  );
  const currentConfig = config(cwd, ["SPCX", "QQQ"]);
  const fake = fakeApi({
    currencies: { SPCX: "USD", QQQ: "USD" },
    createOrder(callNumber, args) {
      if (callNumber === 2) {
        throw new Error("socket reset after request body was sent");
      }
      return ok({
        result: {
          orderId: "accepted-first",
          clientOrderId: args.body.clientOrderId,
        },
      });
    },
  });

  const report = await runMarketSellPlan({
    plan: currentPlan,
    execute: true,
    config: currentConfig,
    api: fake.api,
    clock: () => new Date(US_NOW),
    cwd,
  });

  assert.equal(report.succeeded, false);
  assert.equal(report.outcome, "outcome_unknown");
  assert.equal(report.outcomeUnknown, true);
  assert.deepEqual(
    report.orders.map((order) => [order.symbol, order.outcome]),
    [
      ["SPCX", "accepted"],
      ["QQQ", "outcome_unknown"],
    ],
  );
  assert.match(report.orders[1].error, /socket reset/);

  const paths = executionPaths(currentConfig, currentPlan.planId, cwd);
  const journal = JSON.parse(await readFile(paths.journal, "utf8"));
  assert.equal(journal.status, "outcome_unknown");
  assert.equal(journal.outcomeUnknown, true);
  assert.equal(journal.orders.length, 2);
  assert.equal(journal.currentOrder.symbol, "QQQ");

  await assert.rejects(
    runMarketSellPlan({
      plan: currentPlan,
      execute: true,
      config: currentConfig,
      api: fake.api,
      clock: () => new Date(US_NOW),
      cwd,
    }),
    /status outcome_unknown.*Automatic rerun is blocked/,
  );
});

test("malformed HTTP 200 mutation response is journaled as outcome_unknown", async (t) => {
  const cwd = await temporaryDirectory(t);
  const currentPlan = plan("malformed-success", {
    symbol: "SPCX",
    quantity: "1",
  });
  const currentConfig = config(cwd, ["SPCX"]);
  const fake = fakeApi({
    currencies: { SPCX: "USD" },
    createOrder() {
      return ok({ result: {} });
    },
  });

  const report = await runMarketSellPlan({
    plan: currentPlan,
    execute: true,
    config: currentConfig,
    api: fake.api,
    clock: () => new Date(US_NOW),
    cwd,
  });

  assert.equal(report.succeeded, false);
  assert.equal(report.outcome, "outcome_unknown");
  assert.equal(report.outcomeUnknown, true);
  assert.equal(report.orders[0].outcome, "outcome_unknown");
  assert.match(report.orders[0].error.message, /without a valid orderId/);

  const journal = JSON.parse(
    await readFile(executionPaths(currentConfig, currentPlan.planId, cwd).journal, "utf8"),
  );
  assert.equal(journal.status, "outcome_unknown");
  assert.equal(journal.orders[0].outcomeUnknown, true);
});

test("a new OPEN order found during pre-mutation revalidation prevents submission", async (t) => {
  const cwd = await temporaryDirectory(t);
  const currentPlan = plan("open-order-race", {
    symbol: "SPCX",
    quantity: "1",
  });
  const currentConfig = config(cwd, ["SPCX"]);
  const fake = fakeApi({
    currencies: { SPCX: "USD" },
    openOrdersByCall: [[], [{ symbol: "SPCX" }]],
  });

  const report = await runMarketSellPlan({
    plan: currentPlan,
    execute: true,
    config: currentConfig,
    api: fake.api,
    clock: () => new Date(US_NOW),
    cwd,
  });

  assert.equal(report.succeeded, false);
  assert.equal(report.outcome, "failed");
  assert.equal(report.orders[0].outcome, "not_submitted");
  assert.match(report.orders[0].error, /already has an open order/);
  assert.equal(callCount(fake.calls, "createOrder"), 0);
});

test("malformed HTTP 200 order, stock, and price rows fail closed", async (t) => {
  const cwd = await temporaryDirectory(t);
  const dryConfig = config(cwd, ["SPCX"], { tradingMode: "READ_ONLY" });

  const malformedInitialOrders = fakeApi({
    currencies: { SPCX: "USD" },
    orderResultsByCall: [{}],
  });
  await assert.rejects(
    runMarketSellPlan({
      plan: plan("malformed-initial-orders", {
        symbol: "SPCX",
        quantity: "1",
      }),
      execute: false,
      config: dryConfig,
      api: malformedInitialOrders.api,
      clock: () => new Date(US_NOW),
      cwd,
    }),
    /result\.orders must be an array/,
  );

  const malformedRevalidationOrders = fakeApi({
    currencies: { SPCX: "USD" },
    orderResultsByCall: [{ orders: [] }, {}],
  });
  const revalidationReport = await runMarketSellPlan({
    plan: plan("malformed-revalidation-orders", {
      symbol: "SPCX",
      quantity: "1",
    }),
    execute: true,
    config: config(cwd, ["SPCX"]),
    api: malformedRevalidationOrders.api,
    clock: () => new Date(US_NOW),
    cwd,
  });
  assert.equal(revalidationReport.outcome, "failed");
  assert.equal(revalidationReport.orders[0].outcome, "not_submitted");
  assert.equal(callCount(malformedRevalidationOrders.calls, "createOrder"), 0);

  const malformedStocks = fakeApi({
    currencies: { SPCX: "USD" },
    stockRows: [{ symbol: null, status: "ACTIVE" }],
  });
  await assert.rejects(
    runMarketSellPlan({
      plan: plan("malformed-stock-rows", {
        symbol: "SPCX",
        quantity: "1",
      }),
      execute: false,
      config: dryConfig,
      api: malformedStocks.api,
      clock: () => new Date(US_NOW),
      cwd,
    }),
    /getStocks returned malformed HTTP 200: row 0 requires a valid symbol string/,
  );

  const duplicatePrices = fakeApi({
    currencies: { SPCX: "USD" },
    priceRows: [
      { symbol: "SPCX", lastPrice: "50", currency: "USD" },
      { symbol: "SPCX", lastPrice: "51", currency: "USD" },
    ],
  });
  await assert.rejects(
    runMarketSellPlan({
      plan: plan("duplicate-price-rows", {
        symbol: "SPCX",
        quantity: "1",
      }),
      execute: false,
      config: dryConfig,
      api: duplicatePrices.api,
      clock: () => new Date(US_NOW),
      cwd,
    }),
    /getPrices returned malformed HTTP 200: duplicate symbol SPCX/,
  );
});

test("the global atomic lock blocks concurrent plans without calling their APIs", async (t) => {
  const cwd = await temporaryDirectory(t);
  const currentConfig = config(cwd, ["SPCX", "QQQ"]);
  const firstFake = fakeApi({ currencies: { SPCX: "USD" } });
  const secondFake = fakeApi({ currencies: { QQQ: "USD" } });
  let releaseFirst;
  let markFirstStarted;
  const firstStarted = new Promise<void>((resolve) => {
    markFirstStarted = resolve;
  });
  const holdFirst = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let held = false;
  const firstApi = async (operationId, args) => {
    if (!held) {
      held = true;
      markFirstStarted();
      await holdFirst;
    }
    return firstFake.api(operationId, args);
  };

  const firstExecution = runMarketSellPlan({
    plan: plan("first-plan", { symbol: "SPCX", quantity: "1" }),
    execute: true,
    config: currentConfig,
    api: firstApi,
    clock: () => new Date(US_NOW),
    cwd,
  });
  await firstStarted;

  await assert.rejects(
    runMarketSellPlan({
      plan: plan("second-plan", { symbol: "QQQ", quantity: "1" }),
      execute: true,
      config: currentConfig,
      api: secondFake.api,
      clock: () => new Date(US_NOW),
      cwd,
    }),
    /Execution lock already exists.*concurrent execution is blocked/,
  );
  assert.equal(secondFake.calls.length, 0);

  releaseFirst();
  const firstReport = await firstExecution;
  assert.equal(firstReport.outcome, "completed");
});

function fakeApi({
  currencies,
  prices = {},
  openOrdersByCall = [[]],
  orderResultsByCall,
  stockRows,
  priceRows,
  createOrder,
}) {
  const calls = [];
  let getOrdersCalls = 0;
  let createOrderCalls = 0;

  return {
    calls,
    async api(operationId, args) {
      calls.push({ operationId, args });
      switch (operationId) {
        case "getOrders": {
          const orderResult = orderResultsByCall?.[getOrdersCalls];
          const orders = openOrdersByCall[getOrdersCalls] ??
            openOrdersByCall.at(-1) ?? [];
          getOrdersCalls += 1;
          return ok({ result: orderResult ?? { orders } });
        }
        case "getStocks":
          return ok({
            result: stockRows ??
              symbols(args.symbols).map((symbol) => ({
                symbol,
                status: "ACTIVE",
              })),
          });
        case "getPrices":
          return ok({
            result: priceRows ??
              symbols(args.symbols).map((symbol) => ({
                symbol,
                lastPrice: prices[symbol] ?? "50",
                currency: currencies[symbol],
              })),
          });
        case "getSellableQuantity":
          return ok({ result: { sellableQuantity: "100" } });
        case "getKrMarketCalendar":
          return ok({
            result: {
              today: {
                integrated: {
                  regularMarket: {
                    startTime: "2026-07-10T00:00:00.000Z",
                    endTime: "2026-07-10T08:00:00.000Z",
                  },
                },
              },
            },
          });
        case "getUsMarketCalendar":
          return ok({
            result: {
              today: {
                regularMarket: {
                  startTime: "2026-07-10T13:00:00.000Z",
                  endTime: "2026-07-10T20:00:00.000Z",
                },
              },
            },
          });
        case "createOrder":
          createOrderCalls += 1;
          return createOrder
            ? createOrder(createOrderCalls, args)
            : ok({
                result: {
                  orderId: `order-${createOrderCalls}`,
                  clientOrderId: args.body.clientOrderId,
                },
              });
        default:
          throw new Error(`Unexpected fake API operation: ${operationId}`);
      }
    },
  };
}

function ok(body) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: {},
    body,
    attempts: 1,
  };
}

function config(cwd, allowedSymbols, overrides = {}) {
  return {
    defaultAccount: "1",
    tradingMode: overrides.tradingMode ?? "LIVE_TRADING",
    tradingPolicy: {
      allowedSymbols,
      blockedSymbols: [],
      allowMarketOrderWithoutPrice: true,
      requireClientOrderId: true,
      maxOrderAmountKrw: String(overrides.maxOrderAmountKrw ?? 1_000_000),
      maxOrderAmountUsd: String(overrides.maxOrderAmountUsd ?? 1_000),
    },
    audit: {
      enabled: true,
      logPath: join(cwd, "audit", "toss-invest-mcp-audit.jsonl"),
    },
  };
}

function plan(planId, ...orders) {
  return { planId, orders };
}

function symbols(value) {
  return String(value).split(",").filter(Boolean);
}

function callCount(calls, operationId) {
  return calls.filter((call) => call.operationId === operationId).length;
}

async function temporaryDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), "spcx-market-sell-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
