export type HttpMethod = "get" | "post" | "put" | "patch" | "delete";

export type JsonSchema = {
  type?: string | string[];
  format?: string;
  enum?: unknown[];
  pattern?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  default?: unknown;
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  allOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  $ref?: string;
  description?: string;
};

export type OpenApiParameter = {
  name: string;
  in: "query" | "path" | "header" | "cookie";
  required?: boolean;
  description?: string;
  schema?: JsonSchema;
  example?: unknown;
  examples?: Record<string, { summary?: string; value?: unknown }>;
  $ref?: string;
};

export type OpenApiRequestBody = {
  required?: boolean;
  description?: string;
  content?: Record<
    string,
    {
      schema?: JsonSchema;
      example?: unknown;
      examples?: Record<string, { summary?: string; value?: unknown }>;
    }
  >;
};

export type OpenApiOperation = {
  tags?: string[];
  summary?: string;
  description?: string;
  operationId: string;
  security?: Array<Record<string, string[]>>;
  parameters?: OpenApiParameter[];
  requestBody?: OpenApiRequestBody | { $ref: string };
  responses?: Record<string, unknown>;
};

export type OpenApiDocument = {
  openapi: string;
  info: {
    title: string;
    version: string;
  };
  servers?: Array<{ url: string }>;
  paths: Record<string, Partial<Record<HttpMethod, OpenApiOperation>>>;
  components?: {
    schemas?: Record<string, JsonSchema>;
    parameters?: Record<string, OpenApiParameter>;
    requestBodies?: Record<string, OpenApiRequestBody>;
    responses?: Record<string, unknown>;
  };
  tags?: Array<{ name: string; description?: string }>;
};

export type OperationRecord = {
  method: HttpMethod;
  path: string;
  operation: OpenApiOperation;
  tags: string[];
  summary: string;
  description: string;
  rateLimitGroup?: string;
  requiresAccount: boolean;
  isTradingMutation: boolean;
};

export type CallArgs = {
  accountSeq?: string | number;
  body?: Record<string, unknown>;
  confirmTrading?: true;
  [key: string]: unknown;
};

export type TradingMode = "READ_ONLY" | "DRY_RUN" | "LIVE_TRADING";

export type RetryConfig = {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
};

export type TradingPolicyConfig = {
  mode: TradingMode;
  allowedSymbols?: string[];
  blockedSymbols: string[];
  maxOrderAmountKrw?: number;
  maxOrderAmountUsd?: number;
  requireClientOrderId: boolean;
  allowMarketOrderWithoutPrice: boolean;
};

export type TossConfig = {
  baseUrl: string;
  clientId?: string;
  clientSecret?: string;
  defaultAccount?: string;
  enableTrading: boolean;
  tradingMode: TradingMode;
  retry: RetryConfig;
  tradingPolicy: TradingPolicyConfig;
  audit: {
    enabled: boolean;
    logPath: string;
  };
};
