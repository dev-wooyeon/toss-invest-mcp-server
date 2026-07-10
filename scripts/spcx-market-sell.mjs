#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import {
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_PLAN_FILE = "audit/spcx-market-sell.plan.json";
const EXECUTION_DIRECTORY = "spcx-market-sell";
const JOURNAL_VERSION = 1;

if (isMainModule()) {
  try {
    await main();
  } catch (error) {
    console.error(JSON.stringify({
      executed: process.argv.includes("--execute"),
      succeeded: false,
      outcome: "failed_before_execution",
      outcomeUnknown: false,
      error: errorMessage(error),
    }, null, 2));
    process.exitCode = 1;
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }

  const runtime = await loadRuntime();
  runtime.loadEnvFiles(process.cwd());
  const planFile = resolve(
    process.cwd(),
    options.planFile ??
      process.env.TOSSINVEST_ORDER_PLAN_FILE ??
      DEFAULT_PLAN_FILE,
  );
  const plan = await loadPlan(planFile, options.planId);
  const config = runtime.getConfig();
  const client = new runtime.TossInvestClient(config);
  const api = (operationId, args) =>
    callOperation(client, runtime.getOperation, operationId, args);

  const report = await runMarketSellPlan({
    plan,
    execute: options.execute,
    config,
    api,
    cwd: process.cwd(),
  });
  const output = JSON.stringify(report, null, 2);
  if (report.succeeded) {
    console.log(output);
  } else {
    console.error(output);
    process.exitCode = 1;
  }
}

