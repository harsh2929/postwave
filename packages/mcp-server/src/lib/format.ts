// SPDX-License-Identifier: MIT
import { capResponse } from "./security.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/**
 * MCP `CallToolResult` content blocks. We always emit one text block plus
 * the structured payload — agents that can read structured content
 * (Claude with tools/structuredContent support) get the typed object;
 * everyone else still sees the JSON pretty-printed in the text stream.
 */
export interface ToolResultBlock {
  type: "text";
  text: string;
}

export interface FormattedToolResult extends CallToolResult {
  content: ToolResultBlock[];
}

/**
 * Format an SDK return value as an MCP `CallToolResult`. Caps the response
 * at 5 MB by default; the marker is included in both the text and a flag
 * on the structured payload so agents can detect truncation.
 */
export function formatResult(value: unknown, opts: { maxBytes?: number } = {}): FormattedToolResult {
  const capped = capResponse(value, opts.maxBytes ?? 5_000_000);
  const text =
    typeof capped.data === "string"
      ? capped.data
      : JSON.stringify(capped.data, null, 2);
  return {
    content: [{ type: "text", text }],
    structuredContent: capped.truncated
      ? { __truncated: true, __byte_length: capped.byteLength, value: capped.data }
      : toStructuredContent(value),
  };
}

/** Format a thrown error as an MCP error result. */
export function formatError(err: unknown): FormattedToolResult {
  const message = err instanceof Error ? err.message : String(err);
  const name = err instanceof Error ? err.name : "Error";
  const status = (err as { status?: number })?.status;
  const code = (err as { code?: string })?.code;
  const tool = (err as { tool?: string })?.tool;
  const requestId = (err as { requestId?: string })?.requestId;
  const retryAfterSeconds = (err as { retryAfterSeconds?: number })
    ?.retryAfterSeconds;
  const payloadError = nestedError((err as { payload?: unknown })?.payload);
  const retryable =
    payloadError?.retryable ??
    retryableError(status, code);
  const recommendedAction =
    payloadError?.recommended_action ??
    recommendedActionFor(code);
  const text =
    `${name}: ${message}` + (status ? ` (status ${status})` : "") + (code ? ` [${code}]` : "");
  const structuredError = compactObject({
    name,
    message,
    status,
    code,
    tool,
    request_id: requestId ?? payloadError?.request_id,
    retryable,
    retry_after_seconds:
      retryAfterSeconds ?? payloadError?.retry_after_seconds,
    recommended_action: recommendedAction,
    details: payloadError?.details,
  });
  return {
    content: [{ type: "text", text }],
    structuredContent: { error: structuredError },
    isError: true,
  };
}

function nestedError(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (record.error && typeof record.error === "object" && !Array.isArray(record.error)) {
    return record.error as Record<string, unknown>;
  }
  return record;
}

function retryableError(status: number | undefined, code: string | undefined): boolean {
  if (status === 0 || status === 429 || (status !== undefined && status >= 500)) {
    return true;
  }
  return new Set([
    "network_error",
    "request_timeout",
    "generation_timeout",
    "generator_unavailable",
  ]).has(code ?? "");
}

function recommendedActionFor(code: string | undefined): string | undefined {
  switch (code) {
    case "adaptation_required":
      return "campaign_template_adapt";
    case "template_ineligible":
      return "request_review";
    case "slug_conflict":
      return "choose_a_different_slug";
    case "precondition_failed":
    case "version_conflict":
      return "reload_compare_or_save_as_copy";
    case "quota_exceeded":
    case "rate_limited":
      return "retry_after_reset";
    case "generator_unavailable":
    case "generation_timeout":
    case "request_timeout":
    case "network_error":
      return "retry_when_ready";
    case "permission_denied":
    case "insufficient_scope":
      return "request_access";
    case "invalid_reviewed_design":
    case "validation_failed":
      return "repair_or_regenerate_design";
    default:
      return undefined;
  }
}

function compactObject(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  );
}

function toStructuredContent(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return { value };
}

/**
 * Run `fn` with a hard timeout. Used to enforce 30 s default / 60 s for
 * migration tools — agents must not hang on a stuck call.
 */
export async function withTimeout<T>(fn: () => Promise<T>, ms: number, label: string): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
    fn().then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
