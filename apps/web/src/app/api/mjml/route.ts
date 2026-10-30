// SPDX-License-Identifier: AGPL-3.0-only
//
// Server-side MJML compilation. Runs on Node (mjml is a Node-only library).
// Accepts { mjml: string } and returns { html, errors }.

import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { z } from "zod";

export const runtime = "nodejs";

const MAX_BODY_BYTES = 200 * 1024;
const MJ_INCLUDE_RE = /<\s*mj-include\b/i;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_REQUESTS = 20;
const MAX_RATE_LIMIT_KEYS = 10_000;
const SESSION_COOKIE_RE = /(?:^|;\s*)pw_session=([^;]+)/;

type RateWindow = { startedAt: number; requests: number };
const compileRateWindows = new Map<string, RateWindow>();

const BodySchema = z.object({
  mjml: z
    .string()
    .min(1, "mjml source required")
    .max(MAX_BODY_BYTES, "mjml source too large"),
  options: z
    .object({
      keepComments: z.boolean().optional(),
      minify: z.boolean().optional(),
      validationLevel: z.enum(["strict", "soft", "skip"]).optional(),
    })
    .optional(),
});

interface MjmlError {
  line: number;
  message: string;
  tagName: string;
  formattedMessage: string;
}

class BodyTooLargeError extends Error {
  constructor() {
    super("Request body too large");
    this.name = "BodyTooLargeError";
  }
}

interface MjmlResult {
  html: string;
  errors?: MjmlError[];
}

async function readLimitedBody(req: Request): Promise<string> {
  const contentLength = req.headers.get("content-length");
  const parsedLength = contentLength ? Number(contentLength) : 0;
  if (Number.isFinite(parsedLength) && parsedLength > MAX_BODY_BYTES) {
    throw new BodyTooLargeError();
  }

  if (!req.body) return "";

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;

    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new BodyTooLargeError();
    }
    chunks.push(value);
  }

  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

function jsonResponse(body: unknown, init?: ResponseInit): NextResponse {
  const headers = new Headers(init?.headers);
  headers.set("Cache-Control", "no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  return NextResponse.json(body, {
    ...init,
    headers,
  });
}

function apiBaseURL(): string {
  return (
    process.env.API_URL ||
    process.env.POSTWAVE_API_URL ||
    "http://localhost:8080"
  )
    .trim()
    .replace(/\/+$/, "");
}

interface PresentedCredential {
  /**
   * Budget key of last resort, used only when /auth/me accepts the credential
   * but names no identity. Keyed on the credential VALUE, so it is one
   * allowance per token — never rely on it as the primary key: minting new
   * tokens (a re-login, a rotated API key) would mint new allowances with it.
   */
  fallbackBudgetKey: string;
  headers: Headers;
}

function presentedCredential(req: Request): PresentedCredential | null {
  const authorization = req.headers.get("authorization")?.trim();
  if (authorization) {
    return {
      fallbackBudgetKey: credentialDigest("authorization", authorization),
      headers: new Headers({
        Accept: "application/json",
        Authorization: authorization,
      }),
    };
  }

  const session = SESSION_COOKIE_RE.exec(req.headers.get("cookie") ?? "")?.[1];
  if (!session) return null;
  return {
    fallbackBudgetKey: credentialDigest("pw_session", session),
    headers: new Headers({
      Accept: "application/json",
      Cookie: `pw_session=${session}`,
    }),
  };
}

function credentialDigest(kind: string, value: string): string {
  return createHash("sha256")
    .update(kind)
    .update("\0")
    .update(value)
    .digest("hex");
}

/**
 * The identity /api/v1/auth/me just confirmed, as a budget key. Keying on the
 * caller rather than on the credential is what makes the allowance bounded:
 * signing in N times yields N session cookies but one identity, so the N x 20
 * compiles/minute an attacker could otherwise buy with a handful of logins
 * stays at 20.
 */
async function identityBudgetKey(response: Response): Promise<string | null> {
  try {
    const me = (await response.json()) as unknown;
    if (!me || typeof me !== "object") return null;
    const { tenant_id: tenant, user_id: user } = me as Record<string, unknown>;
    const tenantID = typeof tenant === "string" ? tenant : "";
    const userID = typeof user === "string" ? user : "";
    if (!tenantID && !userID) return null;
    return `identity\0${tenantID}\0${userID}`;
  } catch {
    return null;
  }
}

