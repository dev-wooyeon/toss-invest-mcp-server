#!/usr/bin/env node
import { timingSafeEqual } from "node:crypto";
import { realpathSync } from "node:fs";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import { pathToFileURL } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadEnvFiles } from "./env.js";
import {
  createServer,
  createServerDependencies,
  type ServerDependencies,
} from "./server.js";

const DEFAULT_HTTP_HOST = "127.0.0.1";
const DEFAULT_HTTP_PORT = 3000;
const DEFAULT_HTTP_PATH = "/mcp";
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const MIN_BEARER_TOKEN_LENGTH = 32;

export type HttpOptions = {
  host: string;
  port: number;
  path: string;
  bearerToken: string;
  allowedOrigins: ReadonlySet<string>;
  maxBodyBytes: number;
};

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

export async function startStdio() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("toss-invest-mcp-server running on stdio");
}

export async function startHttp(
  env: NodeJS.ProcessEnv = process.env,
  dependencies?: ServerDependencies,
): Promise<HttpServer> {
  const options = resolveHttpOptions(env);
  const sharedDependencies = dependencies ?? createServerDependencies(env);
  const httpServer = createHttpServer(
    createHttpRequestHandler(options, sharedDependencies),
  );

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    httpServer.once("error", onError);
    httpServer.listen(options.port, options.host, () => {
      httpServer.off("error", onError);
      resolve();
    });
  });

  const address = httpServer.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  console.error(
    `toss-invest-mcp-server running on http://${formatHost(options.host)}:${port}${options.path}`,
  );
  return httpServer;
}

export function resolveHttpOptions(
  env: NodeJS.ProcessEnv = process.env,
): HttpOptions {
  const bearerToken = env.MCP_HTTP_BEARER_TOKEN;
  if (!bearerToken?.trim()) {
    throw new Error(
      "MCP_HTTP_BEARER_TOKEN is required in HTTP mode. Use stdio for local tokenless access.",
    );
  }
  if (bearerToken !== bearerToken.trim()) {
    throw new Error(
      "MCP_HTTP_BEARER_TOKEN must not contain leading or trailing whitespace.",
    );
  }
  if (/[\u0000-\u001f\u007f]/.test(bearerToken)) {
    throw new Error("MCP_HTTP_BEARER_TOKEN must not contain control characters.");
  }
  if (bearerToken.length < MIN_BEARER_TOKEN_LENGTH) {
    throw new Error(
      `MCP_HTTP_BEARER_TOKEN must be at least ${MIN_BEARER_TOKEN_LENGTH} characters. Use a cryptographically random token.`,
    );
  }

  const host = env.MCP_HTTP_HOST?.trim() || DEFAULT_HTTP_HOST;
  if (host.includes("://") || /[\s/]/.test(host)) {
    throw new Error("MCP_HTTP_HOST must be a hostname or IP address.");
  }
  if (
    !isLoopbackHost(host) &&
    env.MCP_HTTP_ALLOW_INSECURE_EXTERNAL_BIND?.trim().toLowerCase() !== "true"
  ) {
    throw new Error(
      "Non-loopback MCP_HTTP_HOST is blocked because the built-in server is plain HTTP. Keep loopback behind a TLS reverse proxy, or explicitly set MCP_HTTP_ALLOW_INSECURE_EXTERNAL_BIND=true only on a protected network.",
    );
  }

  const path = env.MCP_HTTP_PATH?.trim() || DEFAULT_HTTP_PATH;
  if (!path.startsWith("/") || /[\s?#]/.test(path)) {
    throw new Error(
      "MCP_HTTP_PATH must be an absolute URL path without a query or fragment.",
    );
  }

  return {
    host,
    port: parseIntegerInRange(env.PORT, DEFAULT_HTTP_PORT, 0, 65_535, "PORT"),
    path,
    bearerToken,
    allowedOrigins: parseAllowedOrigins(env.MCP_ALLOWED_ORIGIN),
    maxBodyBytes: parseIntegerInRange(
      env.MCP_HTTP_MAX_BODY_BYTES,
      DEFAULT_MAX_BODY_BYTES,
      1,
      Number.MAX_SAFE_INTEGER,
      "MCP_HTTP_MAX_BODY_BYTES",
    ),
  };
}

function isLoopbackHost(host: string) {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

export function createHttpRequestHandler(
  options: HttpOptions,
  dependencies: ServerDependencies,
) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    setSecurityHeaders(res);

    const pathname = requestPathname(req.url);
    if (!pathname) {
      sendJsonRpcError(res, 400, -32600, "Invalid request URL");
      return;
    }
    if (pathname !== options.path) {
      sendJsonRpcError(res, 404, -32004, "Not found");
      return;
    }

    if (!applyCors(req, res, options.allowedOrigins)) {
      sendJsonRpcError(res, 403, -32003, "Origin not allowed");
      return;
    }

    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }

    if (!isAuthorized(req.headers.authorization, options.bearerToken)) {
      res.setHeader("WWW-Authenticate", 'Bearer realm="toss-invest-mcp"');
      sendJsonRpcError(res, 401, -32001, "Unauthorized");
      return;
    }

    if (req.method !== "POST") {
      res.setHeader("Allow", "POST, OPTIONS");
      sendJsonRpcError(res, 405, -32000, "Method not allowed");
      return;
    }

    let body: unknown;
    try {
      body = await readJsonBody(req, options.maxBodyBytes);
    } catch (error) {
      if (error instanceof HttpRequestError) {
        if (error.status === 413) {
          res.setHeader("Connection", "close");
        }
        sendJsonRpcError(res, error.status, error.code, error.message);
        return;
      }
      sendJsonRpcError(res, 400, -32700, "Unable to read request body");
      return;
    }

    const mcpServer = createServer(dependencies);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    let connected = false;
    let closePromise: Promise<void> | undefined;
    const close = () => {
      closePromise ??= connected ? mcpServer.close() : transport.close();
      return closePromise;
    };
    res.once("close", () => {
      void close();
    });

    try {
      await mcpServer.connect(transport);
      connected = true;
      await transport.handleRequest(req, res, body);
    } catch (error) {
      await close().catch(() => undefined);
      if (!res.headersSent) {
        console.error(
          `toss-invest-mcp-server HTTP request failed (${errorName(error)})`,
        );
        sendJsonRpcError(res, 500, -32603, "Internal server error");
      } else if (!res.writableEnded) {
        res.end();
      }
    }
  };
}

