import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v3";
import { AuditLogger, auditResponseDetails } from "./audit.js";
import { TossInvestClient, redact, type TossResponse } from "./client.js";
import { getAuthStatus, getConfig } from "./config.js";
import {
  buildToolInputSchema,
  listOperationSummaries,
  openapi,
  operationDetails,
  operations,
  toolNameForOperation,
} from "./spec.js";
import type { CallArgs, OperationRecord } from "./types.js";
import {
  accountRiskSummary,
  marketStatus,
  orderDryRun,
  orderPreflight,
  portfolioSnapshot,
  stockSnapshot,
} from "./workflows.js";

export function createServer() {
  const config = getConfig();
  const client = new TossInvestClient(config);
  const audit = new AuditLogger(config);
  const server = new McpServer({
    name: "toss-invest-mcp-server",
    version: "1.0.0",
  });

  server.registerTool(
    "toss_invest_auth_status",
    {
      title: "Toss Invest Auth Status",
      description:
        "Show whether this MCP server has Toss Invest environment credentials configured. Never returns ClientId, Secret, access tokens, or the default accountSeq value.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => jsonResult(getAuthStatus(config, client.tokenExpiresAt)),
  );

  server.registerTool(
    "toss_invest_list_operations",
    {
      title: "List Toss Invest Operations",
      description:
        "List operations from the official bundled Toss Invest OpenAPI spec, including tool names, account requirement, trading mutation flag, and rate limit group.",
      inputSchema: {
        tag: z
          .string()
          .optional()
          .describe("Optional OpenAPI tag filter, e.g. Market Data, Order."),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ tag }) => {
      const all = listOperationSummaries();
      return jsonResult(tag ? all.filter((op) => op.tags.includes(tag)) : all);
    },
  );

  server.registerTool(
    "toss_invest_get_operation",
    {
      title: "Get Toss Invest Operation Details",
      description:
        "Return parameters, request body schema, examples, and response examples for one official Toss Invest OpenAPI operation.",
      inputSchema: {
        operationId: z
          .string()
          .describe("OpenAPI operationId, e.g. getPrices or createOrder."),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ operationId }) => {
      const record = operations.find((item) => item.operation.operationId === operationId);
      if (!record) {
        return toolError(`Unknown Toss Invest operationId: ${operationId}`);
      }
      return jsonResult(operationDetails(record));
    },
  );

  registerWorkflowTools(server, client, config, audit);

  server.registerResource(
    "toss-invest-openapi",
    "tossinvest://openapi.json",
    {
      title: "Toss Invest OpenAPI",
      description:
        "Bundled official OpenAPI document from https://openapi.tossinvest.com/openapi-docs/latest/openapi.json",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(openapi, null, 2),
        },
      ],
    }),
  );

  for (const record of operations) {
    if (record.operation.operationId === "issueOAuth2Token") {
      continue;
    }
    registerOperationTool(server, client, config, audit, record);
  }

  return server;
}

function registerOperationTool(
  server: McpServer,
  client: TossInvestClient,
  config: ReturnType<typeof getConfig>,
  audit: AuditLogger,
  record: OperationRecord,
) {
  const toolName = toolNameForOperation(record.operation.operationId);
  const accountNote = record.requiresAccount
    ? " Requires accountSeq input or TOSSINVEST_ACCOUNT in the server environment."
    : "";
  const tradingNote = record.isTradingMutation
    ? " Live trading mutation: requires TOSSINVEST_ENABLE_TRADING=true and confirmTrading=true."
    : "";

  server.registerTool(
    toolName,
    {
      title: record.summary,
      description: [
        `${record.method.toUpperCase()} ${record.path} - ${record.summary}.`,
        record.description,
        accountNote,
        tradingNote,
        "Do not pass ClientId, Secret, or access tokens as tool arguments.",
      ]
        .filter(Boolean)
        .join("\n\n"),
      inputSchema: buildToolInputSchema(record),
      annotations: {
        readOnlyHint: !record.isTradingMutation,
        destructiveHint: record.isTradingMutation,
        idempotentHint: !record.isTradingMutation,
        openWorldHint: true,
      },
    },
    async (args) => {
      await audit.write({
        type: "tool_call",
        tool: toolName,
        operationId: record.operation.operationId,
        details: audit.sanitizeArgs(args as CallArgs),
      });

      try {
        const response = await client.callOperation(record, args as CallArgs);
        const responseAudit = auditResponseDetails(response.headers);
        await audit.write({
          type: "tool_result",
          tool: toolName,
          operationId: record.operation.operationId,
          status: response.status,
          ok: response.ok,
          requestId: responseAudit.requestId,
          cfRay: responseAudit.cfRay,
          details: {
            attempts: response.attempts,
            errorCode: response.error?.code,
          },
        });
        return response.ok
          ? apiResult(response)
          : apiResult(response, true);
      } catch (error) {
        const message = redact(errorMessage(error), config);
        await audit.write({
          type: "tool_error",
          tool: toolName,
          operationId: record.operation.operationId,
          ok: false,
          details: { message },
        });
        return toolError(message);
      }
    },
  );
}

