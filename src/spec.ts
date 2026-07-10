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

const INTERNAL_OPERATION_IDS = new Set(["issueOAuth2Token"]);

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
    const jsonSchema = requestBody.content?.["application/json"]?.schema;
    const bodySchema = jsonSchema
      ? zodFromJsonSchema(
          jsonSchema,
          requestBody.description ?? requestBodyDescription(requestBody),
        )
      : z
          .record(z.unknown())
          .describe(requestBody.description ?? requestBodyDescription(requestBody));
    shape.body = requestBody.required ? bodySchema : bodySchema.optional();
  }

  if (record.isTradingMutation) {
    shape.confirmTrading = z
      .literal(true)
      .describe(
        "Must be true for live trading mutations, including regular and conditional order creation, modification, or cancellation. The server also requires TOSSINVEST_TRADING_MODE=LIVE_TRADING and a complete local trading policy.",
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
    callable: !INTERNAL_OPERATION_IDS.has(record.operation.operationId),
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

  const requestBody = expandRequestBodySchemas(
    resolveRequestBody(record.operation.requestBody),
  );
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
        // OpenAPI operationIds are not a durable safety boundary: the official
        // document can add new trading endpoints at any time. GET is the only
        // method treated as read-only; every other callable method fails closed
        // behind the live-trading and explicit-confirmation guards.
        isTradingMutation:
          !INTERNAL_OPERATION_IDS.has(operationId) && method !== "get",
      });
    }
  }

  return records;
}

export function zodFromJsonSchema(
  schema: JsonSchema | undefined,
  description?: string,
  resolvingRefs = new Set<string>(),
): z.ZodTypeAny {
  if (!schema) {
    return description ? z.unknown().describe(description) : z.unknown();
  }

  if (schema.$ref) {
    if (resolvingRefs.has(schema.$ref)) {
      return z.unknown().describe(`Cyclic OpenAPI reference: ${schema.$ref}`);
    }
    const nextRefs = new Set(resolvingRefs).add(schema.$ref);
    const resolved = resolveRef<JsonSchema>(schema.$ref);
    return zodFromJsonSchema(
      resolved,
      description ?? schema.description,
      nextRefs,
    );
  }

  let result: z.ZodTypeAny;
  if (schema.oneOf?.length) {
    const branches = schema.oneOf.map((branch) =>
      zodFromJsonSchema(branch, undefined, resolvingRefs),
    );
    result = exclusiveUnion(branches);
  } else if (schema.anyOf?.length) {
    result = unionSchemas(
      schema.anyOf.map((branch) =>
        zodFromJsonSchema(branch, undefined, resolvingRefs),
      ),
    );
  } else {
    result = zodFromSchemaType(schema, resolvingRefs);
  }

  if (schema.allOf?.length) {
    const allOf = schema.allOf.map((branch) =>
      zodFromJsonSchema(branch, undefined, resolvingRefs),
    );
    const hasOwnSchema = Boolean(
      schema.type ||
        schema.enum?.length ||
        schema.properties ||
        schema.items ||
        schema.oneOf?.length ||
        schema.anyOf?.length,
    );
    result = intersectSchemas(hasOwnSchema ? [result, ...allOf] : allOf);
  }

  if ((schema as JsonSchema & { nullable?: boolean }).nullable) {
    result = result.nullable();
  }
  if (description || schema.description) {
    result = result.describe(description ?? schema.description ?? "");
  }
  return result;
}

