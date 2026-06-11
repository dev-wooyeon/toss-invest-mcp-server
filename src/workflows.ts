import { TossInvestClient, type TossResponse } from "./client.js";
import { getOperation } from "./spec.js";
import {
  currencyForSymbol,
  evaluateOrderPolicy,
  parseOrderDraft,
  type OrderDraft,
} from "./policy.js";
import type { CallArgs, TossConfig } from "./types.js";

type WorkflowContext = {
  client: TossInvestClient;
  config: TossConfig;
};

export async function stockSnapshot(
  context: WorkflowContext,
  args: {
    symbols: string;
    includeWarnings?: boolean;
    includePriceLimits?: boolean;
  },
) {
  const symbols = parseSymbols(args.symbols, 20);
  const symbolList = symbols.join(",");
  const [stocks, prices] = await Promise.all([
    callApi(context.client, "getStocks", { symbols: symbolList }),
    callApi(context.client, "getPrices", { symbols: symbolList }),
  ]);

  const priceLimits = args.includePriceLimits === false
    ? []
    : await Promise.all(
        symbols.map((symbol) =>
          callApi(context.client, "getPriceLimit", { symbol }),
        ),
      );
  const warnings = args.includeWarnings === false
    ? []
    : await Promise.all(
        symbols.map((symbol) =>
          callApi(context.client, "getStockWarnings", { symbol }),
        ),
      );

  return {
    symbols,
    stocks,
    prices,
    priceLimits: zipBySymbol(symbols, priceLimits),
    warnings: zipBySymbol(symbols, warnings),
  };
}

export async function marketStatus(
  context: WorkflowContext,
  args: {
    market?: "KR" | "US" | "BOTH";
    date?: string;
  },
) {
  const market = args.market ?? "BOTH";
  const calls: Array<Promise<[string, ApiCallResult]>> = [];
  if (market === "KR" || market === "BOTH") {
    calls.push(
      callApi(context.client, "getKrMarketCalendar", optionalDateArgs(args)).then(
        (result) => ["KR", result],
      ),
    );
  }
  if (market === "US" || market === "BOTH") {
    calls.push(
      callApi(context.client, "getUsMarketCalendar", optionalDateArgs(args)).then(
        (result) => ["US", result],
      ),
    );
  }

  return {
    market,
    date: args.date,
    calendars: Object.fromEntries(await Promise.all(calls)),
  };
}

export async function portfolioSnapshot(
  context: WorkflowContext,
  args: {
    accountSeq?: string | number;
    symbol?: string;
    includeOpenOrders?: boolean;
  },
) {
  const accountArgs = accountInput(args.accountSeq);
  const [accounts, holdings, commissions, openOrders] = await Promise.all([
    callApi(context.client, "getAccounts", {}),
    callApi(context.client, "getHoldings", {
      ...accountArgs,
      ...(args.symbol ? { symbol: args.symbol } : {}),
    }),
    callApi(context.client, "getCommissions", accountArgs),
    args.includeOpenOrders === false
      ? Promise.resolve(undefined)
      : callApi(context.client, "getOrders", {
          ...accountArgs,
          status: "OPEN",
          ...(args.symbol ? { symbol: args.symbol } : {}),
        }),
  ]);

  return {
    accountConfigured: Boolean(args.accountSeq ?? context.config.defaultAccount),
    symbol: args.symbol,
    accounts,
    holdings,
    commissions,
    openOrders,
  };
}

export async function accountRiskSummary(
  context: WorkflowContext,
  args: {
    accountSeq?: string | number;
    includeOpenOrders?: boolean;
  },
) {
  const accountArgs = accountInput(args.accountSeq);
  const [holdings, buyingPowerKrw, buyingPowerUsd, openOrders] =
    await Promise.all([
      callApi(context.client, "getHoldings", accountArgs),
      callApi(context.client, "getBuyingPower", {
        ...accountArgs,
        currency: "KRW",
      }),
      callApi(context.client, "getBuyingPower", {
        ...accountArgs,
        currency: "USD",
      }),
      args.includeOpenOrders === false
        ? Promise.resolve(undefined)
        : callApi(context.client, "getOrders", {
            ...accountArgs,
            status: "OPEN",
          }),
    ]);

  const items = extractHoldingsItems(holdings.body);
  const exposures = summarizeExposures(items);

  return {
    accountConfigured: Boolean(args.accountSeq ?? context.config.defaultAccount),
    holdings,
    buyingPower: {
      KRW: buyingPowerKrw,
      USD: buyingPowerUsd,
    },
    openOrders,
    computedRisk: {
      holdingCount: items.length,
      byCurrency: exposures.byCurrency,
      byMarketCountry: exposures.byMarketCountry,
      largestPositions: exposures.largestPositions,
      notes: [
        "Computed fields are best-effort summaries from Toss Invest holdings response and are not investment advice.",
      ],
    },
  };
}

