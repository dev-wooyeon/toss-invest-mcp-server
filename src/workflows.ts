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
  const [stock, price] = await Promise.all([
    callApi(context.client, "getStocks", { symbols: order.symbol }),
    callApi(context.client, "getPrices", { symbols: order.symbol }),
  ]);
  const quote = referenceQuote(price.result, order.symbol);
  const requestCurrency = quote?.currency ?? currencyForSymbol(order.symbol);

  const [priceLimit, warnings, commissions, buyingPower, sellableQuantity, calendar, openOrders] =
    await Promise.all([
      callApi(context.client, "getPriceLimit", symbolArgs),
      callApi(context.client, "getStockWarnings", symbolArgs),
      callApi(context.client, "getCommissions", accountArgs),
      order.side === "BUY"
          ? callApi(context.client, "getBuyingPower", {
            ...accountArgs,
            currency: requestCurrency,
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
          requestCurrency === "KRW"
            ? "getKrMarketCalendar"
            : "getUsMarketCalendar",
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

  const referencePrice = quote?.price;
  const policy = evaluateOrderPolicy(context.config, order, {
    liveExecution: true,
    referencePrice,
    referenceCurrency: quote?.currency,
    enforceTradingMode: false,
    requireClientOrderId: true,
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
    priceLimit,
    warnings,
    commissions,
    calendar,
    openOrders,
    order.side === "BUY" ? buyingPower : sellableQuantity,
  ].filter(Boolean) as ApiCallResult[];
  const failedRequiredChecks = requiredChecks.filter((check) => !check.ok);
  const semanticIssues = preflightSemanticIssues(
    order,
    policy,
    checks,
    quote?.currency,
  );
  if (args.includeOpenOrders === false) {
    semanticIssues.push(
      "Open-order validation was skipped; live-order readiness cannot be confirmed.",
    );
  }
  const blockingIssues = [
    ...policy.errors,
    ...failedRequiredChecks.map(
      (check) =>
        `${check.operationId} failed: ${apiFailureSummary(check)}`,
    ),
    ...semanticIssues,
  ];

  return {
    order,
    policy,
    summary: {
      apiChecksOk: failedRequiredChecks.length === 0,
      semanticChecksOk: semanticIssues.length === 0,
      readyForLiveOrder: blockingIssues.length === 0,
      blockingIssues,
      optionalCheckWarnings: policy.warnings,
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

function preflightSemanticIssues(
  order: OrderDraft,
  policy: ReturnType<typeof evaluateOrderPolicy>,
  checks: {
    stock: ApiCallResult;
    price: ApiCallResult;
    priceLimit: ApiCallResult;
    warnings: ApiCallResult;
    commissions: ApiCallResult;
    buyingPower?: ApiCallResult;
    sellableQuantity?: ApiCallResult;
    calendar: ApiCallResult;
    openOrders?: ApiCallResult;
  },
  referenceCurrency?: "KRW" | "USD",
) {
  const issues: string[] = [];
  if ([checks.stock, checks.price, checks.priceLimit, checks.warnings, checks.commissions, checks.calendar]
    .some((check) => !check.ok)) {
    return issues;
  }

  const stockRows = Array.isArray(checks.stock.result)
    ? checks.stock.result.filter(isRecord)
    : [];
  const matchingStocks = stockRows.filter(
    (item) => stringOrUndefined(item.symbol)?.toUpperCase() === order.symbol,
  );
  const stock = matchingStocks.length === 1 ? matchingStocks[0] : undefined;
  if (
    !Array.isArray(checks.stock.result) ||
    stockRows.length !== checks.stock.result.length ||
    !stock
  ) {
    issues.push(`Stock lookup did not return the requested symbol ${order.symbol}.`);
  } else if (stringOrUndefined(stock.status) !== "ACTIVE") {
    issues.push(`Symbol ${order.symbol} is not ACTIVE.`);
  } else if (
    !referenceCurrency ||
    stringOrUndefined(stock.currency) !== referenceCurrency
  ) {
    issues.push(`Stock lookup returned an invalid currency for ${order.symbol}.`);
  } else {
    const marketDetail = recordOrUndefined(stock.koreanMarketDetail);
    if (marketDetail?.liquidationTrading === true) {
      issues.push(`Symbol ${order.symbol} is in liquidation trading.`);
    }
    if (
      marketDetail?.krxTradingSuspended === true ||
      marketDetail?.nxtTradingSuspended === true
    ) {
      issues.push(`Symbol ${order.symbol} has a suspended Korean market venue.`);
    }
  }

  const quote = referenceQuote(checks.price.result, order.symbol);
  if (!quote || quote.currency !== referenceCurrency) {
    issues.push(
      `Price lookup did not return one valid ${order.symbol} quote with a supported currency.`,
    );
  }

  const warningRows = arrayRecords(checks.warnings.result);
  if (
    !Array.isArray(checks.warnings.result) ||
    warningRows.length !== checks.warnings.result.length
  ) {
    issues.push("Stock-warning response was malformed.");
  } else if (warningRows.length) {
    const warningTypes = warningRows
      .map((item) => stringOrUndefined(item.warningType) ?? "UNKNOWN")
      .join(", ");
    issues.push(`Symbol ${order.symbol} has active stock warnings: ${warningTypes}.`);
  }

  const limits = recordOrUndefined(checks.priceLimit.result);
  const limitCurrency = stringOrUndefined(limits?.currency);
  const hasLimitFields = Boolean(
    limits &&
    "lowerLimitPrice" in limits &&
    "upperLimitPrice" in limits,
  );
  if (!limits || limitCurrency !== referenceCurrency || !hasLimitFields) {
    issues.push("Price-limit response was malformed or used the wrong currency.");
  } else if (referenceCurrency === "KRW") {
    const lower = numberOrUndefined(limits.lowerLimitPrice);
    const upper = numberOrUndefined(limits.upperLimitPrice);
    if (lower === undefined || upper === undefined) {
      issues.push("KR price-limit response did not contain numeric bounds.");
    }
  }

  if (order.orderType === "LIMIT" && order.price && limits) {
    const price = Number(order.price);
    const lower = numberOrUndefined(limits?.lowerLimitPrice);
    const upper = numberOrUndefined(limits?.upperLimitPrice);
    if (lower !== undefined && price < lower) {
      issues.push(`Order price ${order.price} is below lower limit ${lower}.`);
    }
    if (upper !== undefined && price > upper) {
      issues.push(`Order price ${order.price} is above upper limit ${upper}.`);
    }
  }

  const commissionRows = arrayRecords(checks.commissions.result);
  const marketCountry = referenceCurrency === "KRW" ? "KR" : "US";
  const matchingCommission = commissionRows.find(
    (item) =>
      stringOrUndefined(item.marketCountry) === marketCountry &&
      numberOrUndefined(item.commissionRate) !== undefined,
  );
  if (
    !Array.isArray(checks.commissions.result) ||
    commissionRows.length !== checks.commissions.result.length ||
    !matchingCommission
  ) {
    issues.push(`Commission response did not contain a valid ${marketCountry} rate.`);
  }

  if (order.side === "BUY" && checks.buyingPower?.ok) {
    const buyingPower = recordOrUndefined(checks.buyingPower.result);
    const buyingPowerCurrency = stringOrUndefined(buyingPower?.currency);
    const available = numberOrUndefined(
      buyingPower?.cashBuyingPower ?? buyingPower?.amount,
    );
    const estimatedNotional = policy.estimatedNotional;
    const required = estimatedNotional &&
      estimatedNotional.currency === referenceCurrency
      ? numberOrUndefined(estimatedNotional.amount)
      : undefined;
    if (buyingPowerCurrency !== referenceCurrency || available === undefined) {
      issues.push("Buying-power response used the wrong currency or had no usable amount.");
    } else if (required === undefined) {
      issues.push("Order notional could not be estimated for buying-power validation.");
    } else if (available < required) {
      issues.push(`Buying power ${available} is below estimated notional ${required}.`);
    }
  }

  if (order.side === "SELL" && checks.sellableQuantity?.ok) {
    const sellable = recordOrUndefined(checks.sellableQuantity.result);
    const available = numberOrUndefined(sellable?.sellableQuantity);
    const requested = numberOrUndefined(order.quantity);
    if (available === undefined) {
      issues.push("Sellable-quantity response did not contain a usable quantity.");
    } else if (requested === undefined || available < requested) {
      issues.push(`Sellable quantity ${available} is below requested quantity ${order.quantity}.`);
    }
  }

  const regularOnly = Boolean(order.orderAmount) ||
    Boolean(order.quantity?.includes("."));
  const closeCutoffMinutes = regularOnly ? 60 : 0;
  if (!isMarketSessionOpen(checks.calendar.result, regularOnly, closeCutoffMinutes)) {
    issues.push(
      regularOnly
        ? "This order type is available only from regular market open until one hour before regular market close."
        : "No supported market session is currently open.",
    );
  }

  if (checks.openOrders?.ok) {
    const result = recordOrUndefined(checks.openOrders.result);
    const openOrders = Array.isArray(result?.orders)
      ? result.orders.filter(isRecord)
      : undefined;
    if (
      !openOrders ||
      openOrders.length !== (result?.orders as unknown[] | undefined)?.length
    ) {
      issues.push("Open-order response was malformed.");
    } else if (
      openOrders.some(
        (item) => stringOrUndefined(item.symbol)?.toUpperCase() !== order.symbol,
      )
    ) {
      issues.push("Open-order response contained an unexpected symbol.");
    } else if (openOrders.length) {
      issues.push(`An open order already exists for symbol ${order.symbol}.`);
    }
  }

  return issues;
}

function isMarketSessionOpen(
  value: unknown,
  regularOnly: boolean,
  closeCutoffMinutes = 0,
) {
  const result = recordOrUndefined(value);
  if (!result) {
    return false;
  }
  const today = recordOrUndefined(result.today);
  if (!today) {
    return false;
  }
  const market = recordOrUndefined(today.integrated) ?? today;
  const sessionNames = regularOnly
    ? ["regularMarket"]
    : ["dayMarket", "preMarket", "regularMarket", "afterMarket"];
  const now = Date.now();
  return sessionNames.some((name) => {
    const session = recordOrUndefined(market[name]);
    const start = session ? Date.parse(String(session.startTime ?? "")) : Number.NaN;
    const end = session ? Date.parse(String(session.endTime ?? "")) : Number.NaN;
    const cutoffEnd = end - closeCutoffMinutes * 60 * 1000;
    return (
      Number.isFinite(start) &&
      Number.isFinite(cutoffEnd) &&
      start <= now &&
      now <= cutoffEnd
    );
  });
}

function firstRecord(value: unknown) {
  return arrayRecords(value)[0] ?? recordOrUndefined(value);
}

function arrayRecords(value: unknown) {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function recordOrUndefined(value: unknown) {
  return isRecord(value) ? value : undefined;
}

function numberOrUndefined(value: unknown) {
  const parsed = Number(value);
  return value !== undefined && value !== null && value !== "" && Number.isFinite(parsed)
    ? parsed
    : undefined;
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

function referenceQuote(value: unknown, symbol: string) {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const matches = value.filter(
    (item) =>
      isRecord(item) &&
      stringOrUndefined(item.symbol)?.toUpperCase() === symbol.toUpperCase(),
  );
  if (matches.length !== 1 || !isRecord(matches[0])) {
    return undefined;
  }
  const price = stringOrUndefined(matches[0].lastPrice);
  const currency = stringOrUndefined(matches[0].currency);
  if (
    !price ||
    !/^\d+(\.\d+)?$/.test(price) ||
    Number(price) <= 0 ||
    (currency !== "KRW" && currency !== "USD")
  ) {
    return undefined;
  }
  return { price, currency: currency as "KRW" | "USD" };
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