function zodFromSchemaType(
  schema: JsonSchema,
  resolvingRefs: Set<string>,
): z.ZodTypeAny {
  if (schema.enum?.length) {
    const literals = schema.enum
      .filter(isJsonLiteral)
      .map((value) => z.literal(value));
    if (literals.length) {
      return unionSchemas(literals);
    }
  }

  if (Array.isArray(schema.type)) {
    return unionSchemas(
      schema.type.map((type) =>
        zodFromSchemaType({ ...schema, type }, resolvingRefs),
      ),
    );
  }

  const type = schema.type ??
    (schema.properties ? "object" : schema.items ? "array" : undefined);
  switch (type) {
    case "integer": {
      let numberSchema = z.number().int();
      if (schema.minimum !== undefined) {
        numberSchema = numberSchema.min(schema.minimum);
      }
      if (schema.maximum !== undefined) {
        numberSchema = numberSchema.max(schema.maximum);
      }
      return numberSchema;
    }
    case "number": {
      let numberSchema = z.number();
      if (schema.minimum !== undefined) {
        numberSchema = numberSchema.min(schema.minimum);
      }
      if (schema.maximum !== undefined) {
        numberSchema = numberSchema.max(schema.maximum);
      }
      return numberSchema;
    }
    case "boolean":
      return z.boolean();
    case "null":
      return z.null();
    case "array":
      return z.array(
        zodFromJsonSchema(schema.items, undefined, resolvingRefs),
      );
    case "object": {
      const required = new Set(schema.required ?? []);
      const shape: z.ZodRawShape = {};
      for (const [name, property] of Object.entries(schema.properties ?? {})) {
        const propertySchema = zodFromJsonSchema(
          property,
          undefined,
          resolvingRefs,
        );
        shape[name] = required.has(name)
          ? propertySchema
          : propertySchema.optional();
      }
      return z.object(shape).passthrough();
    }
    case "string": {
      let stringSchema = z.string();
      if (schema.minLength !== undefined) {
        stringSchema = stringSchema.min(schema.minLength);
      }
      if (schema.maxLength !== undefined) {
        stringSchema = stringSchema.max(schema.maxLength);
      }
      if (schema.pattern) {
        stringSchema = stringSchema.regex(new RegExp(schema.pattern));
      }
      if (schema.format === "date") {
        stringSchema = stringSchema.date();
      } else if (schema.format === "date-time") {
        stringSchema = stringSchema.datetime({ offset: true });
      }
      return stringSchema;
    }
    default:
      return z.unknown();
  }
}

function exclusiveUnion(schemas: z.ZodTypeAny[]) {
  const union = unionSchemas(schemas);
  if (schemas.length <= 1) {
    return union;
  }
  return union.superRefine((value, context) => {
    const matches = schemas.filter((schema) => schema.safeParse(value).success);
    if (matches.length !== 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Value must match exactly one OpenAPI oneOf branch.",
      });
    }
  });
}

function unionSchemas(schemas: z.ZodTypeAny[]): z.ZodTypeAny {
  if (!schemas.length) {
    return z.never();
  }
  if (schemas.length === 1) {
    return schemas[0];
  }
  return z.union(
    schemas as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]],
  );
}

function intersectSchemas(schemas: z.ZodTypeAny[]): z.ZodTypeAny {
  if (!schemas.length) {
    return z.unknown();
  }
  return schemas.slice(1).reduce(
    (combined, schema) => z.intersection(combined, schema),
    schemas[0],
  );
}

function expandRequestBodySchemas(
  requestBody: OpenApiRequestBody | undefined,
): OpenApiRequestBody | undefined {
  if (!requestBody?.content) {
    return requestBody;
  }
  return {
    ...requestBody,
    content: Object.fromEntries(
      Object.entries(requestBody.content).map(([mediaType, media]) => [
        mediaType,
        {
          ...media,
          schema: media.schema
            ? expandJsonSchema(media.schema)
            : media.schema,
        },
      ]),
    ),
  };
}

function expandJsonSchema(
  schema: JsonSchema,
  resolvingRefs = new Set<string>(),
): JsonSchema {
  if (schema.$ref) {
    if (resolvingRefs.has(schema.$ref)) {
      return schema;
    }
    const nextRefs = new Set(resolvingRefs).add(schema.$ref);
    const { $ref: _ref, ...siblings } = schema;
    return {
      ...expandJsonSchema(resolveRef<JsonSchema>(schema.$ref), nextRefs),
      ...expandJsonSchema(siblings, nextRefs),
    };
  }

  return {
    ...schema,
    ...(schema.properties
      ? {
          properties: Object.fromEntries(
            Object.entries(schema.properties).map(([name, property]) => [
              name,
              expandJsonSchema(property, resolvingRefs),
            ]),
          ),
        }
      : {}),
    ...(schema.items
      ? { items: expandJsonSchema(schema.items, resolvingRefs) }
      : {}),
    ...(schema.allOf
      ? {
          allOf: schema.allOf.map((branch) =>
            expandJsonSchema(branch, resolvingRefs),
          ),
        }
      : {}),
    ...(schema.oneOf
      ? {
          oneOf: schema.oneOf.map((branch) =>
            expandJsonSchema(branch, resolvingRefs),
          ),
        }
      : {}),
    ...(schema.anyOf
      ? {
          anyOf: schema.anyOf.map((branch) =>
            expandJsonSchema(branch, resolvingRefs),
          ),
        }
      : {}),
  };
}

function isJsonLiteral(
  value: unknown,
): value is string | number | boolean | null {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
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
