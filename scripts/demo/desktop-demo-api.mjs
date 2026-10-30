#!/usr/bin/env node

import http from "node:http";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";

const DEMO_TENANT_ID = "00000000-0000-4000-8000-000000000099";
const ALLOWED_ORIGINS = new Set([
  "http://localhost:1420",
  "http://127.0.0.1:1420",
  "http://tauri.localhost",
  "tauri://localhost",
]);

function json(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(body);
}

function applyCors(request, response) {
  const origin = request.headers.origin;
  if (typeof origin === "string" && ALLOWED_ORIGINS.has(origin)) {
    response.setHeader("Access-Control-Allow-Credentials", "true");
    response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Idempotency-Key");
    response.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS, POST");
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
  }
}

export function createDemoApiHandler({ apiKey }) {
  if (typeof apiKey !== "string" || !apiKey.startsWith("pw_live_demo_")) {
    throw new Error("A generated local demo API key is required");
  }

  const streamToken = `pwst_demo_${randomBytes(24).toString("hex")}`;

  return (request, response) => {
    applyCors(request, response);
    const method = request.method ?? "GET";
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const pathname = url.pathname;

    if (method === "OPTIONS") {
      response.writeHead(204, { "Cache-Control": "no-store" });
      response.end();
      return;
    }

    if ((method === "GET" || method === "HEAD") && pathname === "/api/health") {
      if (method === "HEAD") {
        response.writeHead(200, { "Cache-Control": "no-store" });
        response.end();
        return;
      }
      json(response, 200, {
        status: "ok",
        version: "desktop-demo",
        service: "postwave-demo-api",
      });
      return;
    }

    if (method === "GET" && pathname === "/api/v1/auth/me") {
      json(response, 401, {
        error: { code: "no_demo_cookie_session", message: "No cookie session" },
      });
      return;
    }

    // EventSource cannot attach the native broker's Authorization header.
    // Mirror production's short-lived-token exchange and keep a quiet SSE
    // connection open so the fixture UI does not enter a hot reconnect loop.
    if (
      method === "GET" &&
      pathname === "/api/v1/events" &&
      url.searchParams.get("stream_token") === streamToken
    ) {
      response.writeHead(200, {
        "Cache-Control": "no-cache, no-store",
        Connection: "keep-alive",
        "Content-Type": "text/event-stream; charset=utf-8",
      });
      response.write(
        `event: ready\ndata: ${JSON.stringify({
          topic: "ready",
          tenant_id: DEMO_TENANT_ID,
          at: new Date().toISOString(),
        })}\n\n`,
      );
      const heartbeat = setInterval(() => response.write(": demo heartbeat\n\n"), 15_000);
      request.once("close", () => clearInterval(heartbeat));
      return;
    }

    const authorized = request.headers.authorization === `Bearer ${apiKey}`;
    if (!authorized) {
      json(response, 401, {
        error: { code: "invalid_demo_key", message: "Invalid demo credential" },
      });
      return;
    }

    if (method === "GET" && pathname === "/api/v1/api-keys/me") {
      json(response, 200, {
        tenant_id: DEMO_TENANT_ID,
        tenant_slug: "postwave-desktop-demo",
        scopes: ["admin"],
        actor: "Demo host",
      });
      return;
    }

    if (method === "POST" && pathname === "/api/v1/streams/token") {
      json(response, 200, { token: streamToken, ttl_seconds: 3600 });
      return;
    }

    if (method === "GET" || method === "HEAD") {
      json(response, 404, {
        error: {
          code: "demo_fixture_fallback",
          message: "This read is supplied by the local desktop demo fixture.",
        },
      });
      return;
    }

    json(response, 409, {
      error: {
        code: "demo_read_only",
        message: "This local product walkthrough is read-only.",
      },
    });
  };
}

export function startDemoApi({ apiKey, host = "127.0.0.1", port = 8080 }) {
  const server = http.createServer(createDemoApiHandler({ apiKey }));
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("The local demo API did not expose a TCP address"));
        return;
      }
      resolve({ server, origin: `http://${host}:${address.port}` });
    });
  });
}

async function main() {
  const apiKey = process.env.POSTWAVE_DEMO_API_KEY ?? "";
  const rawPort = process.env.POSTWAVE_DEMO_API_PORT ?? "8080";
  if (!/^\d{1,5}$/u.test(rawPort)) {
    throw new Error("POSTWAVE_DEMO_API_PORT must be a TCP port");
  }
  const port = Number(rawPort);
  if (port < 1024 || port > 65_535) {
    throw new Error("POSTWAVE_DEMO_API_PORT must be between 1024 and 65535");
  }
  const { origin } = await startDemoApi({ apiKey, port });
  process.stdout.write(`Moosewave read-only demo API listening at ${origin}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`Moosewave demo API failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
    process.exitCode = 1;
  });
}
