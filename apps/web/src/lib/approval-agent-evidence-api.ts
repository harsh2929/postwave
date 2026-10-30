// SPDX-License-Identifier: AGPL-3.0-only
//
// Agent-origin evidence for an agent-requested approval: the routine run that
// produced the draft, looked up by approval id
// (GET /api/v1/agent-routines/runs/by-approval/{approvalId} —
// apps/api/internal/agent_routines/handlers.go RunByApproval).
//
// Desktop parity: components/ApprovalDetailSlideover.tsx exactAgentEvidence.
// The payload is re-validated against the approval it was requested for: a
// run whose `approval_id` is not exactly the requested id is a contract
// failure, never evidence. A 404 means "no linked run", which is NOT proof of
// who authored the request — callers render it that way.

import { api, ApiError } from "@/lib/api";

export type AgentEvidenceOutputKind = "campaign" | "sequence";

export interface AgentEvidenceDraftStep {
  position: number;
  delayHours: number;
  subject: string;
  body: string;
}

export type AgentEvidenceDraftPreview =
  | {
      kind: "campaign";
      name: string;
      subject: string;
      previewText: string;
      body: string;
    }
  | { kind: "sequence"; name: string; steps: AgentEvidenceDraftStep[] };

export interface AgentOriginEvidence {
  runId: string;
  routineId: string;
  /** Always equal to the approval id the evidence was requested for. */
  approvalId: string;
  status: string;
  outputKind: AgentEvidenceOutputKind | null;
  startedAt: string;
  reasoning: string | null;
  promptUsed: string | null;
  contextUsed: string | null;
  draftPreview: AgentEvidenceDraftPreview | null;
}

export type AgentEvidenceContractReason =
  | "invalid-envelope"
  | "invalid-field"
  | "approval-mismatch";

export class AgentEvidenceContractError extends Error {
  constructor(readonly reason: AgentEvidenceContractReason) {
    super(
      reason === "approval-mismatch"
        ? "The agent run returned for this approval is linked to a different approval."
        : "The agent-run evidence failed its response contract.",
    );
    this.name = "AgentEvidenceContractError";
  }
}

type JsonRecord = Record<string, unknown>;

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/u;
const UNSAFE_TEXT =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u;
const RUN_KEY_CAP = 32;
const PREVIEW_KEY_CAP = 10;
const STEP_KEY_CAP = 8;
const STEP_CAP = 20;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(reason: AgentEvidenceContractReason = "invalid-field"): never {
  throw new AgentEvidenceContractError(reason);
}

function identifier(value: unknown): string {
  return typeof value === "string" && IDENTIFIER.test(value) ? value : fail();
}

/** Bounded display text; `null` when absent or blank. */
function optionalText(value: unknown, maxCodePoints: number): string | null {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== "string" ||
    value.length > maxCodePoints * 2 ||
    Array.from(value).length > maxCodePoints ||
    UNSAFE_TEXT.test(value)
  ) {
    return fail();
  }
  const normalized = value.replace(/\r\n?/gu, "\n").trim();
  return normalized || null;
}

function requiredInstant(value: unknown): string {
  return typeof value === "string" &&
    value.length <= 64 &&
    Number.isFinite(Date.parse(value))
    ? value
    : fail();
}

function boundedInteger(value: unknown, min: number, max: number): number {
  return Number.isSafeInteger(value) &&
    Number(value) >= min &&
    Number(value) <= max
    ? Number(value)
    : fail();
}

function decodeStep(value: unknown): AgentEvidenceDraftStep {
  if (!isRecord(value) || Object.keys(value).length > STEP_KEY_CAP) fail();
  return {
    position: boundedInteger(value.position, 0, 1_000),
    delayHours: boundedInteger(value.delay_hours, 0, 87_600),
    subject: optionalText(value.subject, 500) ?? "",
    body: optionalText(value.body, 8_001) ?? "",
  };
}

function decodePreview(value: unknown): AgentEvidenceDraftPreview | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value) || Object.keys(value).length > PREVIEW_KEY_CAP) fail();
  const name = optionalText(value.name, 200) ?? "";
  if (value.kind === "campaign") {
    return {
      kind: "campaign",
      name,
      subject: optionalText(value.subject, 500) ?? "",
      previewText: optionalText(value.preview_text, 500) ?? "",
      body: optionalText(value.body, 8_001) ?? "",
    };
  }
  if (value.kind === "sequence") {
    if (!Array.isArray(value.steps) || value.steps.length > STEP_CAP) fail();
    const steps = value.steps.map(decodeStep);
    const positions = new Set(steps.map((step) => step.position));
    if (positions.size !== steps.length) fail();
    return { kind: "sequence", name, steps };
  }
  return fail();
}

/**
 * Decodes one run and proves it belongs to `approvalId`. Exported so the
 * contract can be tested without transport.
 */
export function decodeAgentOriginEvidence(
  value: unknown,
  approvalId: string,
): AgentOriginEvidence {
  if (!isRecord(value) || Object.keys(value).length > RUN_KEY_CAP) {
    fail("invalid-envelope");
  }
  if (value.approval_id !== approvalId) fail("approval-mismatch");
  const status = optionalText(value.status, 32);
  if (!status) fail();
  const outputKind =
    value.output_kind === "campaign" || value.output_kind === "sequence"
      ? value.output_kind
      : value.output_kind === undefined ||
          value.output_kind === null ||
          value.output_kind === ""
        ? null
        : fail();
  return {
    runId: identifier(value.id),
    routineId: identifier(value.routine_id),
    approvalId,
    status,
    outputKind,
    startedAt: requiredInstant(value.started_at),
    reasoning: optionalText(value.reasoning, 8_000),
    promptUsed: optionalText(value.prompt_used, 8_000),
    contextUsed: optionalText(value.context_used, 8_000),
    draftPreview: decodePreview(value.draft_preview),
  };
}

/**
 * Fetches the run linked to an approval. Resolves `null` on 404 ("no linked
 * run"); every other failure rejects so the caller can show it as an
 * unverifiable read rather than an absence.
 */
export async function getAgentOriginEvidence(
  approvalId: string,
  options: { signal?: AbortSignal } = {},
): Promise<AgentOriginEvidence | null> {
  let body: unknown;
  try {
    body = await api.get<unknown>(
      `/api/v1/agent-routines/runs/by-approval/${encodeURIComponent(approvalId)}`,
      {
        cache: "no-store",
        maxAttempts: 1,
        requireOnline: true,
        signal: options.signal,
      },
    );
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
  return decodeAgentOriginEvidence(body, approvalId);
}

/**
 * Model-produced HTML rendered as readable plain text without ever being
 * interpreted as markup: block tags become line breaks, the rest are dropped,
 * and `&amp;` decodes last so escaped entities decode exactly once.
 */
export function htmlToReadableText(html: string): string {
  if (!html) return "";
  return html
    .replace(/<\s*(br|\/p|\/div|\/li|\/h[1-6])\s*\/?>/giu, "\n")
    .replace(/<\s*li[^>]*>/giu, "• ")
    .replace(/<[^>]+>/gu, "")
    .replace(/&nbsp;/giu, " ")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, '"')
    .replace(/&#39;/giu, "'")
    .replace(/&amp;/giu, "&")
    .replace(/\n{3,}/gu, "\n\n")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .trim();
}
