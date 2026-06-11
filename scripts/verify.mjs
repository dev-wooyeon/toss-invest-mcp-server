#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "toss-invest-verify", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  env: {
    ...process.env,
    TOSSINVEST_TRADING_MODE: "READ_ONLY",
    TOSSINVEST_AUDIT_LOG: "false",
  },
});

await client.connect(transport);

const tools = await client.listTools();
const toolNames = tools.tools.map((tool) => tool.name);
const requiredTools = [
  "toss_invest_auth_status",
  "toss_invest_stock_snapshot",
  "toss_invest_portfolio_snapshot",
  "toss_invest_market_status",
  "toss_invest_account_risk_summary",
  "toss_invest_order_preflight",
  "toss_invest_create_order_dry_run",
  "toss_invest_create_order",
];

for (const tool of requiredTools) {
  if (!toolNames.includes(tool)) {
    throw new Error(`Missing expected tool: ${tool}`);
  }
}

const status = await client.callTool({
  name: "toss_invest_auth_status",
  arguments: {},
});
const statusBody = JSON.parse(status.content[0].text);
if (statusBody.tradingMode !== "READ_ONLY") {
  throw new Error(`Expected READ_ONLY mode, got ${statusBody.tradingMode}`);
}

const dryRun = await client.callTool({
  name: "toss_invest_create_order_dry_run",
  arguments: {
    accountSeq: 1,
    body: {
      clientOrderId: "verify-dry-run",
      symbol: "005930",
      side: "BUY",
      orderType: "LIMIT",
      quantity: "1",
      price: "70000",
    },
  },
});
const dryRunBody = JSON.parse(dryRun.content[0].text);
if (dryRunBody.executed !== false) {
  throw new Error("Dry run must not execute orders.");
}

const liveAttempt = await client.callTool({
  name: "toss_invest_create_order",
  arguments: {
    accountSeq: 1,
    confirmTrading: true,
    body: {
      clientOrderId: "verify-live-blocked",
      symbol: "005930",
      side: "BUY",
      orderType: "LIMIT",
      quantity: "1",
      price: "70000",
    },
  },
});
if (!liveAttempt.isError || !liveAttempt.content[0].text.includes("LIVE_TRADING")) {
  throw new Error("Live trading attempt was not blocked in READ_ONLY mode.");
}

await client.close();
console.log(`Verified ${toolNames.length} tools. READ_ONLY live trading guard is active.`);
