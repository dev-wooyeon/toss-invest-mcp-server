import {
  accountSeqFromArgs,
  getOperation,
  resolveParameter,
  resolveRequestBody,
} from "./spec.js";
import {
  assertConditionalOrderPolicy,
  assertLiveTradingConfiguration,
  assertLiveTradingPolicy,
  assertOrderModificationPolicy,
  parseOrderDraft,
} from "./policy.js";
import type { CallArgs, OperationRecord, TossConfig } from "./types.js";

type TokenState = {
  accessToken: string;
  expiresAt: number;
};

export type TossResponse = {
  ok: boolean;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: unknown;
  error?: NormalizedApiError;
  attempts: number;
  outcomeUnknown?: boolean;
  submissionPhase?: "submission_started" | "response_received";
};

export type NormalizedApiError = {
  requestId?: string;
  code: string;
  message: string;
  data?: unknown;
  status: number;
  retryAfter?: string;
};

export class TossInvestClient {
  private token?: TokenState;
  private tokenRefresh?: Promise<string>;

  constructor(private readonly config: TossConfig) {}

  get tokenExpiresAt() {
    return this.token?.expiresAt;
  }

  async callOperation(record: OperationRecord, args: CallArgs): Promise<TossResponse> {
    if (record.operation.operationId === "issueOAuth2Token") {
      throw new Error(
        "OAuth token issuance is managed internally and is not exposed as an MCP tool.",
      );
    }

    if (record.isTradingMutation) {
      assertTradingAllowed(this.config, args);
      assertLiveTradingConfiguration(this.config);
      await this.assertMutationPolicy(record, args);
    }

    const url = buildOperationUrl(this.config.baseUrl, record, args);
    const accessToken = await this.getAccessToken();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
    };

    if (record.requiresAccount) {
      const accountSeq = accountSeqFromArgs(args) ?? this.config.defaultAccount;
      if (!accountSeq) {
        throw new Error(
          "This Toss Invest API requires an accountSeq. Set TOSSINVEST_ACCOUNT on the MCP server or pass accountSeq to the tool. Do not pass ClientId or Secret as tool input.",
        );
      }
      headers["X-Tossinvest-Account"] = accountSeq;
    }

    const requestBody = resolveRequestBody(record.operation.requestBody);
    const init: RequestInit = {
      method: record.method.toUpperCase(),
      headers,
    };

