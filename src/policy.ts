import type { TossConfig, TradingPolicyConfig } from "./types.js";

export type OrderDraft = {
  clientOrderId?: string;
  symbol: string;
  side: "BUY" | "SELL";
  orderType: "LIMIT" | "MARKET";
  timeInForce?: "DAY" | "CLS";
  quantity?: string;
  price?: string;
  orderAmount?: string;
  confirmHighValueOrder?: boolean;
};

export type PolicyDecision = {
  allowed: boolean;
  mode: string;
  errors: string[];
  warnings: string[];
  estimatedNotional?: {
    amount: string;
    currency: "KRW" | "USD";
    source: "orderAmount" | "quantityPrice";
  };
};

const HIGH_VALUE_ORDER_KRW = 100_000_000;

export function parseOrderDraft(value: unknown): OrderDraft {
  if (!isRecord(value)) {
    throw new Error("Order body must be an object.");
  }

  const symbol = requiredString(value.symbol, "symbol").toUpperCase();
  const side = enumString(value.side, "side", ["BUY", "SELL"]);
  const orderType = enumString(value.orderType, "orderType", ["LIMIT", "MARKET"]);
  const timeInForce = optionalEnumString(value.timeInForce, "timeInForce", [
    "DAY",
    "CLS",
  ]);
  const quantity = optionalDecimalString(value.quantity, "quantity");
  const price = optionalDecimalString(value.price, "price");
  const orderAmount = optionalDecimalString(value.orderAmount, "orderAmount");
  const clientOrderId = optionalString(value.clientOrderId, "clientOrderId");

  if (clientOrderId && !/^[a-zA-Z0-9\-_]{1,36}$/.test(clientOrderId)) {
    throw new Error(
      "clientOrderId must be 1-36 characters and contain only letters, numbers, hyphen, or underscore.",
    );
  }

  if (quantity && !/^\d+$/.test(quantity)) {
    throw new Error("quantity must be a positive integer string.");
  }

  if (orderType === "LIMIT" && !price) {
    throw new Error("LIMIT orders require price.");
  }

  if (orderType === "MARKET" && price) {
    throw new Error("MARKET orders must not include price.");
  }

  if (quantity && orderAmount) {
    throw new Error("Use either quantity or orderAmount, not both.");
  }

  if (!quantity && !orderAmount) {
    throw new Error("Order body requires quantity or orderAmount.");
  }

  if (orderAmount && orderType !== "MARKET") {
    throw new Error("orderAmount is only supported for MARKET orders.");
  }

  if (orderAmount && isLikelyKoreanSymbol(symbol)) {
    throw new Error("orderAmount is only supported for US market orders.");
  }

  return {
    clientOrderId,
    symbol,
    side,
    orderType,
    timeInForce,
    quantity,
    price,
    orderAmount,
    confirmHighValueOrder:
      typeof value.confirmHighValueOrder === "boolean"
        ? value.confirmHighValueOrder
        : undefined,
  };
}