function registerWorkflowTools(
  server: McpServer,
  client: TossInvestClient,
  config: ReturnType<typeof getConfig>,
  audit: AuditLogger,
) {
  const context = { client, config };

  server.registerTool(
    "toss_invest_stock_snapshot",
    {
      title: "Stock Snapshot",
      description:
        "Fetch stock info, current prices, price limits, and optional warnings for up to 20 symbols.",
      inputSchema: {
        symbols: z
          .string()
          .regex(/^[A-Za-z0-9.,\-]+$/)
          .describe("Comma-separated symbols, e.g. 005930,AAPL."),
        includeWarnings: z.boolean().optional().default(true),
        includePriceLimits: z.boolean().optional().default(true),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) =>
      auditedWorkflow(audit, "toss_invest_stock_snapshot", args, () =>
        stockSnapshot(context, args),
      ),
  );

  server.registerTool(
    "toss_invest_market_status",
    {
      title: "Market Status",
      description:
        "Fetch KR and/or US market calendar status for a date. Defaults to both markets and the API default date.",
      inputSchema: {
        market: z.enum(["KR", "US", "BOTH"]).optional().default("BOTH"),
        date: z.string().optional().describe("YYYY-MM-DD."),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) =>
      auditedWorkflow(audit, "toss_invest_market_status", args, () =>
        marketStatus(context, args),
      ),
  );

  server.registerTool(
    "toss_invest_portfolio_snapshot",
    {
      title: "Portfolio Snapshot",
      description:
        "Fetch accounts, holdings, commissions, and optional open orders in one read-only workflow.",
      inputSchema: {
        accountSeq: z.union([z.string(), z.number().int()]).optional(),
        symbol: z.string().regex(/^[A-Za-z0-9.\-]+$/).optional(),
        includeOpenOrders: z.boolean().optional().default(true),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) =>
      auditedWorkflow(audit, "toss_invest_portfolio_snapshot", args, () =>
        portfolioSnapshot(context, args),
      ),
  );

  server.registerTool(
    "toss_invest_account_risk_summary",
    {
      title: "Account Risk Summary",
      description:
        "Build a best-effort account risk summary from holdings, buying power, and open orders. This is not investment advice.",
      inputSchema: {
        accountSeq: z.union([z.string(), z.number().int()]).optional(),
        includeOpenOrders: z.boolean().optional().default(true),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) =>
      auditedWorkflow(audit, "toss_invest_account_risk_summary", args, () =>
        accountRiskSummary(context, args),
      ),
  );

  server.registerTool(
    "toss_invest_order_preflight",
    {
      title: "Order Preflight",
      description:
        "Validate an order draft against local policy and fetch supporting market/account context. Never executes an order.",
      inputSchema: {
        accountSeq: z.union([z.string(), z.number().int()]).optional(),
        body: z.record(z.unknown()).describe("OrderCreateRequest draft."),
        includeOpenOrders: z.boolean().optional().default(true),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) =>
      auditedWorkflow(
        audit,
        "toss_invest_order_preflight",
        args,
        () => orderPreflight(context, args),
        "order_preflight",
      ),
  );

  server.registerTool(
    "toss_invest_create_order_dry_run",
    {
      title: "Create Order Dry Run",
      description:
        "Build and validate the order creation request without calling POST /api/v1/orders. Never executes an order.",
      inputSchema: {
        accountSeq: z.union([z.string(), z.number().int()]).optional(),
        body: z.record(z.unknown()).describe("OrderCreateRequest draft."),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) =>
      auditedWorkflow(
        audit,
        "toss_invest_create_order_dry_run",
        args,
        () => orderDryRun(context, args),
        "order_dry_run",
      ),
  );
}

async function auditedWorkflow(
  audit: AuditLogger,
  tool: string,
  args: CallArgs,
  run: () => Promise<unknown>,
  successType: "tool_result" | "order_preflight" | "order_dry_run" = "tool_result",
) {
  await audit.write({
    type: "tool_call",
    tool,
    details: audit.sanitizeArgs(args),
  });
  try {
    const result = await run();
    await audit.write({
      type: successType,
      tool,
      ok: true,
      details: audit.sanitizeArgs(args),
    });
    return jsonResult(result);
  } catch (error) {
    const message = errorMessage(error);
    await audit.write({
      type: "tool_error",
      tool,
      ok: false,
      details: { message },
    });
    return toolError(message);
  }
}

function apiResult(response: TossResponse, isError = false) {
  const payload = {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
    body: response.body,
    error: response.error,
    attempts: response.attempts,
  };

  return {
    isError,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(payload, null, 2),
      },
    ],
    structuredContent: payload,
  };
}

function jsonResult(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2),
      },
    ],
    structuredContent: isRecord(value) ? value : { value },
  };
}

function toolError(message: string) {
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: message,
      },
    ],
  };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
