import { mkdir, appendFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import type { CallArgs, TossConfig } from "./types.js";

export type AuditEvent = {
  type:
    | "tool_call"
    | "tool_result"
    | "tool_error"
    | "order_preflight"
    | "order_dry_run";
  tool: string;
  operationId?: string;
  status?: number;
  ok?: boolean;
  requestId?: string;
  cfRay?: string;
  details?: Record<string, unknown>;
};

export class AuditLogger {
  private readonly logPath: string;

  constructor(private readonly config: TossConfig) {
    this.logPath = resolve(config.audit.logPath);
  }

  async write(event: AuditEvent) {
    if (!this.config.audit.enabled) {
      return;
    }

    const line = JSON.stringify({
      ts: new Date().toISOString(),
      ...event,
    });

    await mkdir(dirname(this.logPath), { recursive: true });
    await appendFile(this.logPath, `${line}\n`, "utf8");
  }

  sanitizeArgs(args: CallArgs) {
    const body = isRecord(args.body) ? args.body : undefined;
    return {
      accountHash: hashValue(args.accountSeq ?? this.config.defaultAccount),
      symbol: stringField(args.symbol) ?? stringField(body?.symbol),
      symbols: stringField(args.symbols),
      side: stringField(body?.side),
      orderType: stringField(body?.orderType),
      quantity: stringField(body?.quantity),
      orderAmount: stringField(body?.orderAmount),
      price: stringField(body?.price),
      clientOrderId: stringField(body?.clientOrderId),
      confirmTrading: args.confirmTrading === true,
    };
  }
}

export function auditResponseDetails(headers: Record<string, string>) {
  return {
    requestId: headers["x-request-id"],
    cfRay: headers["cf-ray"],
  };
}

function hashValue(value: unknown) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 12);
}

function stringField(value: unknown) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  return String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