    if (requestBody) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(args.body ?? {});
    }

    // Toss Invest retains create-order idempotency keys for only 10 minutes.
    // Never automatically retry a mutation after an ambiguous 429/5xx response:
    // a delayed retry could outlive that window and create a duplicate order.
    const retryableRequest = !record.isTradingMutation;
    const response = await this.sendOperationRequest(
      record,
      args,
      url,
      init,
      retryableRequest,
    );
    if (!shouldRefreshAccessToken(response)) {
      return response;
    }

    const refreshedToken = await this.getAccessToken({
      forceRefresh: true,
      usedToken: accessToken,
    });
    headers.Authorization = `Bearer ${refreshedToken}`;
    const retryResponse = await this.sendOperationRequest(
      record,
      args,
      url,
      init,
      retryableRequest,
    );
    return classifyMutationOutcome(record, args, {
      ...retryResponse,
      attempts: response.attempts + retryResponse.attempts,
    });
  }

  private async assertMutationPolicy(
    record: OperationRecord,
    args: CallArgs,
  ) {
    const operationId = record.operation.operationId;
    if (operationId === "createOrder") {
      const order = parseOrderDraft(args.body);
      const quote = await this.fetchReferenceQuote(order.symbol);
      assertLiveTradingPolicy(this.config, args.body, {
        referencePrice: quote.price,
        referenceCurrency: quote.currency,
      });
      return;
    }
    if (operationId === "createConditionalOrder") {
      const symbol = bodySymbol(args.body, "Conditional order");
      const quote = await this.fetchReferenceQuote(symbol);
      assertConditionalOrderPolicy(this.config, args.body, {
        requireClientOrderId: true,
        referenceCurrency: quote.currency,
        currentPrice: quote.price,
      });
      return;
    }
    if (operationId === "modifyOrder") {
      const currentOrder = await this.fetchResourceResult("getOrder", args);
      const symbol = resultSymbol(currentOrder, "Order modification");
      const quote = await this.fetchReferenceQuote(symbol);
      assertOrderModificationPolicy(this.config, currentOrder, args.body, {
        referencePrice: quote.price,
        referenceCurrency: quote.currency,
      });
      return;
    }
    if (operationId === "modifyConditionalOrder") {
      const currentOrder = await this.fetchResourceResult(
        "getConditionalOrder",
        args,
      );
      const symbol = resultSymbol(currentOrder, "Conditional order modification");
      const quote = await this.fetchReferenceQuote(symbol);
      assertConditionalOrderPolicy(this.config, args.body, {
        symbol,
        requireClientOrderId: false,
        referenceCurrency: quote.currency,
        currentPrice: quote.price,
      });
      return;
    }
    if (["cancelOrder", "cancelConditionalOrder"].includes(operationId)) {
      return;
    }
    throw new Error(
      `Live mutation ${operationId} has no local trading-policy handler and is blocked by default.`,
    );
  }

  private async fetchResourceResult(operationId: string, args: CallArgs) {
    const operation = getOperation(operationId);
    if (!operation) {
      throw new Error(`Required policy lookup operation is unavailable: ${operationId}`);
    }
    const response = await this.callOperation(operation, args);
    if (!response.ok) {
      throw new Error(
        `Trading policy lookup ${operationId} failed with HTTP ${response.status}: ${response.error?.message ?? "unknown error"}`,
      );
    }
    if (!isObject(response.body) || !("result" in response.body)) {
      throw new Error(`Trading policy lookup ${operationId} returned no result.`);
    }
    return response.body.result;
  }

  private async sendOperationRequest(
    record: OperationRecord,
    args: CallArgs,
    url: URL,
    init: RequestInit,
    retryableRequest: boolean,
  ) {
    try {
      const response = await this.fetchWithRetry(url, init, { retryableRequest });
      return classifyMutationOutcome(record, args, response);
    } catch (error) {
      if (!record.isTradingMutation) {
        throw error;
      }
      return mutationTransportOutcome(error);
    }
  }

  private async fetchReferenceQuote(symbol: string) {
    const result = await this.fetchResourceResult("getPrices", { symbols: symbol });
    if (!Array.isArray(result)) {
      throw new Error("Trading policy price lookup returned a malformed result.");
    }
    const matches = result.filter(
      (item) =>
        isObject(item) &&
        stringOrUndefined(item.symbol)?.toUpperCase() === symbol.toUpperCase(),
    );
    if (matches.length !== 1) {
      throw new Error(
        `Trading policy price lookup must return exactly one row for ${symbol}.`,
      );
    }
    const row = matches[0];
    const price = stringOrUndefined(row.lastPrice);
    const currency = stringOrUndefined(row.currency);
    if (!price || !/^\d+(\.\d+)?$/.test(price) || Number(price) <= 0) {
      throw new Error(`Trading policy price lookup returned no valid price for ${symbol}.`);
    }
    if (currency !== "KRW" && currency !== "USD") {
      throw new Error(
        `Trading policy price lookup returned an unsupported currency for ${symbol}.`,
      );
    }
    return { price, currency: currency as "KRW" | "USD" };
  }

  private async getAccessToken(
    options: { forceRefresh?: boolean; usedToken?: string } = {},
  ) {
    const cachedToken = this.usableCachedToken(options);
    if (cachedToken) {
      return cachedToken.accessToken;
    }

    if (
      options.forceRefresh &&
      options.usedToken &&
      this.token?.accessToken === options.usedToken
    ) {
      this.token = undefined;
    }

    if (this.tokenRefresh) {
      return this.tokenRefresh;
    }

    this.tokenRefresh = this.refreshAccessToken();
    try {
      return await this.tokenRefresh;
    } finally {
      this.tokenRefresh = undefined;
    }
  }

  private async refreshAccessToken() {
    if (!this.config.clientId || !this.config.clientSecret) {
      throw new Error(
        "Missing TOSSINVEST_CLIENT_ID or TOSSINVEST_CLIENT_SECRET in the MCP server environment. Configure them locally and restart the server; never send credentials through MCP tool arguments.",
      );
    }

    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
    });

    const response = await this.fetchWithRetry(
      new URL("/oauth2/token", this.config.baseUrl),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body,
      },
      { authRequest: true },
    );

    if (!response.ok) {
      throw new Error(
        `Toss Invest OAuth token request failed with HTTP ${response.status}: ${safeJson(response.body, this.config)}`,
      );
    }

    if (!isObject(response.body) || typeof response.body.access_token !== "string") {
      throw new Error("Toss Invest OAuth token response did not contain access_token.");
    }

    const expiresIn =
      typeof response.body.expires_in === "number" ? response.body.expires_in : 3600;
    this.token = {
      accessToken: response.body.access_token,
      expiresAt: Date.now() + Math.max(60, expiresIn - 60) * 1000,
    };

    return this.token.accessToken;
  }

  private usableCachedToken(options: {
    forceRefresh?: boolean;
    usedToken?: string;
  }) {
    const token = this.token;
    if (!token || token.expiresAt - 30_000 <= Date.now()) {
      return undefined;
    }
    const canUseToken =
      !options.forceRefresh ||
      Boolean(options.usedToken && token.accessToken !== options.usedToken);
    return canUseToken ? token : undefined;
  }

  private async fetchWithRetry(
    url: URL,
    init: RequestInit,
    options: { authRequest?: boolean; retryableRequest?: boolean } = {},
  ): Promise<TossResponse> {
    const configuredRetries = options.authRequest
      ? Math.min(this.config.retry.maxRetries, 1)
      : this.config.retry.maxRetries;
    const maxRetries = options.retryableRequest === false ? 0 : configuredRetries;
    let attempt = 0;
    let response: TossResponse | undefined;

    while (attempt <= maxRetries) {
      attempt += 1;
      response = await this.parseFetchResponse(await fetch(url, init), attempt);
      if (!shouldRetry(response) || attempt > maxRetries) {
        return response;
      }
      await sleep(retryDelayMs(response, attempt, this.config));
    }

    throw new Error("Toss Invest request retry loop exited unexpectedly.");
  }

  private async parseFetchResponse(
    response: Response,
    attempts: number,
  ): Promise<TossResponse> {
    const contentType = response.headers.get("content-type") ?? "";
    const text = await response.text();
    const body = contentType.includes("application/json")
      ? parseJson(text)
      : text || null;
    const headers = pickResponseHeaders(response.headers);

    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      headers,
      body,
      error: response.ok ? undefined : normalizeApiError(response.status, headers, body),
      attempts,
    };
  }
}

