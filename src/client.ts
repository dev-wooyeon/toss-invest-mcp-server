import { accountSeqFromArgs, resolveParameter, resolveRequestBody } from "./spec.js";
import { assertLiveTradingPolicy } from "./policy.js";
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
      if (record.operation.operationId === "createOrder") {
        assertLiveTradingPolicy(this.config, args.body);
      }
    }

    const url = buildUrl(this.config.baseUrl, record, args);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${await this.getAccessToken()}`,
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

    return this.fetchWithRetry(url, init);
  }

  private async getAccessToken() {
    if (this.token && this.token.expiresAt - 30_000 > Date.now()) {
      return this.token.accessToken;
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

  private async fetchWithRetry(
    url: URL,
    init: RequestInit,
    options: { authRequest?: boolean } = {},
  ): Promise<TossResponse> {
    const maxRetries = options.authRequest
      ? Math.min(this.config.retry.maxRetries, 1)
      : this.config.retry.maxRetries;
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

function buildUrl(baseUrl: string, record: OperationRecord, args: CallArgs) {
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