async function authenticate(req: Request): Promise<string | null> {
  const presented = presentedCredential(req);
  if (!presented) return null;
  try {
    const response = await fetch(`${apiBaseURL()}/api/v1/auth/me`, {
      method: "GET",
      headers: presented.headers,
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }
    return (await identityBudgetKey(response)) ?? presented.fallbackBudgetKey;
  } catch {
    return null;
  }
}

function evictExpiredRateWindows(now: number): void {
  for (const [key, window] of compileRateWindows) {
    if (now - window.startedAt >= RATE_LIMIT_WINDOW_MS) {
      compileRateWindows.delete(key);
    }
  }
}

function consumeCompileAllowance(key: string, now = Date.now()): number | null {
  const current = compileRateWindows.get(key);
  if (current && now - current.startedAt < RATE_LIMIT_WINDOW_MS) {
    if (current.requests >= RATE_LIMIT_REQUESTS) {
      return Math.max(
        1,
        Math.ceil((current.startedAt + RATE_LIMIT_WINDOW_MS - now) / 1_000),
      );
    }
    current.requests += 1;
    return null;
  }
  if (current) compileRateWindows.delete(key);

  if (compileRateWindows.size >= MAX_RATE_LIMIT_KEYS) {
    evictExpiredRateWindows(now);
  }
  while (compileRateWindows.size >= MAX_RATE_LIMIT_KEYS) {
    const oldestKey = compileRateWindows.keys().next().value as
      | string
      | undefined;
    if (!oldestKey) break;
    compileRateWindows.delete(oldestKey);
  }
  compileRateWindows.set(key, { startedAt: now, requests: 1 });
  return null;
}

export async function POST(req: Request) {
  const budgetKey = await authenticate(req);
  if (!budgetKey) {
    return jsonResponse({ error: "Authentication required" }, { status: 401 });
  }
  // MJML compilation lives only in apps/web — there is no API-side handler
  // and therefore no distributed budget behind this one. This allowance is
  // per web instance and per identity: N replicas grant N x the window, which
  // is the ceiling operators should size capacity against.
  const retryAfter = consumeCompileAllowance(budgetKey);
  if (retryAfter !== null) {
    return jsonResponse(
      { error: "Too many compile requests" },
      { status: 429, headers: { "Retry-After": String(retryAfter) } },
    );
  }
  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return jsonResponse(
      { error: "Content-Type must be application/json" },
      { status: 415 },
    );
  }

  let json: unknown;
  try {
    json = JSON.parse(await readLimitedBody(req));
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      return jsonResponse({ error: "Request body too large" }, { status: 413 });
    }
    return jsonResponse({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = BodySchema.safeParse(json);
  if (!parsed.success) {
    return jsonResponse(
      { error: "Validation failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  if (MJ_INCLUDE_RE.test(parsed.data.mjml)) {
    return jsonResponse(
      { error: "mj-include is not supported by this endpoint" },
      { status: 400 },
    );
  }

  if (parsed.data.options?.minify) {
    return jsonResponse(
      { error: "MJML minify is disabled on this endpoint" },
      { status: 400 },
    );
  }

  try {
    const { default: mjml2html } = await import("mjml");
    const result = (await mjml2html(parsed.data.mjml, {
      keepComments: parsed.data.options?.keepComments ?? false,
      // Keep untrusted compilation deterministic and avoid optional minifier
      // CPU amplification. The locked production graph is advisory-clean.
      minify: false,
      validationLevel: parsed.data.options?.validationLevel ?? "soft",
      ignoreIncludes: true,
      useMjmlConfigOptions: false,
    })) as MjmlResult;
    const errors: MjmlError[] = (Array.isArray(result.errors) ? result.errors : []).map((e) => ({
      line: e.line,
      message: e.message,
      tagName: e.tagName,
      formattedMessage: e.formattedMessage,
    }));
    return jsonResponse({ html: result.html, errors });
  } catch {
    return jsonResponse({ error: "MJML compile failed" }, { status: 500 });
  }
}