export async function runMarketSellPlan({
  plan,
  execute,
  config,
  api,
  cwd = process.cwd(),
  clock = () => new Date(),
}) {
  assertPlan(plan);
  assertBaseConfig(config, plan, execute);

  if (!execute) {
    const preparedOrders = await prepareOrders({ plan, config, api, clock });
    return {
      planId: plan.planId,
      executed: false,
      succeeded: true,
      outcome: "dry_run",
      outcomeUnknown: false,
      checkedAt: nowIso(clock),
      orders: preparedOrders.map((order) => ({
        ...publicPreparedOrder(order),
        dryRunOnly: true,
      })),
    };
  }

  const paths = executionPaths(config, plan.planId, cwd);
  const startedAt = nowIso(clock);
  const journal = {
    version: JOURNAL_VERSION,
    planId: plan.planId,
    planHash: planHash(plan),
    status: "in_progress",
    executed: true,
    succeeded: false,
    outcomeUnknown: false,
    startedAt,
    updatedAt: startedAt,
    plan: {
      orders: plan.orders,
    },
    currentOrder: null,
    orders: [],
  };
  const lease = await beginExecution(paths, journal);
  const results = [];
  let preparedOrders = [];
  let currentPreparedOrder;
  let activeSubmission;

  try {
    preparedOrders = await prepareOrders({ plan, config, api, clock });
    journal.preparedOrders = preparedOrders.map(publicPreparedOrder);
    journal.updatedAt = nowIso(clock);
    await replaceJsonAtomically(paths.journal, journal);

    for (const preparedOrder of preparedOrders) {
      currentPreparedOrder = preparedOrder;
      const revalidation = await revalidateImmediatelyBeforeMutation({
        order: preparedOrder,
        config,
        api,
        clock,
      });

      const submission = {
        symbol: preparedOrder.symbol,
        clientOrderId: preparedOrder.body.clientOrderId,
        currency: preparedOrder.currency,
        outcome: "submitting",
        submittedAt: nowIso(clock),
        revalidation,
      };
      journal.currentOrder = submission;
      journal.updatedAt = submission.submittedAt;
      await replaceJsonAtomically(paths.journal, journal);

      activeSubmission = submission;
      let response;
      try {
        response = await api("createOrder", {
          accountSeq: config.defaultAccount,
          confirmTrading: true,
          body: preparedOrder.body,
        });
      } catch (error) {
        const unknownResult = {
          symbol: preparedOrder.symbol,
          clientOrderId: preparedOrder.body.clientOrderId,
          currency: preparedOrder.currency,
          ok: false,
          outcome: "outcome_unknown",
          outcomeUnknown: true,
          error: errorMessage(error),
        };
        results.push(unknownResult);
        activeSubmission = undefined;
        currentPreparedOrder = undefined;
        return await finishExecution({
          plan,
          paths,
          journal,
          results,
          status: "outcome_unknown",
          error: errorMessage(error),
          clock,
        });
      }

      activeSubmission = undefined;
      currentPreparedOrder = undefined;
      const malformedSuccess = response.ok
        ? acceptedOrderResponseError(response, preparedOrder.body.clientOrderId)
        : undefined;
      const responseOutcomeUnknown =
        Boolean(malformedSuccess) ||
        response.outcomeUnknown === true ||
        (!response.ok &&
          (response.status >= 500 ||
            response.error?.code === "request-in-progress"));
      const result = {
        symbol: preparedOrder.symbol,
        clientOrderId: preparedOrder.body.clientOrderId,
        currency: preparedOrder.currency,
        ok: response.ok && !malformedSuccess,
        status: response.status,
        outcome: response.ok && !malformedSuccess
          ? "accepted"
          : responseOutcomeUnknown
            ? "outcome_unknown"
            : "rejected",
        outcomeUnknown: responseOutcomeUnknown,
        result: response.body?.result,
        error: malformedSuccess
          ? {
              code: "mutation-outcome-unknown",
              message: malformedSuccess,
            }
          : response.error,
      };
      results.push(result);
      journal.currentOrder = null;
      journal.orders = results;
      journal.updatedAt = nowIso(clock);
      await replaceJsonAtomically(paths.journal, journal);

      if (!result.ok) {
        return await finishExecution({
          plan,
          paths,
          journal,
          results,
          status: responseOutcomeUnknown
            ? "outcome_unknown"
            : results.some((item) => item.outcome === "accepted")
              ? "partial_failure"
              : "failed",
          error: result.error?.message ??
            `createOrder failed with HTTP ${response.status}`,
          clock,
        });
      }
    }

    return await finishExecution({
      plan,
      paths,
      journal,
      results,
      status: "completed",
      clock,
    });
  } catch (error) {
    const message = errorMessage(error);
    if (activeSubmission) {
      results.push({
        symbol: activeSubmission.symbol,
        clientOrderId: activeSubmission.clientOrderId,
        currency: activeSubmission.currency,
        ok: false,
        outcome: "outcome_unknown",
        outcomeUnknown: true,
        error: message,
      });
    } else if (currentPreparedOrder) {
      results.push({
        symbol: currentPreparedOrder.symbol,
        clientOrderId: currentPreparedOrder.body.clientOrderId,
        currency: currentPreparedOrder.currency,
        ok: false,
        outcome: "not_submitted",
        outcomeUnknown: false,
        error: message,
      });
    }

    const status = activeSubmission
      ? "outcome_unknown"
      : results.some((item) => item.outcome === "accepted")
        ? "partial_failure"
        : "failed";
    return await finishExecution({
      plan,
      paths,
      journal,
      results,
      status,
      error: message,
      clock,
    });
  } finally {
    await lease.release();
  }
}

