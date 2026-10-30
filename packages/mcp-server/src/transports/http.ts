// SPDX-License-Identifier: MIT
import { createHash, timingSafeEqual } from "node:crypto";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
  type Server as HttpServer,
} from "node:http";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const DEFAULT_MAX_BODY_BYTES = 256 * 1024;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1"]);

export type HttpTransportOptions = {
  port?: number;
  host?: string;
  /** Inbound transport credential. Never reuse the outbound POSTWAVE_API_KEY. */
  expectedToken?: string;
  allowedOrigins?: string[];
  maxBodyBytes?: number;
};

class RequestInputError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function jsonError(res: ServerResponse, status: number, code: string): void {
  res.statusCode = status;
  res.setHeader("cache-control", "private, no-store");
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify({ error: { code } }));
}

function tokenMatches(req: IncomingMessage, expectedToken: string): boolean {
  const values = req.headersDistinct.authorization ?? [];
  if (values.length !== 1) return false;
  const match = /^Bearer ([^\s]{1,512})$/i.exec(values[0] ?? "");
  if (!match) return false;
  // Compare fixed-size digests so a differing token length does not produce a
  // distinguishable early return from the secret comparison.
  const supplied = createHash("sha256").update(match[1]!, "utf8").digest();
  const expected = createHash("sha256").update(expectedToken, "utf8").digest();
  return timingSafeEqual(supplied, expected);
}

function requestOriginAllowed(
  req: IncomingMessage,
  allowedOrigins: ReadonlySet<string>,
): boolean {
  const values = req.headersDistinct.origin ?? [];
  if (values.length === 0) return true; // ordinary non-browser MCP client
  return values.length === 1 && allowedOrigins.has(values[0]!);
}

function parseAllowedOrigins(configured?: string[]): Set<string> {
  const values =
    configured ?? (process.env.POSTWAVE_MCP_ALLOWED_ORIGINS ?? "").split(",");
  return new Set(values.map((value) => value.trim()).filter(Boolean));
}

async function readBoundedJSON(
  req: IncomingMessage,
  maxBodyBytes: number,
): Promise<unknown> {
  const contentType = (req.headers["content-type"] ?? "")
    .split(";", 1)[0]!
    .trim()
    .toLowerCase();
  if (contentType !== "application/json") {
    throw new RequestInputError(415, "unsupported_media_type");
  }
  const rawLength = req.headers["content-length"];
  if (rawLength !== undefined) {
    if (!/^\d+$/.test(rawLength))
      throw new RequestInputError(400, "invalid_content_length");
    if (Number(rawLength) > maxBodyBytes)
      throw new RequestInputError(413, "request_body_too_large");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > maxBodyBytes)
      throw new RequestInputError(413, "request_body_too_large");
    chunks.push(bytes);
  }
  if (size === 0) throw new RequestInputError(400, "empty_json_body");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(chunks),
    );
  } catch {
    throw new RequestInputError(400, "invalid_utf8_body");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new RequestInputError(400, "invalid_json_body");
  }
}

/**
 * Internal, single-tenant HTTP transport. It is deliberately loopback-only and
 * is not the hosted/OAuth connector: one process still uses one outbound tenant
 * API key. Public/multi-tenant HTTP remains release-held.
 */
export async function startHttp(
  makeServer: () => Server,
  opts: HttpTransportOptions = {},
): Promise<HttpServer> {
  const port = opts.port ?? Number(process.env.PORT ?? 3030);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
    throw new Error("HTTP transport port must be an integer from 0 to 65535");
  }
  const host = opts.host ?? process.env.POSTWAVE_MCP_HTTP_HOST ?? "127.0.0.1";
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error("HTTP transport is release-held to loopback hosts only");
  }
  const expectedToken = (
    opts.expectedToken ??
    process.env.POSTWAVE_MCP_INBOUND_TOKEN ??
    ""
  ).trim();
  if (expectedToken.length < 16 || expectedToken.length > 512) {
    throw new Error(
      "POSTWAVE_MCP_INBOUND_TOKEN must be a distinct 16-512 character secret in HTTP mode",
    );
  }
  if (expectedToken === (process.env.POSTWAVE_API_KEY ?? "").trim()) {
    throw new Error(
      "POSTWAVE_MCP_INBOUND_TOKEN must be distinct from the outbound POSTWAVE_API_KEY",
    );
  }
  const allowedOrigins = parseAllowedOrigins(opts.allowedOrigins);
  const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  if (
    !Number.isSafeInteger(maxBodyBytes) ||
    maxBodyBytes < 1024 ||
    maxBodyBytes > DEFAULT_MAX_BODY_BYTES
  ) {
    throw new Error(
      `maxBodyBytes must be an integer from 1024 to ${DEFAULT_MAX_BODY_BYTES}`,
    );
  }

  const httpServer = createHttpServer(
    (req: IncomingMessage, res: ServerResponse) => {
      void (async () => {
        let pathname: string;
        try {
          const parsed = new URL(req.url ?? "", "http://127.0.0.1");
          if (parsed.search !== "")
            return jsonError(res, 400, "query_not_allowed");
          pathname = parsed.pathname;
        } catch {
          return jsonError(res, 400, "invalid_request_target");
        }
        if (pathname !== "/mcp" && pathname !== "/healthz") {
          return jsonError(res, 404, "not_found");
        }
        if (!requestOriginAllowed(req, allowedOrigins)) {
          return jsonError(res, 403, "origin_not_allowed");
        }
        if (!tokenMatches(req, expectedToken)) {
          return jsonError(res, 401, "unauthorized");
        }
        if (pathname === "/healthz") {
          if (req.method !== "GET")
            return jsonError(res, 405, "method_not_allowed");
          res.statusCode = 200;
          res.setHeader("cache-control", "private, no-store");
          res.setHeader("content-type", "application/json; charset=utf-8");
          res.end('{"ok":true,"mode":"private_loopback_single_tenant"}');
          return;
        }
        if (req.method !== "POST")
          return jsonError(res, 405, "method_not_allowed");
        try {
          const parsedBody = await readBoundedJSON(req, maxBodyBytes);
          await handleMcpRequest(makeServer, req, res, parsedBody);
        } catch (error: unknown) {
          if (error instanceof RequestInputError) {
            return jsonError(res, error.status, error.message);
          }
          console.error("[postwave-mcp] HTTP request failed");
          if (!res.headersSent) jsonError(res, 500, "internal_error");
        }
      })();
    },
  );
  httpServer.requestTimeout = 10_000;
  httpServer.headersTimeout = 5_000;
  httpServer.keepAliveTimeout = 5_000;
  httpServer.maxHeadersCount = 64;

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    httpServer.once("error", onError);
    httpServer.listen(port, host, () => {
      httpServer.off("error", onError);
      console.error(
        `[postwave-mcp] private HTTP transport listening on ${host}:${port}/mcp`,
      );
      resolve();
    });
  });
  return httpServer;
}

/** Serves one already-authenticated, validated and bounded JSON request. */
export async function handleMcpRequest(
  makeServer: () => Server,
  req: IncomingMessage,
  res: ServerResponse,
  parsedBody?: unknown,
): Promise<void> {
  const server = makeServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, parsedBody);
  } catch {
    console.error("[postwave-mcp] http transport error");
    if (!res.headersSent) jsonError(res, 500, "transport_error");
  }
}