export function buildOperationUrl(
  baseUrl: string,
  record: OperationRecord,
  args: CallArgs,
) {
  let path = record.path;
  const query = new URLSearchParams();

  for (const parameter of record.operation.parameters ?? []) {
    const resolved = resolveParameter(parameter);
    if (resolved.in === "path") {
      const value = args[resolved.name];
      if (value === undefined || value === null || value === "") {
        throw new Error(`Missing required path parameter: ${resolved.name}`);
      }
      path = path.replace(
        `{${resolved.name}}`,
        encodeURIComponent(String(value)),
      );
      continue;
    }

    if (resolved.in === "query") {
      const value = args[resolved.name];
      if (value === undefined || value === null || value === "") {
        if (resolved.required) {
          throw new Error(`Missing required query parameter: ${resolved.name}`);
        }
        continue;
      }
      query.set(resolved.name, String(value));
    }
  }

  const url = new URL(path, baseUrl);
  for (const [key, value] of query.entries()) {
    url.searchParams.set(key, value);
  }
  return url;
}

function assertTradingAllowed(config: TossConfig, args: CallArgs) {
  if (config.tradingMode !== "LIVE_TRADING") {
    throw new Error(
      "Live order creation/modification/cancellation is disabled. Set TOSSINVEST_TRADING_MODE=LIVE_TRADING on the MCP server only if you intentionally want trading tools to execute real orders.",
    );
  }

  if (args.confirmTrading !== true) {
    throw new Error(
      "Trading tools require confirmTrading=true for every live order operation.",
    );
  }
}

function pickResponseHeaders(headers: Headers) {
  const allowed = [
    "x-request-id",
    "cf-ray",
    "x-ratelimit-limit",
    "x-ratelimit-remaining",
    "x-ratelimit-reset",
    "retry-after",
    "www-authenticate",
  ];
  const result: Record<string, string> = {};
  for (const key of allowed) {
    const value = headers.get(key);
    if (value) {
      result[key] = value;
    }
  }
  return result;
}