async function prepareOrders({ plan, config, api, clock }) {
  const [orders, stockRows, prices] = await Promise.all([
    api("getOrders", { status: "OPEN" }),
    api("getStocks", {
      symbols: plan.orders.map((order) => order.symbol).join(","),
    }),
    api("getPrices", {
      symbols: plan.orders.map((order) => order.symbol).join(","),
    }),
  ]);

  assertOk(orders, "getOrders");
  assertOk(stockRows, "getStocks");
  assertOk(prices, "getPrices");
  const openOrders = openOrdersFromResponse(orders, "getOrders");
  const stockBySymbol = bySymbol(
    resultArrayFromResponse(stockRows, "getStocks"),
    "getStocks",
  );
  const priceBySymbol = bySymbol(
    resultArrayFromResponse(prices, "getPrices"),
    "getPrices",
  );
  const currencies = new Set();

  for (const order of plan.orders) {
    assertActiveStock(stockBySymbol[order.symbol], order.symbol);
    assertNoOpenOrder(openOrders, order.symbol);
    currencies.add(priceCurrency(priceBySymbol[order.symbol], order.symbol));
  }

  await Promise.all(
    [...currencies].map(async (currency) => {
      const market = await fetchMarketCalendar(api, currency);
      assertRegularMarketOpen(
        regularMarketFromCalendar(market, currency),
        currentDate(clock),
        currency,
      );
    }),
  );

  const preparedOrders = [];
  for (const order of plan.orders) {
    const price = priceBySymbol[order.symbol];
    const currency = priceCurrency(price, order.symbol);
    const sellable = await api("getSellableQuantity", {
      symbol: order.symbol,
    });
    assertOk(sellable, `getSellableQuantity ${order.symbol}`);
    assertSellable(order, sellable.body?.result);
    const estimatedNotional = assertOrderNotional(order, price, config);

    preparedOrders.push({
      symbol: order.symbol,
      currency,
      estimatedNotional,
      body: {
        clientOrderId: clientOrderId(plan.planId, order.symbol),
        symbol: order.symbol,
        side: "SELL",
        orderType: "MARKET",
        quantity: order.quantity,
      },
    });
  }
  return preparedOrders;
}

async function revalidateImmediatelyBeforeMutation({
  order,
  config,
  api,
  clock,
}) {
  const [market, openOrdersResponse, sellable, prices] = await Promise.all([
    fetchMarketCalendar(api, order.currency),
    api("getOrders", { status: "OPEN" }),
    api("getSellableQuantity", { symbol: order.symbol }),
    api("getPrices", { symbols: order.symbol }),
  ]);
  assertOk(openOrdersResponse, "getOrders before mutation");
  assertOk(sellable, `getSellableQuantity ${order.symbol} before mutation`);
  assertOk(prices, `getPrices ${order.symbol} before mutation`);

  const now = currentDate(clock);
  assertRegularMarketOpen(
    regularMarketFromCalendar(market, order.currency),
    now,
    order.currency,
  );
  assertNoOpenOrder(
    openOrdersFromResponse(openOrdersResponse, "getOrders before mutation"),
    order.symbol,
  );
  assertSellable(order.body, sellable.body?.result);
  const currentPrice = bySymbol(
    resultArrayFromResponse(prices, `getPrices ${order.symbol} before mutation`),
    `getPrices ${order.symbol} before mutation`,
  )[order.symbol];
  const currentCurrency = priceCurrency(currentPrice, order.symbol);
  if (currentCurrency !== order.currency) {
    throw new Error(
      `${order.symbol} price currency changed from ${order.currency} to ${currentCurrency}.`,
    );
  }
  const estimatedNotional = assertOrderNotional(order.body, currentPrice, config);

  return {
    checkedAt: now.toISOString(),
    currency: currentCurrency,
    estimatedNotional,
  };
}

async function fetchMarketCalendar(api, currency) {
  const operationId = currency === "KRW"
    ? "getKrMarketCalendar"
    : "getUsMarketCalendar";
  const response = await api(operationId, {});
  assertOk(response, operationId);
  return response;
}

function regularMarketFromCalendar(response, currency) {
  return currency === "KRW"
    ? response.body?.result?.today?.integrated?.regularMarket
    : response.body?.result?.today?.regularMarket;
}