function applyCors(
  req: IncomingMessage,
  res: ServerResponse,
  allowedOrigins: ReadonlySet<string>,
) {
  const origin = req.headers.origin;
  if (!origin) {
    return true;
  }

  const normalizedOrigin = normalizeOrigin(origin);
  if (!normalizedOrigin || !allowedOrigins.has(normalizedOrigin)) {
    return false;
  }

  res.setHeader("Access-Control-Allow-Origin", normalizedOrigin);
  appendVary(res, "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, MCP-Protocol-Version, MCP-Session-Id",
  );
  res.setHeader("Access-Control-Expose-Headers", "MCP-Session-Id");
  return true;
}

function parseAllowedOrigins(value: string | undefined) {
  const configured = (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const origins = new Set<string>();

  for (const origin of configured) {
    if (origin === "*") {
      throw new Error(
        "MCP_ALLOWED_ORIGIN does not accept '*'. Configure exact HTTP(S) origins separated by commas.",
      );
    }
    const normalized = normalizeOrigin(origin);
    if (!normalized) {
      throw new Error(
        `Invalid MCP_ALLOWED_ORIGIN value: ${origin}. Use exact HTTP(S) origins.`,
      );
    }
    origins.add(normalized);
  }

  return origins;
}

function normalizeOrigin(value: string) {
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      return undefined;
    }
    return url.origin;
  } catch {
    return undefined;
  }
}

function isAuthorized(authorization: string | undefined, bearerToken: string) {
  if (!authorization) {
    return false;
  }
  const actual = Buffer.from(authorization);
  const expected = Buffer.from(`Bearer ${bearerToken}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function setSecurityHeaders(res: ServerResponse) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
}

function appendVary(res: ServerResponse, value: string) {
  const current = res.getHeader("Vary");
  const values = Array.isArray(current)
    ? current
    : String(current ?? "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
  if (!values.some((item) => item.toLowerCase() === value.toLowerCase())) {
    values.push(value);
  }
  res.setHeader("Vary", values.join(", "));
}

function readJsonBody(req: IncomingMessage, maxBodyBytes: number) {
  const contentLength = req.headers["content-length"];
  if (contentLength) {
    const parsedLength = Number(contentLength);
    if (Number.isFinite(parsedLength) && parsedLength > maxBodyBytes) {
      return Promise.reject(
        bodyTooLargeError(maxBodyBytes),
      );
    }
  }

  return new Promise<unknown>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytesRead = 0;

    const cleanup = () => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      req.off("aborted", onAborted);
    };
    const onData = (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytesRead += buffer.byteLength;
      if (bytesRead > maxBodyBytes) {
        cleanup();
        req.pause();
        reject(bodyTooLargeError(maxBodyBytes));
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = () => {
      cleanup();
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new HttpRequestError(400, -32700, "Invalid JSON request body"));
      }
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onAborted = () => {
      cleanup();
      reject(new HttpRequestError(400, -32600, "Request body was aborted"));
    };

    req.on("data", onData);
    req.once("end", onEnd);
    req.once("error", onError);
    req.once("aborted", onAborted);
  });
}

function bodyTooLargeError(maxBodyBytes: number) {
  return new HttpRequestError(
    413,
    -32013,
    `Request body exceeds the ${maxBodyBytes} byte limit`,
  );
}

function sendJsonRpcError(
  res: ServerResponse,
  status: number,
  code: number,
  message: string,
) {
  if (res.writableEnded) {
    return;
  }
  res
    .writeHead(status, { "Content-Type": "application/json; charset=utf-8" })
    .end(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code, message },
        id: null,
      }),
    );
}

function requestPathname(requestUrl: string | undefined) {
  try {
    return new URL(requestUrl ?? "/", "http://127.0.0.1").pathname;
  } catch {
    return undefined;
  }
}

function parseIntegerInRange(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
  name: string,
) {
  if (value === undefined || !value.trim()) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  return parsed;
}

function formatHost(host: string) {
  return host.includes(":") ? `[${host}]` : host;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function errorName(error: unknown) {
  return error instanceof Error ? error.name : "UnknownError";
}

function isMainModule() {
  const entrypoint = process.argv[1];
  if (!entrypoint) {
    return false;
  }
  try {
    return import.meta.url === pathToFileURL(realpathSync(entrypoint)).href;
  } catch {
    return false;
  }
}

class HttpRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

if (isMainModule()) {
  main().catch((error) => {
    console.error(errorMessage(error));
    process.exit(1);
  });
}
