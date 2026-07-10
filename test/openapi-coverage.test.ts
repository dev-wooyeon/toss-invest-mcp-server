import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod/v3";
import { TossInvestClient } from "../src/client.js";
import { getConfig } from "../src/config.js";
import { createServer } from "../src/server.js";
import {
  buildToolInputSchema,
  getOperation,
  listOperationSummaries,
  openapi,
  operationDetails,
  operations,
  toolNameForOperation,
  zodFromJsonSchema,
} from "../src/spec.js";

const NEW_IN_1_2_2 = [
  "getRankings",
  "getMarketIndicatorPrices",
  "getMarketIndicatorCandles",
  "getMarketIndicatorInvestorTrading",
  "createConditionalOrder",
  "getConditionalOrders",
  "getConditionalOrder",
  "cancelConditionalOrder",
  "modifyConditionalOrder",
] as const;

const CONDITIONAL_ORDER_MUTATIONS = [
  "createConditionalOrder",
  "modifyConditionalOrder",
  "cancelConditionalOrder",
] as const;

test("bundled OpenAPI 1.2.2 indexes every official operation", () => {
  assert.equal(openapi.openapi, "3.1.0");
  assert.equal(openapi.info.version, "1.2.2");

  const documentOperationIds = Object.values(openapi.paths)
    .flatMap((pathItem) => Object.values(pathItem))
    .flatMap((operation) =>
      operation && typeof operation.operationId === "string"
        ? [operation.operationId]
        : [],
    )
    .sort();
  const indexedOperationIds = operations
    .map((record) => record.operation.operationId)
    .sort();

  assert.deepEqual(indexedOperationIds, documentOperationIds);
  assert.equal(new Set(indexedOperationIds).size, indexedOperationIds.length);
  for (const operationId of NEW_IN_1_2_2) {
    assert.ok(getOperation(operationId), `${operationId} must be indexed`);
  }
});

test("every callable official operation has a unique MCP tool and parseable input schema", () => {
  const summaries = listOperationSummaries();
  const callable = summaries.filter((summary) => summary.callable);

  assert.equal(
    summaries.find((summary) => summary.operationId === "issueOAuth2Token")
      ?.callable,
    false,
  );
  assert.equal(callable.length, operations.length - 1);
  assert.equal(
    new Set(callable.map((summary) => summary.toolName)).size,
    callable.length,
  );

  for (const summary of callable) {
    const record = getOperation(summary.operationId);
    assert.ok(record, `${summary.operationId} must resolve`);
    assert.equal(summary.toolName, toolNameForOperation(summary.operationId));
    assert.doesNotThrow(() => z.object(buildToolInputSchema(record)));
  }
});