export function evaluateOrderPolicy(
  config: TossConfig,
  order: OrderDraft,
  options: { liveExecution: boolean; referencePrice?: string } = {
    liveExecution: false,
  },
): PolicyDecision {
  const policy = config.tradingPolicy;
  const errors: string[] = [];
  const warnings: string[] = [];
  const symbol = order.symbol.toUpperCase();

  applySymbolPolicy(policy, symbol, errors);

  if (policy.requireClientOrderId && !order.clientOrderId) {
    const message =
      "clientOrderId is required by policy for idempotent live-order handling.";
    if (options.liveExecution) {
      errors.push(message);
    } else {
      warnings.push(message);
    }
  }

  const estimatedNotional = estimateNotional(order, options.referencePrice);

  if (
    order.orderType === "MARKET" &&
    order.quantity &&
    !estimatedNotional &&
    !policy.allowMarketOrderWithoutPrice
  ) {
    const message =
      "Quantity-based MARKET orders have no deterministic notional estimate. Use LIMIT, orderAmount, or set TOSSINVEST_ALLOW_MARKET_ORDER_WITHOUT_PRICE=true.";
    if (options.liveExecution) {
      errors.push(message);
    } else {
      warnings.push(message);
    }
  }

  if (estimatedNotional) {
    if (
      estimatedNotional.currency === "KRW" &&
      policy.maxOrderAmountKrw !== undefined &&
      Number(estimatedNotional.amount) > policy.maxOrderAmountKrw
    ) {
      errors.push(
        `Estimated KRW notional ${estimatedNotional.amount} exceeds TOSSINVEST_MAX_ORDER_AMOUNT_KRW=${policy.maxOrderAmountKrw}.`,
      );
    }
    if (
      estimatedNotional.currency === "USD" &&
      policy.maxOrderAmountUsd !== undefined &&
      Number(estimatedNotional.amount) > policy.maxOrderAmountUsd
    ) {
      errors.push(
        `Estimated USD notional ${estimatedNotional.amount} exceeds TOSSINVEST_MAX_ORDER_AMOUNT_USD=${policy.maxOrderAmountUsd}.`,
      );
    }
    if (
      estimatedNotional.currency === "KRW" &&
      Number(estimatedNotional.amount) >= HIGH_VALUE_ORDER_KRW &&
      order.confirmHighValueOrder !== true
    ) {
      errors.push(
        "Estimated KRW notional is at least 100,000,000; confirmHighValueOrder=true is required by Toss Invest API.",
      );
    }
  }

  if (options.liveExecution && config.tradingMode !== "LIVE_TRADING") {
    errors.push(
      "Live trading is disabled. Set TOSSINVEST_TRADING_MODE=LIVE_TRADING only when intentional.",
    );
  }

  return {
    allowed: errors.length === 0,
    mode: config.tradingMode,
    errors,
    warnings,
    estimatedNotional,
  };
}

export function assertLiveTradingPolicy(config: TossConfig, body: unknown) {
  const order = parseOrderDraft(body);
  const decision = evaluateOrderPolicy(config, order, { liveExecution: true });
  if (!decision.allowed) {
    throw new Error(`Trading policy rejected order: ${decision.errors.join(" ")}`);
  }
}

export function isLikelyKoreanSymbol(symbol: string) {
  return /^\d{6}$/.test(symbol);
}

export function currencyForSymbol(symbol: string): "KRW" | "USD" {
  return isLikelyKoreanSymbol(symbol) ? "KRW" : "USD";
}

function applySymbolPolicy(
  policy: TradingPolicyConfig,
  symbol: string,
  errors: string[],
) {
  if (policy.blockedSymbols.includes(symbol)) {
    errors.push(`Symbol ${symbol} is blocked by TOSSINVEST_BLOCKED_SYMBOLS.`);
  }
  if (policy.allowedSymbols?.length && !policy.allowedSymbols.includes(symbol)) {
    errors.push(`Symbol ${symbol} is not in TOSSINVEST_ALLOWED_SYMBOLS.`);
  }
}

function estimateNotional(order: OrderDraft, referencePrice?: string) {
  if (order.orderAmount) {
    return {
      amount: normalizeDecimal(order.orderAmount),
      currency: "USD" as const,
      source: "orderAmount" as const,
    };
  }

  const price = order.price ?? referencePrice;
  if (!order.quantity || !price) {
    return undefined;
  }

  return {
    amount: normalizeDecimal(String(Number(order.quantity) * Number(price))),
    currency: currencyForSymbol(order.symbol),
    source: "quantityPrice" as const,
  };
}

function normalizeDecimal(value: string) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return value;
  }
  return Number.isInteger(parsed) ? String(parsed) : parsed.toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
}

function requiredString(value: unknown, field: string) {
  const result = optionalString(value, field);
  if (!result) {
    throw new Error(`${field} is required.`);
  }
  return result;
}

function optionalString(value: unknown, field: string) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string.`);
  }
  return value;
}

function optionalDecimalString(value: unknown, field: string) {
  const result = optionalString(value, field);
  if (!result) {
    return undefined;
  }
  if (!/^\d+(\.\d+)?$/.test(result) || Number(result) <= 0) {
    throw new Error(`${field} must be a positive decimal string.`);
  }
  return result;
}

function enumString<T extends string>(
  value: unknown,
  field: string,
  values: readonly T[],
): T {
  const result = requiredString(value, field).toUpperCase();
  if (!values.includes(result as T)) {
    throw new Error(`${field} must be one of ${values.join(", ")}.`);
  }
  return result as T;
}

function optionalEnumString<T extends string>(
  value: unknown,
  field: string,
  values: readonly T[],
) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  return enumString(value, field, values);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
