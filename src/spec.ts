import { readFileSync } from "node:fs";
import { z } from "zod/v3";
import type {
  CallArgs,
  HttpMethod,
  JsonSchema,
  OpenApiDocument,
  OpenApiOperation,
  OpenApiParameter,
  OpenApiRequestBody,
  OperationRecord,
} from "./types.js";

const specUrl = new URL("../spec/openapi.json", import.meta.url);

export const openapi = JSON.parse(
  readFileSync(specUrl, "utf8"),
) as OpenApiDocument;

const HTTP_METHODS = new Set<HttpMethod>([
  "get",
  "post",
  "put",
  "patch",
  "delete",
]);

export const operations = buildOperationIndex(openapi);

export function getOperation(operationId: string): OperationRecord | undefined {
  return operations.find((record) => record.operation.operationId === operationId);
}

export function resolveRef<T>(ref: string): T {
  if (!ref.startsWith("#/")) {
    throw new Error(`Only local OpenAPI refs are supported: ${ref}`);
  }

  const parts = ref.slice(2).split("/");
  let current: unknown = openapi;
  for (const part of parts) {
    const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!isObject(current) || !(key in current)) {
      throw new Error(`OpenAPI ref not found: ${ref}`);
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current as T;
}

export function resolveParameter(
  parameter: OpenApiParameter,
): OpenApiParameter {
  if (parameter.$ref) {
    return resolveRef<OpenApiParameter>(parameter.$ref);
  }
  return parameter;
}

export function resolveRequestBody(
  requestBody: OpenApiOperation["requestBody"],
): OpenApiRequestBody | undefined {
  if (!requestBody) {
    return undefined;
  }
  if ("$ref" in requestBody) {
    return resolveRef<OpenApiRequestBody>(requestBody.$ref);
  }
  return requestBody;
}

export function buildToolInputSchema(record: OperationRecord) {
  const shape: z.ZodRawShape = {};

  for (const parameter of record.operation.parameters ?? []) {
    const resolved = resolveParameter(parameter);
    if (resolved.in === "cookie") {
      continue;
    }

    if (resolved.in === "header" && resolved.name === "X-Tossinvest-Account") {
      shape.accountSeq = z
        .union([z.string(), z.number().int()])
        .optional()
        .describe(
          "Toss accountSeq. If omitted, TOSSINVEST_ACCOUNT from the MCP server environment is used.",
        );
      continue;
    }

    const schema = zodFromJsonSchema(resolved.schema, resolved.description);
    shape[resolved.name] = resolved.required ? schema : schema.optional();
  }

  const requestBody = resolveRequestBody(record.operation.requestBody);
  if (requestBody) {
    const bodySchema = z
      .record(z.unknown())
      .describe(requestBody.description ?? requestBodyDescription(requestBody));
    shape.body = requestBody.required ? bodySchema : bodySchema.optional();
  }

  if (record.isTradingMutation) {
    shape.confirmTrading = z
      .literal(true)
      .describe(
        "Must be true for live order creation, modification, or cancellation. The server also requires TOSSINVEST_ENABLE_TRADING=true.",
      );
  }

  return shape;
}

export function listOperationSummaries() {
  return operations.map((record) => ({
    operationId: record.operation.operationId,
    toolName: toolNameForOperation(record.operation.operationId),
    method: record.method.toUpperCase(),
    path: record.path,
    summary: record.summary,
    tags: record.tags,
    rateLimitGroup: record.rateLimitGroup,
    requiresAccount: record.requiresAccount,
    callable: record.operation.operationId !== "issueOAuth2Token",
    tradingMutation: record.isTradingMutation,
  }));
}

export function operationDetails(record: OperationRecord) {
  const parameters = (record.operation.parameters ?? []).map((parameter) => {
    const resolved = resolveParameter(parameter);
    return {
      name:
        resolved.in === "header" && resolved.name === "X-Tossinvest-Account"
          ? "accountSeq"
          : resolved.name,
      wireName: resolved.name,
      in: resolved.in,
      required: Boolean(resolved.required),
      description: resolved.description,
      schema: resolved.schema,
      example: resolved.example,
      examples: resolved.examples,
    };
  });

  const requestBody = resolveRequestBody(record.operation.requestBody);
  const responseExamples = collectResponseExamples(record.operation);

  return {
    operationId: record.operation.operationId,
    toolName: toolNameForOperation(record.operation.operationId),
    method: record.method.toUpperCase(),
    path: record.path,
    summary: record.summary,
    description: record.description,
    tags: record.tags,
    rateLimitGroup: record.rateLimitGroup,
    requiresAccount: record.requiresAccount,
    tradingMutation: record.isTradingMutation,
    parameters,
    requestBody,
    responseExamples,
  };
}

export function toolNameForOperation(operationId: string) {
  return `toss_invest_${camelToSnake(operationId)}`;
}

export function accountSeqFromArgs(args: CallArgs): string | undefined {
  if (args.accountSeq === undefined || args.accountSeq === null) {
    return undefined;
  }
  return String(args.accountSeq);
}

function buildOperationIndex(doc: OpenApiDocument): OperationRecord[] {
  const records: OperationRecord[] = [];

  for (const [path, methods] of Object.entries(doc.paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      if (!HTTP_METHODS.has(method as HttpMethod) || !operation?.operationId) {
        continue;
      }

      const parameters = operation.parameters ?? [];
      const resolvedParameters = parameters.map(resolveParameter);
      const description = operation.description ?? "";
      const operationId = operation.operationId;
      const tags = operation.tags ?? [];

      records.push({
        method: method as HttpMethod,
        path,
        operation,
        tags,
        summary: operation.summary ?? operationId,
        description,
        rateLimitGroup: extractRateLimitGroup(description),
        requiresAccount: resolvedParameters.some(
          (parameter) =>
            parameter.in === "header" &&
            parameter.name === "X-Tossinvest-Account",
        ),
        isTradingMutation: [
          "createOrder",
          "modifyOrder",
          "cancelOrder",
        ].includes(operationId),
      });
    }
  }

  return records;
}

function zodFromJsonSchema(schema: JsonSchema | undefined, description?: string) {
  const resolved = schema?.$ref ? resolveRef<JsonSchema>(schema.$ref) : schema;
  let result: z.ZodTypeAny;

  if (resolved?.enum?.length && resolved.enum.every((item) => typeof item === "string")) {
    const values = resolved.enum as string[];
    result = values.length > 0 ? z.enum(values as [string, ...string[]]) : z.string();
  } else {
    const type = Array.isArray(resolved?.type) ? resolved?.type[0] : resolved?.type;
    switch (type) {
      case "integer":
        result = z.number().int();
        if (resolved?.minimum !== undefined) {
          result = (result as z.ZodNumber).min(resolved.minimum);
        }
        if (resolved?.maximum !== undefined) {
          result = (result as z.ZodNumber).max(resolved.maximum);
        }
        break;
      case "number":
        result = z.number();
        if (resolved?.minimum !== undefined) {
          result = (result as z.ZodNumber).min(resolved.minimum);
        }
        if (resolved?.maximum !== undefined) {
          result = (result as z.ZodNumber).max(resolved.maximum);
        }
        break;
      case "boolean":
        result = z.boolean();
        break;
      case "array":
        result = z.array(z.unknown());
        break;
      case "object":
        result = z.record(z.unknown());
        break;
      case "string":
      default:
        result = z.string();
        if (resolved?.minLength !== undefined) {
          result = (result as z.ZodString).min(resolved.minLength);
        }
        if (resolved?.maxLength !== undefined) {
          result = (result as z.ZodString).max(resolved.maxLength);
        }
        if (resolved?.pattern) {
          result = (result as z.ZodString).regex(new RegExp(resolved.pattern));
        }
        break;
    }
  }

  if (description || resolved?.description) {
    result = result.describe(description ?? resolved?.description ?? "");
  }

  return result;
}

function requestBodyDescription(requestBody: OpenApiRequestBody) {
  const jsonBody = requestBody.content?.["application/json"];
  const schema = jsonBody?.schema?.$ref
    ? jsonBody.schema.$ref.replace("#/components/schemas/", "")
    : jsonBody?.schema?.type;

  return schema
    ? `JSON request body matching ${schema}. Use toss_invest_get_operation for examples and the exact schema.`
    : "JSON request body.";
}

function collectResponseExamples(operation: OpenApiOperation) {
  const examples: Record<string, unknown> = {};
  for (const [status, response] of Object.entries(operation.responses ?? {})) {
    if (!isObject(response)) {
      continue;
    }
    const content = response.content;
    if (!isObject(content)) {
      continue;
    }
    const json = content["application/json"];
    if (!isObject(json)) {
      continue;
    }
    if ("example" in json) {
      examples[status] = json.example;
    }
    if (isObject(json.examples)) {
      examples[status] = json.examples;
    }
  }
  return examples;
}

function extractRateLimitGroup(description: string): string | undefined {
  return description.match(/Rate Limits Group\*\*: `([^`]+)`/)?.[1];
}

function camelToSnake(value: string) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