async function finishExecution({
  plan,
  paths,
  journal,
  results,
  status,
  error,
  clock,
}) {
  const completedAt = nowIso(clock);
  const report = {
    planId: plan.planId,
    executed: true,
    succeeded: status === "completed",
    outcome: status,
    outcomeUnknown: status === "outcome_unknown",
    checkedAt: completedAt,
    journalPath: paths.journal,
    orders: results,
    ...(error ? { error } : {}),
  };
  Object.assign(journal, {
    status,
    succeeded: report.succeeded,
    outcomeUnknown: report.outcomeUnknown,
    updatedAt: completedAt,
    completedAt,
    currentOrder: status === "outcome_unknown" ? journal.currentOrder : null,
    orders: results,
    ...(error ? { error } : {}),
  });

  try {
    await replaceJsonAtomically(paths.journal, journal);
    return report;
  } catch (journalError) {
    return {
      ...report,
      succeeded: false,
      outcome: status === "completed"
        ? "completed_with_journal_error"
        : status,
      journalError: errorMessage(journalError),
    };
  }
}

export function executionPaths(config, planId, cwd = process.cwd()) {
  const auditLogPath = resolve(cwd, config.audit.logPath);
  const directory = resolve(dirname(auditLogPath), EXECUTION_DIRECTORY);
  return {
    directory,
    globalLock: resolve(directory, "execution.lock"),
    planLock: resolve(directory, `${planId}.lock`),
    journal: resolve(directory, `${planId}.journal.json`),
  };
}

async function beginExecution(paths, journal) {
  await mkdir(paths.directory, { recursive: true, mode: 0o700 });
  const acquiredLocks = [];
  try {
    await createLock(paths.globalLock, journal);
    acquiredLocks.push(paths.globalLock);
    await createLock(paths.planLock, journal);
    acquiredLocks.push(paths.planLock);

    const existingJournal = await readJsonIfExists(paths.journal);
    if (existingJournal) {
      throw new Error(
        `Execution journal already exists for plan ${journal.planId} with status ${existingJournal.status ?? "unknown"}. Automatic rerun is blocked; inspect ${paths.journal} and use a new planId only after reconciliation.`,
      );
    }
    await createJsonAtomically(paths.journal, journal);
  } catch (error) {
    await releaseLocks(acquiredLocks);
    throw error;
  }

  return {
    async release() {
      await releaseLocks([...acquiredLocks].reverse());
    },
  };
}

