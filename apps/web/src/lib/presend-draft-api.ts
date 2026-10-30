// SPDX-License-Identifier: AGPL-3.0-only
/**
 * lib/presend-draft-api.ts — the advisory pre-send verdict for a pasted draft.
 *
 *   POST /api/v1/presend/verdict   (write_campaigns)
 *   body { subject, from, html, text }
 *
 * The draft travels in the body because an empty body is not "no input" to
 * this endpoint: the server grades an empty subject and an unresolvable
 * sender and answers with a real-sounding verdict sentence.
 *
 * An HTTP 200 is not evidence that all three checks ran. The decoder below
 * (desktop PresendCheckPanel parity) re-derives completeness from the exact
 * component set, so a contradictory or partial response can never read as a
 * clean pass.
 */
import { api } from "@/lib/api";

export const PRESEND_COMPONENTS = [
  "eq_score",
  "voice_drift",
  "placement",
] as const;

export type PresendComponentName = (typeof PRESEND_COMPONENTS)[number];
export type PresendComponentStatus =
  | "ok"
  | "warn"
  | "critical"
  | "error"
  | "skipped"
  | "unknown";
export type PresendDraftVerdictValue = "ok" | "warn" | "critical" | "incomplete";

export interface PresendDraftComponent {
  name: PresendComponentName;
  status: PresendComponentStatus;
  /** False when the server omitted this expected check entirely. */
  received: boolean;
  score?: number;
  message?: string;
  error?: string;
}

export interface PresendDraftVerdict {
  verdict: PresendDraftVerdictValue;
  /** True only when every expected check completed and the server agreed. */
  complete: boolean;
  summary: string;
  components: PresendDraftComponent[];
  computedAt: string;
}

export interface PresendDraftInput {
  subject: string;
  from: string;
  body: string;
}

export class PresendContractError extends Error {
  constructor(reason: string) {
    super(
      `The pre-send service returned an incomplete or invalid response (${reason}). No current verdict is available.`,
    );
    this.name = "PresendContractError";
  }
}

const STATUS_VALUES = new Set(["ok", "warn", "critical", "error", "skipped"]);
const VERDICT_VALUES = new Set(["ok", "warn", "critical", "incomplete"]);
const COMPLETED = new Set(["ok", "warn", "critical"]);
const MAX_TEXT = 4_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isComponentName(value: string): value is PresendComponentName {
  return (PRESEND_COMPONENTS as readonly string[]).includes(value);
}

function optionalDetail(
  row: Record<string, unknown>,
  key: "message" | "error",
): string | undefined | null {
  if (!(key in row) || row[key] === undefined) return undefined;
  const value = row[key];
  if (typeof value !== "string" || value.length > MAX_TEXT) return null;
  return value.trim() || undefined;
}

function validScore(name: PresendComponentName, score: number): boolean {
  if (!Number.isFinite(score)) return false;
  return name === "placement"
    ? score >= 0 && score <= 1
    : score >= 0 && score <= 100;
}

export function decodePresendDraftVerdict(raw: unknown): PresendDraftVerdict {
  if (!isRecord(raw)) throw new PresendContractError("not an object");
  if (typeof raw.verdict !== "string" || !VERDICT_VALUES.has(raw.verdict)) {
    throw new PresendContractError("unsupported verdict");
  }
  if (
    typeof raw.summary !== "string" ||
    !raw.summary.trim() ||
    raw.summary.length > MAX_TEXT
  ) {
    throw new PresendContractError("missing summary");
  }
  const computed =
    typeof raw.computed_at === "string" ? Date.parse(raw.computed_at) : NaN;
  if (!Number.isFinite(computed)) {
    throw new PresendContractError("invalid computed_at");
  }
  if ("complete" in raw && typeof raw.complete !== "boolean") {
    throw new PresendContractError("complete is not a boolean");
  }
  if (!Array.isArray(raw.components)) {
    throw new PresendContractError("missing components");
  }

  const decoded = new Map<PresendComponentName, PresendDraftComponent>();
  let mismatch = false;
  for (const candidate of raw.components) {
    if (!isRecord(candidate) || typeof candidate.name !== "string") {
      throw new PresendContractError("malformed component");
    }
    if (!isComponentName(candidate.name) || decoded.has(candidate.name)) {
      // Unknown extras (e.g. campaign_assurance on a campaign-bound call) and
      // duplicates are not shown, but they forfeit a "complete" claim.
      mismatch = true;
      continue;
    }
    const name = candidate.name;
    if (typeof candidate.status !== "string") {
      throw new PresendContractError(`${name} status`);
    }
    const message = optionalDetail(candidate, "message");
    const error = optionalDetail(candidate, "error");
    if (message === null || error === null) {
      throw new PresendContractError(`${name} detail`);
    }
    let score: number | undefined;
    if ("score" in candidate && candidate.score !== undefined) {
      if (typeof candidate.score !== "number" || !validScore(name, candidate.score)) {
        throw new PresendContractError(`${name} score`);
      }
      score = candidate.score;
    }
    const status: PresendComponentStatus = STATUS_VALUES.has(candidate.status)
      ? (candidate.status as PresendComponentStatus)
      : "unknown";
    if (status === "unknown") mismatch = true;
    if (COMPLETED.has(status) && score === undefined) {
      throw new PresendContractError(`${name} completed without a score`);
    }
    if ((status === "error" || status === "skipped") && score !== undefined) {
      throw new PresendContractError(`${name} unavailable result had a score`);
    }
    decoded.set(name, { name, status, received: true, score, message, error });
  }

  const components = PRESEND_COMPONENTS.map(
    (name): PresendDraftComponent => {
      const found = decoded.get(name);
      if (found) return found;
      // "unknown" is not a completed status, so `allCompleted` below already
      // withholds a complete claim for an omitted check.
      return {
        name,
        status: "unknown",
        received: false,
        message: "No result was returned for this check.",
      };
    },
  );
  const allCompleted = components.every((component) =>
    COMPLETED.has(component.status),
  );
  const reported = typeof raw.complete === "boolean" ? raw.complete : allCompleted;
  const verdict = raw.verdict as PresendDraftVerdictValue;
  return {
    verdict,
    complete: reported && allCompleted && !mismatch && verdict !== "incomplete",
    summary: raw.summary.trim(),
    components,
    computedAt: new Date(computed).toISOString(),
  };
}

/**
 * Grade a draft. The pasted body goes in as both `html` and `text`, as on
 * desktop. Grading persists nothing, so no idempotency identity is minted and
 * the request is never queued offline.
 */
export async function runPresendDraftVerdict(
  input: PresendDraftInput,
  options: { signal?: AbortSignal } = {},
): Promise<PresendDraftVerdict> {
  const raw = await api.post<unknown>(
    "/api/v1/presend/verdict",
    {
      subject: input.subject.trim(),
      from: input.from.trim(),
      html: input.body,
      text: input.body,
    },
    {
      idempotencyKey: null,
      ...(options.signal ? { signal: options.signal } : {}),
    },
  );
  return decodePresendDraftVerdict(raw);
}