export async function orderPreflight(
  context: WorkflowContext,
  args: {
    accountSeq?: string | number;
    body: Record<string, unknown>;
    includeOpenOrders?: boolean;
  },
) {
  const order = parseOrderDraft(args.body);
  const accountArgs = accountInput(args.accountSeq);
  const symbolArgs = { symbol: order.symbol };
  const currency = currencyForSymbol(order.symbol);

  const [stock, price, priceLimit, warnings, commissions, buyingPower, sellableQuantity, calendar, openOrders] =
    await Promise.all([
      callApi(context.client, "getStocks", { symbols: order.symbol }),
      callApi(context.client, "getPrices", { symbols: order.symbol }),
      callApi(context.client, "getPriceLimit", symbolArgs),
      callApi(context.client, "getStockWarnings", symbolArgs),
      callApi(context.client, "getCommissions", accountArgs),
      order.side === "BUY"
        ? callApi(context.client, "getBuyingPower", {
            ...accountArgs,
            currency,
          })
        : Promise.resolve(undefined),
      order.side === "SELL"
        ? callApi(context.client, "getSellableQuantity", {
            ...accountArgs,
            symbol: order.symbol,
          })
        : Promise.resolve(undefined),
      callApi(
        context.client,
        currency === "KRW" ? "getKrMarketCalendar" : "getUsMarketCalendar",
        {},
      ),
      args.includeOpenOrders === false
        ? Promise.resolve(undefined)
        : callApi(context.client, "getOrders", {
            ...accountArgs,
            status: "OPEN",
            symbol: order.symbol,
          }),
    ]);

  const referencePrice = lastPrice(price.body);
  const policy = evaluateOrderPolicy(context.config, order, {
    liveExecution: false,
    referencePrice,
  });
  const checks = {
    stock,
    price,
    priceLimit,
    warnings,
    commissions,
    buyingPower,
    sellableQuantity,
    calendar,
    openOrders,
  };
  const requiredChecks = [
    stock,
    price,
    commissions,
    calendar,
    order.side === "BUY" ? buyingPower : sellableQuantity,
  ].filter(Boolean) as ApiCallResult[];
  const failedRequiredChecks = requiredChecks.filter((check) => !check.ok);
  const failedOptionalChecks = [priceLimit, warnings, openOrders].filter(
    (check): check is ApiCallResult => Boolean(check && !check.ok),
  );
  const blockingIssues = [
    ...policy.errors,
    ...failedRequiredChecks.map(
      (check) =>
        `${check.operationId} failed: ${apiFailureSummary(check)}`,
    ),
  ];

  return {
    order,
    policy,
    summary: {
      apiChecksOk: failedRequiredChecks.length === 0,
      readyForLiveOrder:
        policy.allowed && failedRequiredChecks.length === 0,
      blockingIssues,
      optionalCheckWarnings: [
        ...policy.warnings,
        ...failedOptionalChecks.map(
          (check) =>
            `${check.operationId} failed: ${apiFailureSummary(check)}`,
        ),
      ],
    },
    referencePrice,
    checks,
    dryRunOrderRequest: {
      accountProvided: Boolean(args.accountSeq ?? context.config.defaultAccount),
      endpoint: "POST /api/v1/orders",
      body: order,
    },
  };
}

export async function orderDryRun(
  context: WorkflowContext,
  args: {
    accountSeq?: string | number;
    body: Record<string, unknown>;
  },
) {
  const preflight = await orderPreflight(context, {
    accountSeq: args.accountSeq,
    body: args.body,
    includeOpenOrders: true,
  });

  return {
    mode: context.config.tradingMode,
    executed: false,
    liveTradingRequiredForExecution: "TOSSINVEST_TRADING_MODE=LIVE_TRADING",
    confirmTradingRequiredForExecution: true,
    preflight,
  };
}