test("MCP registers every callable official operation and keeps OAuth internal", async () => {
  const server = createServer();
  const client = new Client({
    name: "openapi-coverage-test",
    version: "1.0.0",
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const registeredToolNames = new Set(
      (await client.listTools()).tools.map((tool) => tool.name),
    );

    for (const summary of listOperationSummaries()) {
      assert.equal(
        registeredToolNames.has(summary.toolName),
        summary.callable,
        `${summary.operationId} callable registration mismatch`,
      );
    }
  } finally {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
});

test("all non-GET callable operations fail closed as trading mutations", () => {
  for (const record of operations) {
    const operationId = record.operation.operationId;
    if (operationId === "issueOAuth2Token") {
      assert.equal(record.isTradingMutation, false);
      continue;
    }

    assert.equal(
      record.isTradingMutation,
      record.method !== "get",
      `${record.method.toUpperCase()} ${operationId} classification mismatch`,
    );
  }
});

test("conditional-order mutations require explicit trading confirmation", () => {
  const conditionalBody = {
    type: "SINGLE",
    quantity: "1",
    orderType: "LIMIT",
    expireDate: "2026-09-10",
    first: {
      orderSide: "SELL",
      triggerPrice: "70000",
      orderPrice: "70000",
    },
  };
  const validArgs: Record<string, Record<string, unknown>> = {
    createConditionalOrder: {
      body: { ...conditionalBody, symbol: "005930" },
      confirmTrading: true,
    },
    modifyConditionalOrder: {
      conditionalOrderId: "conditional-order-1",
      body: conditionalBody,
      confirmTrading: true,
    },
    cancelConditionalOrder: {
      conditionalOrderId: "conditional-order-1",
      confirmTrading: true,
    },
  };

  for (const operationId of CONDITIONAL_ORDER_MUTATIONS) {
    const record = getOperation(operationId);
    assert.ok(record, `${operationId} must exist`);
    assert.equal(record.isTradingMutation, true);

    const inputSchema = z.object(buildToolInputSchema(record));
    assert.equal(inputSchema.safeParse(validArgs[operationId]).success, true);
    assert.equal(
      inputSchema.safeParse({
        ...validArgs[operationId],
        confirmTrading: false,
      }).success,
      false,
    );
    const { confirmTrading: _confirmTrading, ...withoutConfirmation } =
      validArgs[operationId];
    assert.equal(inputSchema.safeParse(withoutConfirmation).success, false);
  }
});

test("order request bodies preserve oneOf exclusivity in MCP input", () => {
  const record = getOperation("createOrder");
  assert.ok(record);
  const inputSchema = z.object(buildToolInputSchema(record));
  const base = { accountSeq: 1, confirmTrading: true as const };

  assert.equal(
    inputSchema.safeParse({
      ...base,
      body: {
        symbol: "AAPL",
        side: "SELL",
        orderType: "MARKET",
        quantity: "0.5",
      },
    }).success,
    true,
  );
  assert.equal(
    inputSchema.safeParse({
      ...base,
      body: {
        symbol: "AAPL",
        side: "BUY",
        orderType: "MARKET",
        orderAmount: "100.5",
      },
    }).success,
    true,
  );
  assert.equal(
    inputSchema.safeParse({
      ...base,
      body: {
        symbol: "AAPL",
        side: "BUY",
        orderType: "MARKET",
        quantity: "1",
        orderAmount: "100.5",
      },
    }).success,
    false,
    "OpenAPI oneOf must reject a body matching both order variants",
  );

  const requestSchema = operationDetails(record).requestBody?.content?.[
    "application/json"
  ]?.schema;
  assert.ok(requestSchema);
  assert.equal(JSON.stringify(requestSchema).includes('"$ref"'), false);
  assert.equal(requestSchema.oneOf?.length, 2);
});

test("conditional-order body exposes resolved nested required fields and enums", () => {
  const record = getOperation("createConditionalOrder");
  assert.ok(record);
  const inputSchema = z.object(buildToolInputSchema(record));
  const valid = {
    accountSeq: 1,
    confirmTrading: true as const,
    body: {
      symbol: "005930",
      type: "SINGLE",
      quantity: "1",
      orderType: "LIMIT",
      expireDate: "2026-09-10",
      first: {
        orderSide: "SELL",
        triggerPrice: "70000",
        orderPrice: "70000",
      },
    },
  };

  assert.equal(inputSchema.safeParse(valid).success, true);
  assert.equal(
    inputSchema.safeParse({
      ...valid,
      body: { ...valid.body, expireDate: undefined },
    }).success,
    false,
  );
  assert.equal(
    inputSchema.safeParse({
      ...valid,
      body: { ...valid.body, type: "UNKNOWN" },
    }).success,
    false,
  );
  assert.equal(
    inputSchema.safeParse({
      ...valid,
      body: {
        ...valid.body,
        first: { orderSide: "SELL", orderPrice: "70000" },
      },
    }).success,
    false,
  );

  const requestSchema = operationDetails(record).requestBody?.content?.[
    "application/json"
  ]?.schema;
  assert.ok(requestSchema);
  assert.equal(JSON.stringify(requestSchema).includes('"$ref"'), false);
  assert.deepEqual(requestSchema.required, [
    "symbol",
    "type",
    "quantity",
    "orderType",
    "expireDate",
    "first",
  ]);
  assert.deepEqual(
    requestSchema.properties?.first?.allOf?.[0]?.required,
    ["orderSide", "triggerPrice"],
  );
});

test("recursive JSON schema conversion preserves array item enums", () => {
  const schema = zodFromJsonSchema({
    type: "object",
    required: ["sides"],
    properties: {
      sides: {
        type: "array",
        items: { type: "string", enum: ["BUY", "SELL"] },
      },
    },
  });

  assert.equal(schema.safeParse({ sides: ["BUY", "SELL"] }).success, true);
  assert.equal(schema.safeParse({ sides: ["HOLD"] }).success, false);
  assert.equal(schema.safeParse({}).success, false);
});

test("READ_ONLY blocks every conditional-order mutation before network access", async () => {
  const client = new TossInvestClient(getConfig({}));

  for (const operationId of CONDITIONAL_ORDER_MUTATIONS) {
    const record = getOperation(operationId);
    assert.ok(record, `${operationId} must exist`);
    await assert.rejects(
      () =>
        client.callOperation(record, {
          body: {},
          conditionalOrderId: "conditional-order-1",
          confirmTrading: true,
        }),
      /LIVE_TRADING/,
    );
  }
});

test("conditional-order reads remain read-only", () => {
  for (const operationId of ["getConditionalOrders", "getConditionalOrder"]) {
    const record = getOperation(operationId);
    assert.ok(record, `${operationId} must exist`);
    assert.equal(record.isTradingMutation, false);
    assert.equal("confirmTrading" in buildToolInputSchema(record), false);
  }
});