async function createLock(path, journal) {
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify({
      planId: journal.planId,
      planHash: journal.planHash,
      pid: process.pid,
      createdAt: journal.startedAt,
    })}\n`, "utf8");
    await handle.sync();
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new Error(
        `Execution lock already exists at ${path}. Another execution may be active or require manual reconciliation. Automatic concurrent execution is blocked.`,
      );
    }
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function createJsonAtomically(path, value) {
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function replaceJsonAtomically(path, value) {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await createJsonAtomically(temporaryPath, value);
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

async function readJsonIfExists(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function releaseLocks(paths) {
  for (const path of paths) {
    await unlink(path).catch((error) => {
      if (error?.code !== "ENOENT") {
        console.error(`Unable to release execution lock ${path}: ${errorMessage(error)}`);
      }
    });
  }
}

function assertBaseConfig(config, plan, execute) {
  if (execute && config.tradingMode !== "LIVE_TRADING") {
    throw new Error(`Execution requires LIVE_TRADING, got ${config.tradingMode}.`);
  }
  if (!execute && !["READ_ONLY", "DRY_RUN"].includes(config.tradingMode)) {
    throw new Error(
      `Dry-run requires READ_ONLY or DRY_RUN, got ${config.tradingMode}.`,
    );
  }
  if (!config.defaultAccount) {
    throw new Error("TOSSINVEST_ACCOUNT is required.");
  }
  if (!config.tradingPolicy.allowMarketOrderWithoutPrice) {
    throw new Error("TOSSINVEST_ALLOW_MARKET_ORDER_WITHOUT_PRICE=true is required.");
  }
  if (!config.tradingPolicy.allowedSymbols?.length) {
    throw new Error("A non-empty TOSSINVEST_ALLOWED_SYMBOLS is required.");
  }
  for (const order of plan.orders) {
    if (!config.tradingPolicy.allowedSymbols.includes(order.symbol)) {
      throw new Error(`${order.symbol} is not in TOSSINVEST_ALLOWED_SYMBOLS.`);
    }
    if (config.tradingPolicy.blockedSymbols.includes(order.symbol)) {
      throw new Error(`${order.symbol} is in TOSSINVEST_BLOCKED_SYMBOLS.`);
    }
  }
}

function assertPlan(plan) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    throw new Error("Order plan must be an object.");
  }
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(plan.planId ?? "")) {
    throw new Error("planId is invalid.");
  }
  if (!Array.isArray(plan.orders) || plan.orders.length === 0) {
    throw new Error("Order plan requires a non-empty orders array.");
  }
}

function assertOk(response, label) {
  if (!response.ok) {
    throw new Error(
      `${label} failed with HTTP ${response.status}: ${JSON.stringify(response.error ?? response.body)}`,
    );
  }
}

function acceptedOrderResponseError(response, expectedClientOrderId) {
  const result = isRecord(response.body) && isRecord(response.body.result)
    ? response.body.result
    : undefined;
  if (!result || typeof result.orderId !== "string" || !result.orderId) {
    return "createOrder returned HTTP success without a valid orderId; reconcile account orders before retrying.";
  }
  if (result.clientOrderId !== expectedClientOrderId) {
    return "createOrder returned HTTP success with a missing or mismatched clientOrderId; reconcile account orders before retrying.";
  }
  return undefined;
}

function assertRegularMarketOpen(regularMarket, now, currency) {
  const market = currency === "KRW" ? "KR" : "US";
  if (!regularMarket?.startTime || !regularMarket?.endTime) {
    throw new Error(`${market} regular market time is unavailable.`);
  }
  const start = new Date(regularMarket.startTime);
  const end = new Date(regularMarket.endTime);
  if (
    !Number.isFinite(start.getTime()) ||
    !Number.isFinite(end.getTime()) ||
    now < start ||
    now >= end
  ) {
    throw new Error(
      `${market} regular market is closed. now=${now.toISOString()} start=${regularMarket.startTime} end=${regularMarket.endTime}`,
    );
  }
}

function resultArrayFromResponse(response, label) {
  if (!isRecord(response.body) || !Array.isArray(response.body.result)) {
    throw new Error(`${label} returned malformed HTTP 200: result must be an array.`);
  }
  return response.body.result;
}

function openOrdersFromResponse(response, label) {
  if (
    !isRecord(response.body) ||
    !isRecord(response.body.result) ||
    !Array.isArray(response.body.result.orders)
  ) {
    throw new Error(
      `${label} returned malformed HTTP 200: result.orders must be an array.`,
    );
  }
  validateSymbolRows(response.body.result.orders, label, { allowDuplicates: true });
  return response.body.result.orders;
}

function bySymbol(items, label) {
  if (!Array.isArray(items)) {
    throw new Error(`${label} rows must be an array.`);
  }
  validateSymbolRows(items, label, { allowDuplicates: false });
  const indexed = Object.create(null);
  for (const item of items) {
    indexed[item.symbol] = item;
  }
  return indexed;
}

function validateSymbolRows(items, label, { allowDuplicates }) {
  const symbols = new Set();
  for (const [index, item] of items.entries()) {
    if (
      !isRecord(item) ||
      typeof item.symbol !== "string" ||
      !/^[A-Za-z0-9.-]{1,20}$/.test(item.symbol)
    ) {
      throw new Error(
        `${label} returned malformed HTTP 200: row ${index} requires a valid symbol string.`,
      );
    }
    if (!allowDuplicates && symbols.has(item.symbol)) {
      throw new Error(
        `${label} returned malformed HTTP 200: duplicate symbol ${item.symbol}.`,
      );
    }
    symbols.add(item.symbol);
  }
}

function assertActiveStock(stock, symbol) {
  if (!stock || stock.status !== "ACTIVE") {
    throw new Error(`${symbol} is not ACTIVE: ${JSON.stringify(stock)}`);
  }
}

function assertNoOpenOrder(openOrders, symbol) {
  if (openOrders.some((order) => order.symbol === symbol)) {
    throw new Error(`${symbol} already has an open order.`);
  }
}

function assertSellable(order, sellable) {
  const available = Number(sellable?.sellableQuantity);
  const quantity = Number(order.quantity);
  if (
    !Number.isFinite(available) ||
    available < 0 ||
    !Number.isSafeInteger(quantity) ||
    available < quantity
  ) {
    throw new Error(
      `${order.symbol} sellable quantity ${sellable?.sellableQuantity ?? "unknown"} < ${order.quantity}`,
    );
  }
}

function priceCurrency(price, symbol) {
  if (!price || !["KRW", "USD"].includes(price.currency)) {
    throw new Error(
      `${symbol} has no supported PriceResponse.currency: ${JSON.stringify(price)}`,
    );
  }
  return price.currency;
}

function assertOrderNotional(order, price, config) {
  const currency = priceCurrency(price, order.symbol);
  const cap = currency === "KRW"
    ? config.tradingPolicy.maxOrderAmountKrw
    : config.tradingPolicy.maxOrderAmountUsd;
  if (!Number.isFinite(cap) || cap <= 0) {
    throw new Error(
      `A positive TOSSINVEST_MAX_ORDER_AMOUNT_${currency} is required for ${order.symbol}.`,
    );
  }
  const lastPrice = Number(price.lastPrice);
  const quantity = Number(order.quantity);
  const amount = lastPrice * quantity;
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(`${order.symbol} has no valid ${currency} reference price.`);
  }
  if (amount > cap) {
    throw new Error(
      `${order.symbol} estimated ${currency} notional ${amount} exceeds ${currency} max ${cap}.`,
    );
  }
  return {
    amount: String(amount),
    currency,
    referencePrice: String(price.lastPrice),
  };
}

function publicPreparedOrder(order) {
  return {
    symbol: order.symbol,
    currency: order.currency,
    estimatedNotional: order.estimatedNotional,
    body: order.body,
  };
}

function clientOrderId(planId, symbol) {
  const digest = createHash("sha256")
    .update(`${planId}:${symbol}`)
    .digest("hex")
    .slice(0, 24);
  return `spcx_${digest}`;
}

function planHash(plan) {
  return createHash("sha256")
    .update(JSON.stringify({ planId: plan.planId, orders: plan.orders }))
    .digest("hex");
}

function currentDate(clock) {
  const value = clock();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("clock must return a valid Date.");
  }
  return value;
}

function nowIso(clock) {
  return currentDate(clock).toISOString();
}

function parseArgs(args) {
  const options = {
    execute: false,
    help: false,
    planFile: undefined,
    planId: undefined,
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--execute") {
      options.execute = true;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (argument === "--plan" || argument === "--plan-file") {
      options.planFile = requiredOptionValue(args, ++index, argument);
      continue;
    }
    if (argument === "--plan-id" || argument === "--execution-id") {
      options.planId = requiredOptionValue(args, ++index, argument);
      continue;
    }
    throw new Error(`Unknown option: ${argument}`);
  }

  return options;
}

function requiredOptionValue(args, index, option) {
  const value = args[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} requires a value.`);
  }
  return value;
}