type ApiCallResult = {
  operationId: string;
  ok: boolean;
  status?: number;
  headers?: Record<string, string>;
  error?: unknown;
  body?: unknown;
  result?: unknown;
  attempts?: number;
};

async function callApi(
  client: TossInvestClient,
  operationId: string,
  args: CallArgs,
): Promise<ApiCallResult> {
  const record = getOperation(operationId);
  if (!record) {
    throw new Error(`Unknown operationId: ${operationId}`);
  }

  try {
    const response = await client.callOperation(record, args);
    return apiCallResult(operationId, response);
  } catch (error) {
    return {
      operationId,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function apiCallResult(operationId: string, response: TossResponse): ApiCallResult {
  return {
    operationId,
    ok: response.ok,
    status: response.status,
    headers: response.headers,
    error: response.error,
    body: response.body,
    result: extractResult(response.body),
    attempts: response.attempts,
  };
}

function apiFailureSummary(check: ApiCallResult) {
  if (isRecord(check.error)) {
    return (
      stringOrUndefined(check.error.message) ??
      stringOrUndefined(check.error.code) ??
      "unknown API error"
    );
  }
  if (typeof check.error === "string") {
    return check.error;
  }
  return check.status ? `HTTP ${check.status}` : "unknown API error";
}

function parseSymbols(value: string, max: number) {
  const symbols = value
    .split(",")
    .map((symbol) => symbol.trim().toUpperCase())
    .filter(Boolean);
  if (!symbols.length) {
    throw new Error("At least one symbol is required.");
  }
  if (symbols.length > max) {
    throw new Error(`At most ${max} symbols are supported by this workflow tool.`);
  }
  return symbols;
}

function zipBySymbol(symbols: string[], results: ApiCallResult[]) {
  return Object.fromEntries(symbols.map((symbol, index) => [symbol, results[index]]));
}

function accountInput(accountSeq: string | number | undefined) {
  return accountSeq === undefined ? {} : { accountSeq };
}

function optionalDateArgs(args: { date?: string }) {
  return args.date ? { date: args.date } : {};
}

function extractResult(body: unknown) {
  if (isRecord(body) && "result" in body) {
    return body.result;
  }
  return undefined;
}

function lastPrice(body: unknown) {
  const result = extractResult(body);
  if (Array.isArray(result) && isRecord(result[0])) {
    return stringOrUndefined(result[0].lastPrice);
  }
  if (isRecord(result)) {
    return stringOrUndefined(result.lastPrice);
  }
  return undefined;
}

function extractHoldingsItems(body: unknown): Array<Record<string, unknown>> {
  const result = extractResult(body);
  if (isRecord(result) && Array.isArray(result.items)) {
    return result.items.filter(isRecord);
  }
  if (Array.isArray(result)) {
    return result.filter(isRecord);
  }
  return [];
}

function summarizeExposures(items: Array<Record<string, unknown>>) {
  const byCurrency: Record<string, number> = {};
  const byMarketCountry: Record<string, number> = {};
  const positions = items.map((item) => {
    const amount = numberFromNestedValue(item.marketValue, "amount");
    const currency = stringOrUndefined(item.currency) ?? "UNKNOWN";
    const marketCountry = stringOrUndefined(item.marketCountry) ?? "UNKNOWN";
    byCurrency[currency] = (byCurrency[currency] ?? 0) + amount;
    byMarketCountry[marketCountry] =
      (byMarketCountry[marketCountry] ?? 0) + amount;
    return {
      symbol: stringOrUndefined(item.symbol),
      name: stringOrUndefined(item.name),
      currency,
      marketCountry,
      marketValue: amount,
    };
  });

  return {
    byCurrency,
    byMarketCountry,
    largestPositions: positions
      .sort((a, b) => b.marketValue - a.marketValue)
      .slice(0, 5),
  };
}

function numberFromNestedValue(value: unknown, key: string) {
  if (isRecord(value)) {
    const raw = value[key] ?? value.value ?? value.amount;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function stringOrUndefined(value: unknown) {
  return typeof value === "string" && value ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