function parseJson(value: string) {
  if (!value) {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function normalizeApiError(
  status: number,
  headers: Record<string, string>,
  body: unknown,
): NormalizedApiError {
  if (isObject(body) && isObject(body.error)) {
    return {
      requestId:
        stringOrUndefined(body.error.requestId) ?? headers["x-request-id"],
      code: stringOrUndefined(body.error.code) ?? `http-${status}`,
      message:
        stringOrUndefined(body.error.message) ??
        `Toss Invest API returned HTTP ${status}.`,
      data: body.error.data,
      status,
      retryAfter: headers["retry-after"],
    };
  }

  return {
    requestId: headers["x-request-id"],
    code: `http-${status}`,
    message: `Toss Invest API returned HTTP ${status}.`,
    data: body,
    status,
    retryAfter: headers["retry-after"],
  };
}

function shouldRetry(response: TossResponse) {
  return response.status === 429 || response.status >= 500;
}

function shouldRefreshAccessToken(response: TossResponse) {
  if (response.status !== 401) {
    return false;
  }
  return ["invalid-token", "expired-token"].includes(response.error?.code ?? "");
}

function classifyMutationOutcome(
  record: OperationRecord,
  args: CallArgs,
  response: TossResponse,
): TossResponse {
  if (!record.isTradingMutation) {
    return response;
  }

  const malformedSuccess = response.ok
    ? mutationSuccessError(record.operation.operationId, args, response)
    : undefined;
  const outcomeUnknown = Boolean(
    response.outcomeUnknown === true ||
      malformedSuccess ||
      response.status === 429 ||
      response.status >= 500 ||
      response.error?.code === "request-in-progress",
  );
  if (malformedSuccess) {
    return {
      ...response,
      ok: false,
      error: {
        code: "mutation-outcome-unknown",
        message: malformedSuccess,
        status: response.status,
      },
      outcomeUnknown: true,
      submissionPhase: "response_received",
    };
  }
  return {
    ...response,
    outcomeUnknown,
    submissionPhase: response.submissionPhase ?? "response_received",
  };
}

function mutationSuccessError(
  operationId: string,
  args: CallArgs,
  response: TossResponse,
) {
  if (operationId === "cancelConditionalOrder") {
    return response.status === 204 && response.body === null
      ? undefined
      : "Toss Invest returned an unexpected success response for cancelConditionalOrder; the mutation outcome is unknown and must be reconciled before retrying.";
  }

  const result = isObject(response.body) && isObject(response.body.result)
    ? response.body.result
    : undefined;
  const idField = operationId.includes("Conditional")
    ? "conditionalOrderId"
    : "orderId";
  if (!result || !stringOrUndefined(result[idField])) {
    return `Toss Invest returned HTTP success for ${operationId} without a valid ${idField}; the mutation outcome is unknown and must be reconciled before retrying.`;
  }
  if (["createOrder", "createConditionalOrder"].includes(operationId)) {
    const requestedClientOrderId = isObject(args.body)
      ? stringOrUndefined(args.body.clientOrderId)
      : undefined;
    const returnedClientOrderId = stringOrUndefined(result.clientOrderId);
    if (
      requestedClientOrderId &&
      returnedClientOrderId !== requestedClientOrderId
    ) {
      return `Toss Invest returned HTTP success for ${operationId} with a missing or mismatched clientOrderId; the mutation outcome is unknown and must be reconciled before retrying.`;
    }
  }
  return undefined;
}

function mutationTransportOutcome(error: unknown): TossResponse {
  return {
    ok: false,
    status: 0,
    statusText: "Transport Error",
    headers: {},
    body: null,
    error: {
      code: "mutation-outcome-unknown",
      message:
        "The trading mutation transport failed after submission began. The execution outcome is unknown; reconcile account orders before retrying.",
      data: {
        cause: error instanceof Error ? error.name : "UnknownError",
      },
      status: 0,
    },
    attempts: 1,
    outcomeUnknown: true,
    submissionPhase: "submission_started",
  };
}

function retryDelayMs(response: TossResponse, attempt: number, config: TossConfig) {
  const retryAfter = Number(response.headers["retry-after"]);
  if (Number.isFinite(retryAfter) && retryAfter >= 0) {
    return Math.min(retryAfter * 1000, config.retry.maxDelayMs);
  }

  const jitter = Math.floor(Math.random() * 100);
  return Math.min(
    config.retry.baseDelayMs * 2 ** Math.max(0, attempt - 1) + jitter,
    config.retry.maxDelayMs,
  );
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stringOrUndefined(value: unknown) {
  return typeof value === "string" && value ? value : undefined;
}

function bodySymbol(body: unknown, label: string) {
  if (!isObject(body)) {
    throw new Error(`${label} body must be an object.`);
  }
  const symbol = stringOrUndefined(body.symbol)?.toUpperCase();
  if (!symbol) {
    throw new Error(`${label} body requires symbol.`);
  }
  return symbol;
}

function resultSymbol(value: unknown, label: string) {
  const symbol = isObject(value)
    ? stringOrUndefined(value.symbol)?.toUpperCase()
    : undefined;
  if (!symbol) {
    throw new Error(`${label} policy could not resolve the current symbol.`);
  }
  return symbol;
}

function safeJson(value: unknown, config: TossConfig) {
  return redact(JSON.stringify(value), config);
}

export function redact(value: string, config: TossConfig) {
  let redacted = value;
  for (const secret of [
    config.clientId,
    config.clientSecret,
    config.defaultAccount,
  ]) {
    if (secret) {
      redacted = redacted.split(secret).join("[REDACTED]");
    }
  }
  return redacted.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [REDACTED]");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