async function loadPlan(planFile, cliPlanId) {
  let raw;
  try {
    raw = JSON.parse(await readFile(planFile, "utf8"));
  } catch (error) {
    throw new Error(
      `Unable to read order plan ${planFile}: ${errorMessage(error)}`,
    );
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Order plan must be a JSON object.");
  }

  const planIds = [
    cliPlanId,
    process.env.TOSSINVEST_ORDER_PLAN_ID,
    raw.planId,
  ].filter((value) => typeof value === "string" && value.trim());
  const uniquePlanIds = [...new Set(planIds.map((value) => value.trim()))];
  if (uniquePlanIds.length === 0) {
    throw new Error(
      "An explicit plan id is required in planId, --plan-id, or TOSSINVEST_ORDER_PLAN_ID.",
    );
  }
  if (uniquePlanIds.length > 1) {
    throw new Error("Conflicting order plan ids were provided.");
  }
  const planId = uniquePlanIds[0];
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(planId)) {
    throw new Error(
      "planId must be 1-80 characters and contain only letters, numbers, hyphen, or underscore.",
    );
  }

  if (!Array.isArray(raw.orders) || raw.orders.length === 0) {
    throw new Error("Order plan requires a non-empty orders array.");
  }
  if (raw.orders.length > 20) {
    throw new Error("Order plan supports at most 20 orders.");
  }

  const orders = raw.orders.map((value, index) => parsePlannedOrder(value, index));
  const symbols = orders.map((order) => order.symbol);
  if (new Set(symbols).size !== symbols.length) {
    throw new Error("Order plan must not contain duplicate symbols.");
  }
  return { planId, orders };
}

