import assert from "node:assert/strict";
import { request, type Server } from "node:http";
import test from "node:test";
import { resolveHttpOptions, startHttp } from "../src/index.js";

test("HTTP options fail closed for authentication and CORS", () => {
  assert.throws(
    () => resolveHttpOptions({}),
    /MCP_HTTP_BEARER_TOKEN is required/,
  );
  assert.throws(
    () =>
      resolveHttpOptions({
        MCP_HTTP_BEARER_TOKEN: "0123456789abcdef0123456789abcdef",
        MCP_ALLOWED_ORIGIN: "*",
      }),
    /does not accept '\*'/,
  );
  assert.throws(
    () => resolveHttpOptions({ MCP_HTTP_BEARER_TOKEN: "too-short" }),
    /at least 32 characters/,
  );
  assert.throws(
    () =>
      resolveHttpOptions({
        MCP_HTTP_BEARER_TOKEN: "0123456789abcdef0123456789abcdef",
        MCP_HTTP_HOST: "0.0.0.0",
      }),
    /Non-loopback MCP_HTTP_HOST is blocked/,
  );
  assert.equal(
    resolveHttpOptions({
      MCP_HTTP_BEARER_TOKEN: "0123456789abcdef0123456789abcdef",
      MCP_HTTP_HOST: "0.0.0.0",
      MCP_HTTP_ALLOW_INSECURE_EXTERNAL_BIND: "true",
    }).host,
    "0.0.0.0",
  );

  const options = resolveHttpOptions({
    MCP_HTTP_BEARER_TOKEN: "0123456789abcdef0123456789abcdef",
  });
  assert.equal(options.host, "127.0.0.1");
  assert.equal(options.path, "/mcp");
  assert.equal(options.maxBodyBytes, 1024 * 1024);
  assert.deepEqual([...options.allowedOrigins], []);
});

test("HTTP server enforces bearer auth, exact CORS origins, and body limits", async (t) => {
  const token = "0123456789abcdef0123456789abcdef";
  const server = await startHttp({
    PORT: "0",
    MCP_HTTP_BEARER_TOKEN: token,
    MCP_ALLOWED_ORIGIN: "https://trusted.example",
    MCP_HTTP_MAX_BODY_BYTES: "512",
    TOSSINVEST_AUDIT_LOG: "false",
  });
  t.after(() => closeServer(server));

  const address = server.address();
  assert.ok(address && typeof address === "object");
  assert.equal(address.address, "127.0.0.1");
  const endpoint = `http://127.0.0.1:${address.port}/mcp`;

  const unauthorized = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(unauthorized.status, 401);
  assert.match(unauthorized.headers.get("www-authenticate") ?? "", /^Bearer /);

  const forbiddenOrigin = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Origin: "https://attacker.example",
    },
    body: "{}",
  });
  assert.equal(forbiddenOrigin.status, 403);
  assert.equal(forbiddenOrigin.headers.get("access-control-allow-origin"), null);

  const preflight = await fetch(endpoint, {
    method: "OPTIONS",
    headers: {
      Origin: "https://trusted.example",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "authorization,content-type",
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(
    preflight.headers.get("access-control-allow-origin"),
    "https://trusted.example",
  );
  assert.match(preflight.headers.get("vary") ?? "", /Origin/);

  const oversized = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ value: "x".repeat(600) }),
  });
  assert.equal(oversized.status, 413);

  assert.equal(await postOversizedChunked(endpoint, token), 413);

  const malformed = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: "{",
  });
  assert.equal(malformed.status, 400);

  const initialized = await fetch(endpoint, {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "MCP-Protocol-Version": "2025-06-18",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "http-security-test", version: "1.0.0" },
      },
    }),
  });
  assert.equal(initialized.status, 200);
  assert.match(await initialized.text(), /toss-invest-mcp-server/);
});

function closeServer(server: Server) {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function postOversizedChunked(endpoint: string, token: string) {
  return new Promise<number | undefined>((resolve, reject) => {
    const req = request(
      endpoint,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      },
      (res) => {
        res.resume();
        res.once("end", () => resolve(res.statusCode));
      },
    );
    req.once("error", reject);
    req.write('{"value":"');
    req.write("x".repeat(600));
    req.end('"}');
  });
}
