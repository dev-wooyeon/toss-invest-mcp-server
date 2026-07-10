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

type PolicyEvaluationOptions = {
  liveExecution: boolean;
  referencePrice?: string;
  referenceCurrency?: "KRW" | "USD";
  enforceTradingMode?: boolean;
  requireClientOrderId?: boolean;
};

const HIGH_VALUE_ORDER_KRW = 100_000_000;

export function parseOrderDraft(value: unknown): OrderDraft {
  if (!isRecord(value)) {
    throw new Error("Order body must be an object.");
  }
  assertKnownFields(
    value,
    [
      "clientOrderId",
      "symbol",
      "side",
      "orderType",
      "timeInForce",
      "quantity",
      "price",
      "orderAmount",
      "confirmHighValueOrder",
    ],
    "Order body",
  );

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
  optionalBoolean(value.confirmHighValueOrder, "confirmHighValueOrder");

  if (clientOrderId && !/^[a-zA-Z0-9\-_]{1,36}$/.test(clientOrderId)) {
    throw new Error(
      "clientOrderId must be 1-36 characters and contain only letters, numbers, hyphen, or underscore.",
    );
  }

  if (
    quantity &&
    !/^\d+$/.test(quantity) &&
    !(
      !isLikelyKoreanSymbol(symbol) &&
      side === "SELL" &&
      orderType === "MARKET" &&
      /^\d+\.\d{1,6}$/.test(quantity)
    )
  ) {
    throw new Error(
      "Fractional quantity is supported only for US MARKET SELL orders, up to 6 decimal places.",
    );
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
  options: PolicyEvaluationOptions = {
    liveExecution: false,
  },
): PolicyDecision {
  const policy = config.tradingPolicy;
  const errors: string[] = [];
  const warnings: string[] = [];
  const symbol = order.symbol.toUpperCase();
  const requireClientOrderId =
    options.requireClientOrderId ?? policy.requireClientOrderId;

  if (options.liveExecution) {
    errors.push(
      ...liveTradingConfigurationErrors(config, {
        currency: options.referenceCurrency ?? currencyForSymbol(symbol),
      }),
    );
  }

  applySymbolPolicy(policy, symbol, errors);

  if (requireClientOrderId && !order.clientOrderId) {
    const message =
      "clientOrderId is required by policy for idempotent live-order handling.";
    if (options.liveExecution) {
      errors.push(message);
    } else {
      warnings.push(message);
    }
  }

  const orderCurrency = options.referenceCurrency ?? currencyForSymbol(symbol);
  const estimatedNotional = estimateNotional(
    order,
    options.referencePrice,
    orderCurrency,
  );

  if (order.orderAmount && orderCurrency !== "USD") {
    errors.push("orderAmount is supported only for USD-denominated US orders.");
  }

  if (
    order.timeInForce === "CLS" &&
    (orderCurrency !== "USD" || order.orderType !== "LIMIT")
  ) {
    errors.push("timeInForce=CLS is supported only for US LIMIT orders.");
  }

  if (
    order.orderType === "MARKET" &&
    order.quantity &&
    !policy.allowMarketOrderWithoutPrice
  ) {
    const message =
      "Quantity-based MARKET orders have no deterministic notional estimate because reference prices are non-binding. Use LIMIT, orderAmount, or set TOSSINVEST_ALLOW_MARKET_ORDER_WITHOUT_PRICE=true.";
    if (options.liveExecution) {
      errors.push(message);
    } else {
      warnings.push(message);
    }
  } else if (
    options.liveExecution &&
    order.orderType === "MARKET" &&
    order.quantity &&
    !estimatedNotional
  ) {
    errors.push(
      "Quantity-based MARKET orders require a current reference price so the configured order limit can be enforced.",
    );
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

  if (
    options.liveExecution &&
    options.enforceTradingMode !== false &&
    config.tradingMode !== "LIVE_TRADING"
  ) {
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

export function assertLiveTradingPolicy(
  config: TossConfig,
  body: unknown,
  options: {
    referencePrice?: string;
    referenceCurrency?: "KRW" | "USD";
  } = {},
) {
  const order = parseOrderDraft(body);
  const decision = evaluateOrderPolicy(config, order, {
    liveExecution: true,
    referencePrice: options.referencePrice,
    referenceCurrency: options.referenceCurrency,
    requireClientOrderId: true,
  });
  if (!decision.allowed) {
    throw new Error(`Trading policy rejected order: ${decision.errors.join(" ")}`);
  }
}

export function assertLiveTradingConfiguration(config: TossConfig) {
  const errors = liveTradingConfigurationErrors(config);
  if (errors.length) {
    throw new Error(`Trading policy configuration is incomplete: ${errors.join(" ")}`);
  }
}

export function assertOrderModificationPolicy(
  config: TossConfig,
  currentOrder: unknown,
  body: unknown,
  options: {
    referencePrice?: string;
    referenceCurrency?: "KRW" | "USD";
  } = {},
) {
  if (!isRecord(currentOrder) || !isRecord(body)) {
    throw new Error("Order modification policy requires the current order and body.");
  }
  assertKnownFields(
    body,
    ["orderType", "quantity", "price", "confirmHighValueOrder"],
    "Order modification body",
  );
  optionalBoolean(body.confirmHighValueOrder, "confirmHighValueOrder");

  const symbol = requiredString(currentOrder.symbol, "currentOrder.symbol").toUpperCase();
  const side = enumString(currentOrder.side, "currentOrder.side", ["BUY", "SELL"]);
  const currency = enumString(currentOrder.currency, "currentOrder.currency", [
    "KRW",
    "USD",
  ]);
  if (options.referenceCurrency && options.referenceCurrency !== currency) {
    throw new Error(
      "Order modification quote currency does not match the current order currency.",
    );
  }
  const orderType = enumString(body.orderType, "orderType", ["LIMIT", "MARKET"]);
  const requestedQuantity = optionalDecimalString(body.quantity, "quantity");
  if (currency === "KRW" && !requestedQuantity) {
    throw new Error("quantity is required when modifying a KR order.");
  }
  if (currency === "KRW" && requestedQuantity && !/^\d+$/.test(requestedQuantity)) {
    throw new Error("KR order modification quantity must be a positive integer string.");
  }
  if (currency === "USD" && body.quantity !== undefined) {
    throw new Error("quantity must be omitted when modifying a US order.");
  }
  const quantity = requestedQuantity ??
    optionalDecimalString(currentOrder.quantity, "currentOrder.quantity");
  const price = optionalDecimalString(body.price, "price");

  const draft = parseOrderDraft({
    symbol,
    side,
    orderType,
    quantity,
    ...(price ? { price } : {}),
    confirmHighValueOrder: body.confirmHighValueOrder,
  });
  const decision = evaluateOrderPolicy(config, draft, {
    liveExecution: true,
    referencePrice: options.referencePrice,
    referenceCurrency: currency,
    requireClientOrderId: false,
  });
  assertAllowedDecision(decision, "order modification");
}

export function assertConditionalOrderPolicy(
  config: TossConfig,
  body: unknown,
  options: {
    symbol?: string;
    requireClientOrderId: boolean;
    referenceCurrency?: "KRW" | "USD";
    currentPrice?: string;
  },
) {
  if (!isRecord(body)) {
    throw new Error("Conditional order body must be an object.");
  }
  const isModification = options.symbol !== undefined;
  assertKnownFields(
    body,
    isModification
      ? [
          "type",
          "quantity",
          "orderType",
          "expireDate",
          "first",
          "second",
          "confirmHighValueOrder",
        ]
      : [
          "clientOrderId",
          "symbol",
          "type",
          "quantity",
          "orderType",
          "expireDate",
          "first",
          "second",
          "confirmHighValueOrder",
        ],
    "Conditional order body",
  );
  optionalBoolean(body.confirmHighValueOrder, "confirmHighValueOrder");

  const symbol = (
    options.symbol ?? requiredString(body.symbol, "symbol")
  ).toUpperCase();
  const conditionalType = enumString(body.type, "type", ["SINGLE", "OCO", "OTO"]);
  const orderType = enumString(body.orderType, "orderType", ["LIMIT", "MARKET"]);
  const expireDate = requiredString(body.expireDate, "expireDate");
  if (!isIsoCalendarDate(expireDate)) {
    throw new Error("expireDate must be a valid YYYY-MM-DD calendar date.");
  }
  const quantity = requiredString(body.quantity, "quantity");
  optionalDecimalString(quantity, "quantity");
  const clientOrderId = optionalString(body.clientOrderId, "clientOrderId");
  if (clientOrderId && !/^[a-zA-Z0-9\-_]{1,36}$/.test(clientOrderId)) {
    throw new Error(
      "clientOrderId must be 1-36 characters and contain only letters, numbers, hyphen, or underscore.",
    );
  }

  if (conditionalType === "SINGLE" && body.second != null) {
    throw new Error("second must be omitted for SINGLE conditional orders.");
  }
  if (conditionalType !== "SINGLE" && !isRecord(body.second)) {
    throw new Error(`second is required for ${conditionalType} conditional orders.`);
  }
  if (conditionalType !== "SINGLE" && orderType !== "LIMIT") {
    throw new Error(`${conditionalType} conditional orders support only LIMIT orders.`);
  }

  const first = parseConditionalLeg(body.first, "first", orderType);
  const second = conditionalType === "SINGLE"
    ? undefined
    : parseConditionalLeg(body.second, "second", orderType);

  if (conditionalType === "OCO") {
    if (first.side !== "SELL" || second?.side !== "SELL") {
      throw new Error("OCO conditional orders require SELL for both legs.");
    }
    const currentPrice = optionalDecimalString(options.currentPrice, "currentPrice");
    if (!currentPrice) {
      throw new Error(
        "OCO conditional orders require a current reference price for trigger validation.",
      );
    }
    if (
      Number(first.triggerPrice) <= Number(currentPrice) ||
      Number(currentPrice) <= Number(second.triggerPrice)
    ) {
      throw new Error(
        "OCO trigger prices must satisfy first.triggerPrice > current price > second.triggerPrice.",
      );
    }
  }
  if (
    conditionalType === "OTO" &&
    (first.side !== "BUY" || second?.side !== "SELL")
  ) {
    throw new Error("OTO conditional orders require first=BUY and second=SELL.");
  }

  const legs = second ? [first, second] : [first];
  const errors: string[] = [];
  for (const leg of legs) {
    const decision = evaluateOrderPolicy(
      config,
      {
        clientOrderId,
        symbol,
        side: leg.side,
        orderType,
        quantity,
        price: leg.orderPrice,
        confirmHighValueOrder:
          typeof body.confirmHighValueOrder === "boolean"
            ? body.confirmHighValueOrder
            : undefined,
      },
      {
        liveExecution: true,
        referencePrice: leg.triggerPrice,
        referenceCurrency: options.referenceCurrency,
        requireClientOrderId: options.requireClientOrderId,
      },
    );
    errors.push(...decision.errors);
  }

  if (errors.length) {
    throw new Error(
      `Trading policy rejected conditional order: ${[...new Set(errors)].join(" ")}`,
    );
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

function liveTradingConfigurationErrors(
  config: TossConfig,
  options: { currency?: "KRW" | "USD" } = {},
) {
  const errors: string[] = [];
  const policy = config.tradingPolicy;
  if (!policy.allowedSymbols?.length) {
    errors.push("TOSSINVEST_ALLOWED_SYMBOLS must contain at least one symbol.");
  }
  if (!policy.requireClientOrderId) {
    errors.push("TOSSINVEST_REQUIRE_CLIENT_ORDER_ID must remain true.");
  }
  if (options.currency === "KRW" && policy.maxOrderAmountKrw === undefined) {
    errors.push("TOSSINVEST_MAX_ORDER_AMOUNT_KRW must be configured.");
  } else if (options.currency === "USD" && policy.maxOrderAmountUsd === undefined) {
    errors.push("TOSSINVEST_MAX_ORDER_AMOUNT_USD must be configured.");
  } else if (
    !options.currency &&
    policy.maxOrderAmountKrw === undefined &&
    policy.maxOrderAmountUsd === undefined
  ) {
    errors.push("At least one live-order amount limit must be configured.");
  }
  return errors;
}

function parseConditionalLeg(
  value: unknown,
  field: string,
  orderType: "LIMIT" | "MARKET",
) {
  if (!isRecord(value)) {
    throw new Error(`${field} must be an object.`);
  }
  assertKnownFields(value, ["orderSide", "triggerPrice", "orderPrice"], field);
  const side = enumString(value.orderSide, `${field}.orderSide`, ["BUY", "SELL"]);
  const triggerPrice = requiredString(value.triggerPrice, `${field}.triggerPrice`);
  optionalDecimalString(triggerPrice, `${field}.triggerPrice`);
  const orderPrice = optionalString(value.orderPrice, `${field}.orderPrice`);
  if (orderType === "LIMIT" && !orderPrice) {
    throw new Error(`${field}.orderPrice is required for LIMIT conditional orders.`);
  }
  if (orderType === "MARKET" && orderPrice) {
    throw new Error(`${field}.orderPrice must be omitted for MARKET conditional orders.`);
  }
  if (orderPrice) {
    optionalDecimalString(orderPrice, `${field}.orderPrice`);
  }
  return { side, triggerPrice, orderPrice };
}

function assertAllowedDecision(decision: PolicyDecision, label: string) {
  if (!decision.allowed) {
    throw new Error(`Trading policy rejected ${label}: ${decision.errors.join(" ")}`);
  }
}

function estimateNotional(
  order: OrderDraft,
  referencePrice?: string,
  referenceCurrency?: "KRW" | "USD",
) {
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
    currency: referenceCurrency ?? currencyForSymbol(order.symbol),
    source: "quantityPrice" as const,
  };
}

function isIsoCalendarDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value;
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

function optionalBoolean(value: unknown, field: string) {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(`${field} must be a boolean.`);
  }
  return value;
}

function assertKnownFields(
  value: Record<string, unknown>,
  allowedFields: readonly string[],
  label: string,
) {
  const allowed = new Set(allowedFields);
  const unknownFields = Object.keys(value).filter((field) => !allowed.has(field));
  if (unknownFields.length) {
    throw new Error(
      `${label} contains unsupported fields: ${unknownFields.sort().join(", ")}.`,
    );
  }
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
