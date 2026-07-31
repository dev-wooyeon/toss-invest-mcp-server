import { openapi } from "./spec.js";
import { normalizeDecimal } from "./decimal.js";
import type { TossConfig, TradingMode } from "./types.js";

const OFFICIAL_BASE_URL = "https://openapi.tossinvest.com";

export function getConfig(env: NodeJS.ProcessEnv = process.env): TossConfig {
  const tradingMode = parseTradingMode(env);

  return {
    baseUrl: resolveBaseUrl(
      env.TOSSINVEST_BASE_URL ?? openapi.servers?.[0]?.url ?? OFFICIAL_BASE_URL,
    ),
    clientId: emptyToUndefined(env.TOSSINVEST_CLIENT_ID),
    clientSecret: emptyToUndefined(env.TOSSINVEST_CLIENT_SECRET),
    defaultAccount: emptyToUndefined(env.TOSSINVEST_ACCOUNT),
    enableTrading: tradingMode === "LIVE_TRADING",
    tradingMode,
    retry: {
      maxRetries: parseInteger(env.TOSSINVEST_MAX_RETRIES, 2),
      baseDelayMs: parseInteger(env.TOSSINVEST_RETRY_BASE_DELAY_MS, 500),
      maxDelayMs: parseInteger(env.TOSSINVEST_RETRY_MAX_DELAY_MS, 5000),
      requestTimeoutMs: parseIntegerInRange(
        env.TOSSINVEST_REQUEST_TIMEOUT_MS,
        15_000,
        1_000,
        120_000,
        "TOSSINVEST_REQUEST_TIMEOUT_MS",
      ),
    },
    tradingPolicy: {
      mode: tradingMode,
      allowedSymbols: parseCsv(env.TOSSINVEST_ALLOWED_SYMBOLS),
      blockedSymbols: parseCsv(env.TOSSINVEST_BLOCKED_SYMBOLS) ?? [],
      maxOrderAmountKrw: parseDecimal(env.TOSSINVEST_MAX_ORDER_AMOUNT_KRW),
      maxOrderAmountUsd: parseDecimal(env.TOSSINVEST_MAX_ORDER_AMOUNT_USD),
      requireClientOrderId: env.TOSSINVEST_REQUIRE_CLIENT_ORDER_ID
        ? parseBoolean(env.TOSSINVEST_REQUIRE_CLIENT_ORDER_ID)
        : true,
      allowMarketOrderWithoutPrice: parseBoolean(
        env.TOSSINVEST_ALLOW_MARKET_ORDER_WITHOUT_PRICE,
      ),
    },
    audit: {
      enabled: env.TOSSINVEST_AUDIT_LOG
        ? parseBoolean(env.TOSSINVEST_AUDIT_LOG)
        : true,
      logPath:
        emptyToUndefined(env.TOSSINVEST_AUDIT_LOG_PATH) ??
        "audit/toss-invest-mcp-audit.jsonl",
    },
  };
}

export function getAuthStatus(config: TossConfig, tokenExpiresAt?: number) {
  return {
    baseUrl: config.baseUrl,
    hasClientId: Boolean(config.clientId),
    hasClientSecret: Boolean(config.clientSecret),
    hasDefaultAccount: Boolean(config.defaultAccount),
    tradingMode: config.tradingMode,
    tradingEnabled: config.enableTrading,
    retry: config.retry,
    audit: {
      enabled: config.audit.enabled,
      logPath: config.audit.enabled ? config.audit.logPath : undefined,
    },
    tradingPolicy: {
      allowedSymbolsConfigured: Boolean(config.tradingPolicy.allowedSymbols?.length),
      blockedSymbolCount: config.tradingPolicy.blockedSymbols.length,
      maxOrderAmountKrw: config.tradingPolicy.maxOrderAmountKrw,
      maxOrderAmountUsd: config.tradingPolicy.maxOrderAmountUsd,
      requireClientOrderId: config.tradingPolicy.requireClientOrderId,
      allowMarketOrderWithoutPrice:
        config.tradingPolicy.allowMarketOrderWithoutPrice,
    },
    tokenCached: Boolean(tokenExpiresAt && tokenExpiresAt > Date.now()),
    tokenExpiresAt: tokenExpiresAt
      ? new Date(tokenExpiresAt).toISOString()
      : undefined,
    credentialPolicy:
      "ClientId, ClientSecret, access tokens, and the default accountSeq environment value are read only from this server process environment and are never returned by metadata tools.",
  };
}

function emptyToUndefined(value: string | undefined) {
  return value && value.trim() ? value : undefined;
}

function parseBoolean(value: string | undefined) {
  return ["1", "true", "yes", "y", "on"].includes(
    (value ?? "").trim().toLowerCase(),
  );
}

function parseTradingMode(env: NodeJS.ProcessEnv): TradingMode {
  if (env.TOSSINVEST_TRADING_MODE !== undefined) {
    const value = env.TOSSINVEST_TRADING_MODE.trim().toUpperCase();
    if (value === "READ_ONLY" || value === "DRY_RUN" || value === "LIVE_TRADING") {
      return value;
    }
    return "READ_ONLY";
  }

  if (parseBoolean(env.TOSSINVEST_ENABLE_TRADING)) {
    return "LIVE_TRADING";
  }
  return "READ_ONLY";
}

function parseCsv(value: string | undefined) {
  const items = (value ?? "")
    .split(",")
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean);
  return items.length ? items : undefined;
}

function parseInteger(value: string | undefined, fallback: number) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseIntegerInRange(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
  name: string,
) {
  if (value === undefined || !value.trim()) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  return parsed;
}

function parseDecimal(value: string | undefined) {
  if (!value || !value.trim()) {
    return undefined;
  }
  return normalizeDecimal(value.trim());
}

function resolveBaseUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("TOSSINVEST_BASE_URL must be a valid absolute URL.");
  }

  const hasUnexpectedParts =
    Boolean(url.username || url.password || url.search || url.hash) ||
    url.pathname !== "/";
  if (hasUnexpectedParts) {
    throw new Error(
      "TOSSINVEST_BASE_URL must not include credentials, a path, query, or fragment.",
    );
  }

  if (url.origin === OFFICIAL_BASE_URL) {
    return OFFICIAL_BASE_URL;
  }

  if (
    (url.protocol === "http:" || url.protocol === "https:") &&
    isLoopbackHost(url.hostname)
  ) {
    return url.origin;
  }

  throw new Error(
    "TOSSINVEST_BASE_URL must use https://openapi.tossinvest.com. HTTP(S) overrides are allowed only for a loopback test server.",
  );
}

function isLoopbackHost(host: string) {
  return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(host);
}
