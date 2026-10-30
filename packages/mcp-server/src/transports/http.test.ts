// SPDX-License-Identifier: MIT
import type { AddressInfo } from "node:net";
import type { Server as HttpServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PostwaveClient } from "@postwave/sdk";

import { startHttp } from "./http.js";
import { createServer } from "../server.js";

let httpServer: HttpServer | undefined;

afterEach(() => {
  httpServer?.close();
  httpServer = undefined;
  vi.unstubAllEnvs();
});

const inboundToken = "separate-inbound-test-token";

function initialize(port: number, id: number): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${inboundToken}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" },
      },
    }),
  });
}

describe("startHttp (stateless transport)", () => {
  it("serves multiple sequential requests — regression for the single shared transport crashing on the 2nd request", async () => {
    const stubClient = {} as unknown as PostwaveClient;
    const factory = vi.fn(() => createServer(stubClient));

    httpServer = await startHttp(factory, {
      port: 0,
      expectedToken: inboundToken,
    });
    const port = (httpServer.address() as AddressInfo).port;

    const r1 = await initialize(port, 1);
    await r1.body?.cancel();
    const r2 = await initialize(port, 2);
    await r2.body?.cancel();

    // The old code reused ONE StreamableHTTPServerTransport, which throws on
    // the second request (→ 500). A fresh server+transport per request keeps
    // both healthy and identical.
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    // A fresh server is built per request (stateless).
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("refuses HTTP startup without a distinct inbound token", async () => {
    const factory = vi.fn(() => createServer({} as unknown as PostwaveClient));
    await expect(startHttp(factory, { port: 0 })).rejects.toThrow(
      "POSTWAVE_MCP_INBOUND_TOKEN",
    );
    expect(factory).not.toHaveBeenCalled();
  });

  it("structurally refuses non-loopback binding", async () => {
    const factory = vi.fn(() => createServer({} as unknown as PostwaveClient));
    await expect(
      startHttp(factory, {
        port: 0,
        host: "0.0.0.0",
        expectedToken: inboundToken,
      }),
    ).rejects.toThrow("loopback");
  });

  it("rejects reuse of the outbound tenant API key as the inbound transport secret", async () => {
    vi.stubEnv("POSTWAVE_API_KEY", inboundToken);
    const factory = vi.fn(() => createServer({} as unknown as PostwaveClient));
    await expect(
      startHttp(factory, { port: 0, expectedToken: inboundToken }),
    ).rejects.toThrow("distinct");
  });

  it("rejects invalid port configuration before listen", async () => {
    const factory = vi.fn(() => createServer({} as unknown as PostwaveClient));
    await expect(
      startHttp(factory, { port: 70000, expectedToken: inboundToken }),
    ).rejects.toThrow("0 to 65535");
  });

  it("rejects an unauthorized request before building a server", async () => {
    const factory = vi.fn(() => createServer({} as unknown as PostwaveClient));
    httpServer = await startHttp(factory, {
      port: 0,
      expectedToken: inboundToken,
    });
    const port = (httpServer.address() as AddressInfo).port;

    const res = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST" });
    await res.body?.cancel();
    expect(res.status).toBe(401);
    expect(factory).not.toHaveBeenCalled(); // auth fails before the server is built
  });

  it("requires exact path, method, JSON content type, bounded body, and an allowlisted Origin", async () => {
    const factory = vi.fn(() => createServer({} as unknown as PostwaveClient));
    httpServer = await startHttp(factory, {
      port: 0,
      expectedToken: inboundToken,
      allowedOrigins: ["https://trusted.local"],
      maxBodyBytes: 1024,
    });
    const port = (httpServer.address() as AddressInfo).port;
    const auth = { authorization: `Bearer ${inboundToken}` };

    const lookalike = await fetch(`http://127.0.0.1:${port}/mcp-evil`, {
      method: "POST",
      headers: auth,
    });
    expect(lookalike.status).toBe(404);
    const wrongMethod = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "GET",
      headers: auth,
    });
    expect(wrongMethod.status).toBe(405);
    const query = await fetch(`http://127.0.0.1:${port}/mcp?tenant=other`, {
      method: "POST",
      headers: auth,
    });
    expect(query.status).toBe(400);
    const badOrigin = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        ...auth,
        origin: "https://evil.local",
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect(badOrigin.status).toBe(403);
    const badType = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        ...auth,
        origin: "https://trusted.local",
        "content-type": "text/plain",
      },
      body: "{}",
    });
    expect(badType.status).toBe(415);
    const tooLarge = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        ...auth,
        origin: "https://trusted.local",
        "content-type": "application/json",
      },
      body: JSON.stringify({ x: "x".repeat(2048) }),
    });
    expect(tooLarge.status).toBe(413);
    expect(factory).not.toHaveBeenCalled();
  });

  it("protects health information with the same inbound credential", async () => {
    const factory = vi.fn(() => createServer({} as unknown as PostwaveClient));
    httpServer = await startHttp(factory, {
      port: 0,
      expectedToken: inboundToken,
    });
    const port = (httpServer.address() as AddressInfo).port;
    const denied = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(denied.status).toBe(401);
    const allowed = await fetch(`http://127.0.0.1:${port}/healthz`, {
      headers: { authorization: `Bearer ${inboundToken}` },
    });
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual({
      ok: true,
      mode: "private_loopback_single_tenant",
    });
    expect(factory).not.toHaveBeenCalled();
  });
});
