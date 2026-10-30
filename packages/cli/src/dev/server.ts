// SPDX-License-Identifier: MIT

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { PostwaveClient } from "@postwave/sdk";
import { SseChannel } from "./sse.js";
import { listEmailFiles, startWatcher } from "./watcher.js";
import { renderEmailFile } from "./render.js";
import { loadPersonas } from "./personas.js";
import { SubjectCopilot } from "./subject.js";

export interface DevServerOptions {
  client: PostwaveClient;
  port: number;
  cwd: string;
  recipientEmail: string;
}

export interface DevServerHandle {
  port: number;
  url: string;
  close(): Promise<void>;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const UI_HTML_PATH = resolve(HERE, "ui", "index.html");
const MAX_JSON_BODY_BYTES = 512 * 1024;
const MAX_EMAIL_PATH_CHARS = 2048;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

export async function startDevServer(opts: DevServerOptions): Promise<DevServerHandle> {
  const sse = new SseChannel();
  const copilot = new SubjectCopilot(opts.client);
  const ui = readUi();

  const stopWatcher = await startWatcher({
    cwd: opts.cwd,
    onEvent: (e) => sse.broadcast("reload", e),
  });

  const server = createServer((req, res) => {
    handle(req, res, opts, sse, copilot, ui).catch((err) => {
      if (res.writableEnded) return;
      const { status, message } = normalizeHttpError(err);
      send(res, status, { error: message });
    });
  });

  await new Promise<void>((resolveP, rejectP) => {
    const onError = (err: Error) => rejectP(err);
    server.once("error", onError);
    server.listen(opts.port, "127.0.0.1", () => {
      server.off("error", onError);
      resolveP();
    });
  });
  const port = (server.address() as { port: number }).port;
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    close: async () => {
      stopWatcher();
      sse.closeAll();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  opts: DevServerOptions,
  sse: SseChannel,
  copilot: SubjectCopilot,
  ui: string,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const method = req.method ?? "GET";

  if (method === "GET" && (path === "/" || path === "/index.html")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(ui);
    return;
  }

  if (method === "GET" && path === "/health") {
    send(res, 200, { ok: true, service: "postwave-dev" });
    return;
  }

  if (method === "GET" && path === "/api/stream") {
    const client = sse.attach(res);
    client.send("hello", { t: Date.now() });
    return;
  }

  if (method === "GET" && path === "/api/files") {
    const files = await listEmailFiles(opts.cwd);
    send(res, 200, { files });
    return;
  }

  if (method === "GET" && path === "/api/personas") {
    send(res, 200, { personas: loadPersonas(opts.cwd) });
    return;
  }

  if (method === "POST" && path === "/api/render") {
    const body = await readJson<{ path?: unknown; file?: unknown; variables?: unknown }>(req);
    try {
      const filePath = resolveRenderableEmailPath(opts.cwd, body.path ?? body.file);
      const result = await renderEmailFile(filePath, readVariables(body.variables));
      const detected = detectPlaceholders(result.html);
      send(res, 200, {
        html: result.html,
        mjml: result.mjml,
        errors: result.errors,
        detected_variables: detected,
      });
    } catch (err) {
      send(res, 200, { error: (err as Error).message });
    }
    return;
  }

  if (method === "POST" && path === "/api/subject") {
    const body = await readJson<{ html: string; candidates: string[] }>(req);
    copilot.schedule({ html: body.html, candidates: body.candidates }, (s) => {
      sse.broadcast("subject", s);
    });
    send(res, 202, copilot.last());
    return;
  }

  if (method === "POST" && path === "/api/send-test") {
    const body = await readJson<{
      path?: unknown;
      file?: unknown;
      subject?: unknown;
      to?: unknown;
      variables?: unknown;
    }>(req);
    const filePath = resolveRenderableEmailPath(opts.cwd, body.path ?? body.file);
    const rendered = await renderEmailFile(filePath, readVariables(body.variables));
    const r = await opts.client.campaigns.sendTest({
      toEmail: readEmail(body.to) ?? opts.recipientEmail,
      subject: readSubject(body.subject),
      bodyHtml: rendered.html,
    });
    send(res, 200, r);
    return;
  }

  send(res, 404, { error: "not found", path });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function readJson<T>(req: IncomingMessage): Promise<T> {
  return new Promise((resolveP, rejectP) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let oversized = false;
    req.on("data", (c: Buffer) => {
      totalBytes += c.byteLength;
      if (totalBytes > MAX_JSON_BODY_BYTES) {
        oversized = true;
        chunks.length = 0;
        return;
      }
      if (!oversized) chunks.push(c);
    });
    req.on("end", () => {
      if (oversized) {
        rejectP(httpError(413, "JSON request body is too large"));
        return;
      }
      try {
        const txt = Buffer.concat(chunks).toString("utf8");
        resolveP(txt ? (JSON.parse(txt) as T) : ({} as T));
      } catch (e) {
        rejectP(httpError(400, `invalid JSON request body: ${(e as Error).message}`));
      }
    });
    req.on("error", rejectP);
  });
}

export function resolveRenderableEmailPath(cwd: string, rawPath: unknown): string {
  if (typeof rawPath !== "string" || !rawPath.trim()) {
    throw httpError(400, "email file path is required");
  }
  if (
    rawPath !== rawPath.trim() ||
    rawPath.length > MAX_EMAIL_PATH_CHARS ||
    CONTROL_RE.test(rawPath)
  ) {
    throw httpError(400, "unsafe email file path");
  }
  const root = realpathSync(resolve(cwd));
  const lexicalCandidate = isAbsolute(rawPath) ? resolve(rawPath) : resolve(root, rawPath);
  let candidate: string;
  try {
    candidate = realpathSync(lexicalCandidate);
  } catch {
    throw httpError(400, "email file not found");
  }
  const rel = relative(root, candidate);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw httpError(400, "email file must be inside the dev server cwd");
  }
  if (!isRenderableEmailPath(candidate)) {
    throw httpError(400, "unsupported email file type");
  }
  return candidate;
}

function isRenderableEmailPath(filePath: string): boolean {
  return /\.email\.[cm]?[jt]sx?$/i.test(filePath) || /\.mjml$/i.test(filePath);
}

function readVariables(raw: unknown): Record<string, unknown> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
}

function readSubject(raw: unknown): string {
  if (typeof raw !== "string") return "Moosewave preview";
  const subject = raw.replace(/\s+/g, " ").trim().slice(0, 180);
  return subject || "Moosewave preview";
}

function readEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

function httpError(status: number, message: string): Error & { statusCode: number } {
  const err = new Error(message) as Error & { statusCode: number };
  err.statusCode = status;
  return err;
}

function normalizeHttpError(err: unknown): { status: number; message: string } {
  const status = (err as { statusCode?: unknown })?.statusCode;
  if (typeof status === "number" && status >= 400 && status < 600) {
    return { status, message: (err as Error).message || "request failed" };
  }
  return { status: 500, message: (err as Error).message || "internal server error" };
}

function detectPlaceholders(html: string): string[] {
  const re = /\{\{\s*\.?([A-Za-z_][A-Za-z0-9_.]*)\s*\}\}/g;
  const found = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) found.add(m[1] as string);
  return Array.from(found).sort();
}

function readUi(): string {
  try {
    return readFileSync(UI_HTML_PATH, "utf8");
  } catch {
    return "<!doctype html><title>Moosewave Dev</title><p>UI bundle missing — rebuild the CLI.</p>";
  }
}

// Used internally by tests that need a server with mocked components.
export type { Server };