function parsePlannedOrder(value, index) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`orders[${index}] must be an object.`);
  }
  const symbol = typeof value.symbol === "string"
    ? value.symbol.trim().toUpperCase()
    : "";
  const quantity = typeof value.quantity === "string"
    ? value.quantity.trim()
    : "";
  if (!/^[A-Z0-9.-]{1,20}$/.test(symbol)) {
    throw new Error(`orders[${index}].symbol is invalid.`);
  }
  if (!/^\d+$/.test(quantity) || !Number.isSafeInteger(Number(quantity)) || Number(quantity) <= 0) {
    throw new Error(
      `orders[${index}].quantity must be a positive safe-integer string.`,
    );
  }
  return { symbol, quantity };
}

async function callOperation(client, getOperation, operationId, args) {
  const operation = getOperation(operationId);
  if (!operation) {
    throw new Error(`Unknown operation: ${operationId}`);
  }
  return client.callOperation(operation, args);
}

async function loadRuntime() {
  const [envModule, configModule, clientModule, specModule] = await Promise.all([
    import("../dist/env.js"),
    import("../dist/config.js"),
    import("../dist/client.js"),
    import("../dist/spec.js"),
  ]);
  return {
    loadEnvFiles: envModule.loadEnvFiles,
    getConfig: configModule.getConfig,
    TossInvestClient: clientModule.TossInvestClient,
    getOperation: specModule.getOperation,
  };
}

function printUsage() {
  console.log(`Usage: node scripts/spcx-market-sell.mjs [options]

Validates every market-sell order before sending any live mutation. KRW prices
use the KR calendar and KRW cap; USD prices use the US calendar and USD cap.
Live execution creates atomic locks and a durable journal under the configured
audit directory. Any existing lock or journal blocks automatic reruns until the
operator reconciles prior outcomes and chooses a new planId.

Options:
  --plan, --plan-file <path>  JSON plan file (or TOSSINVEST_ORDER_PLAN_FILE)
  --plan-id <id>              Stable plan id (or planId in JSON/env)
  --execution-id <id>         Alias for --plan-id
  --execute                   Send orders after all validations pass
  -h, --help                  Show this help

Plan shape:
  {"planId":"explicit-stable-id","orders":[{"symbol":"SPCX","quantity":"1"}]}

Dry-run accepts READ_ONLY or DRY_RUN. Execution requires LIVE_TRADING. Credentials
must remain in local environment files and are never accepted as CLI arguments.`);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMainModule() {
  const entrypoint = process.argv[1];
  if (!entrypoint) {
    return false;
  }
  try {
    return import.meta.url === pathToFileURL(realpathSync(entrypoint)).href;
  } catch {
    return false;
  }
}
