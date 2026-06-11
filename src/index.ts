#!/usr/bin/env node
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadEnvFiles } from "./env.js";
import { createServer } from "./server.js";

async function main() {
  const loadedEnvFiles = loadEnvFiles();
  if (loadedEnvFiles.length) {
    console.error(
      `toss-invest-mcp-server loaded env files: ${loadedEnvFiles.join(", ")}`,
    );
  }

  if (process.argv.includes("--http")) {
    await startHttp();
    return;
  }

  await startStdio();
}

async function startStdio() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("toss-invest-mcp-server running on stdio");
}

async function startHttp() {
  const port = Number(process.env.PORT ?? 3000);
  const path = process.env.MCP_HTTP_PATH ?? "/mcp";
  const bearerToken = process.env.MCP_HTTP_BEARER_TOKEN;
  const allowedOrigin = process.env.MCP_ALLOWED_ORIGIN ?? "*";

  const httpServer = createHttpServer(async (req, res) => {
    setCorsHeaders(res, allowedOrigin);

    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }

    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname !== path) {
      res.writeHead(404, { "Content-Type": "application/json" }).end(
        JSON.stringify({ error: "Not found" }),
      );
      return;
    }

    if (bearerToken && req.headers.authorization !== `Bearer ${bearerToken}`) {
      res.writeHead(401, { "Content-Type": "application/json" }).end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32001, message: "Unauthorized" },
          id: null,
        }),
      );
      return;
    }

    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json" }).end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Method not allowed" },
          id: null,
        }),
      );
      return;
    }

    const mcpServer = createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    try {
      const body = await readJsonBody(req);
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, body);
      res.on("close", () => {
        void transport.close();
        void mcpServer.close();
      });
    } catch (error) {
      await transport.close();
      await mcpServer.close();
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" }).end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: {
              code: -32603,
              message: error instanceof Error ? error.message : "Internal server error",
            },
            id: null,
          }),
        );
      }
    }
  });

  httpServer.listen(port, () => {
    console.error(`toss-invest-mcp-server running on http://localhost:${port}${path}`);
  });
}

function setCorsHeaders(res: ServerResponse, allowedOrigin: string) {
  res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, MCP-Protocol-Version",
  );
  res.setHeader("Access-Control-Expose-Headers", "MCP-Session-Id");
}

async function readJsonBody(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : undefined;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
