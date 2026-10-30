// SPDX-License-Identifier: AGPL-3.0-only
/**
 * lib/campaign-copilot-api.ts — the campaign-bound half of the Copilot rail
 * (desktop composer/CopilotRail + SubjectLab hand-off parity).
 *
 *   GET  /api/v1/campaigns/{id}                 the SAVED campaign the checks grade
 *   GET  /api/v1/campaigns/{id}/assurance       latest frozen run identity, if any
 *   POST /api/v1/presend/verdict                subject/from/body + campaign identity
 *   GET  /api/v1/feature-flags/subject_lab/resolve
 *   POST /api/v1/campaigns/ab-test              subject test from lab variants
 *   POST /api/v1/campaigns/{parent}/ab/settings bandit allocation for that test
 *
 * THE RAIL GRADES WHAT IS SAVED. The editor may hold unsaved keystrokes; a
 * verdict or an A/B test built from them would describe content the campaign
 * does not have. Every verb here re-reads the campaign from the server first,
 * with a plain read that does not replace the editor's concurrency token.
 *
 * THE VERDICT IS ONLY COMPLETE WHEN FOUR CHECKS RAN. With a campaign identity
 * the server adds a `campaign_assurance` component beside EQ, voice drift and
 * placement. The three base checks are decoded by the shared pasted-draft
 * decoder (lib/presend-draft-api.ts) so both surfaces read the same response
 * the same way; the assurance component is decoded here, and a missing or
 * unavailable one keeps the whole verdict from reading as complete.
 *
 * A BANDIT IS A SETTING, NOT A LABEL. Desktop sends
 * `delivery_settings.ab_test.bandit` with the create call, but the server
 * overwrites the `ab_test` block with its own metadata and seeds the test with
 * `bandit_strategy: "fixed"`. The allocation is only real once the parent's
 * A/B settings say `thompson`, so the bandit hand-off makes that second call
 * and reports separately if it did not land.
 */
import { api } from "@/lib/api";
import { setABSettings } from "@/lib/abtests-api";
import { getLatestCampaignAssurance } from "@/lib/campaign-assurance-api";
import { createCampaignABTest } from "@/lib/campaigns-api";
import { resolveFeatureFlag } from "@/lib/feature-flags-admin-api";
import {
  decodePresendDraftVerdict,
  PresendContractError,
  type PresendDraftVerdict,
} from "@/lib/presend-draft-api";

export interface SavedCampaignForCopilot {
  id: string;
  name: string;
  subject: string;
  fromEmail: string;
  fromName: string;
  replyTo: string;
  previewText: string;
  bodyHtml: string;
  segmentId: string;
  listId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Read the saved campaign. Deliberately NOT campaigns-api `getCampaign`: that
 * one records the response ETag as the editor's If-Match token, and a rail
 * read must never refresh the token for content the editor is not holding.
 */
export async function loadSavedCampaignForCopilot(
  campaignId: string,
  signal?: AbortSignal,
): Promise<SavedCampaignForCopilot> {
  const raw = await api.get<unknown>(
    `/api/v1/campaigns/${encodeURIComponent(campaignId)}`,
    { signal },
  );
  if (!isRecord(raw) || text(raw.id) !== campaignId) {
    throw new Error("The saved campaign could not be read. Nothing was run.");
  }
  const delivery = isRecord(raw.delivery_settings) ? raw.delivery_settings : {};
  return {
    id: campaignId,
    name: text(raw.name).trim(),
    subject: text(raw.subject).trim(),
    fromEmail: text(delivery.from_email).trim(),
    fromName: text(raw.from_name).trim(),
    replyTo: text(raw.reply_to).trim(),
    previewText: text(raw.preview_text).trim(),
    bodyHtml: text(raw.body_html) || text(raw.plain_text),
    segmentId: text(raw.segment_id).trim(),
    listId: text(raw.list_id).trim(),
  };
}

/** Why the saved campaign cannot be graded yet, or null when it can. */
export function verdictBlocker(saved: SavedCampaignForCopilot): string | null {
  if (!saved.subject) return "Save a subject line to run the pre-send check.";
  if (!saved.fromEmail) return "Save a From address to run the pre-send check.";
  if (!saved.bodyHtml.trim()) return "Save a body to run the pre-send check.";
  return null;
}

export type AssuranceStatus =
  | "ok"
  | "warn"
  | "critical"
  | "error"
  | "skipped"
  | "unknown";

export interface CampaignAssuranceComponent {
  status: AssuranceStatus;
  /** False when the server omitted the component it was asked for. */
  received: boolean;
  score?: number;
  message?: string;
}

export interface CampaignPresendVerdict {
  verdict: PresendDraftVerdict["verdict"];
  /** True only when all four checks completed and the server agreed. */
  complete: boolean;
  summary: string;
  computedAt: string;
  base: PresendDraftVerdict;
  assurance: CampaignAssuranceComponent;
  /** What was graded — the saved values, not the editor's. */
  graded: { subject: string; from: string; bodyLength: number };
}

const ASSURANCE_STATUSES = new Set(["ok", "warn", "critical", "error", "skipped"]);
const COMPLETED = new Set(["ok", "warn", "critical"]);

function decodeAssurance(raw: unknown[]): {
  component: CampaignAssuranceComponent;
  rest: unknown[];
} {
  const matches = raw.filter(
    (entry) => isRecord(entry) && entry.name === "campaign_assurance",
  );
  const rest = raw.filter(
    (entry) => !(isRecord(entry) && entry.name === "campaign_assurance"),
  );
  if (matches.length !== 1) {
    return {
      rest,
      component: {
        status: "unknown",
        received: false,
        message:
          matches.length === 0
            ? "No Campaign Assurance result was returned."
            : "Campaign Assurance was reported more than once.",
      },
    };
  }
  const entry = matches[0] as Record<string, unknown>;
  const status = ASSURANCE_STATUSES.has(text(entry.status))
    ? (entry.status as AssuranceStatus)
    : "unknown";
  const score =
    typeof entry.score === "number" && Number.isFinite(entry.score)
      ? entry.score
      : undefined;
  const message = text(entry.error).trim() || text(entry.message).trim();
  return {
    rest,
    component: {
      status,
      received: true,
      ...(score !== undefined ? { score } : {}),
      ...(message ? { message } : {}),
    },
  };
}

export function decodeCampaignPresendVerdict(
  raw: unknown,
  graded: CampaignPresendVerdict["graded"],
): CampaignPresendVerdict {
  if (!isRecord(raw) || !Array.isArray(raw.components)) {
    throw new PresendContractError("missing components");
  }
  const { component, rest } = decodeAssurance(raw.components);
  const base = decodePresendDraftVerdict({ ...raw, components: rest });
  const assuranceDone = COMPLETED.has(component.status);
  return {
    verdict: base.verdict,
    // The base decoder already requires the server's own `complete: true`.
    complete: base.complete && assuranceDone,
    summary: base.summary,
    computedAt: base.computedAt,
    base,
    assurance: component,
    graded,
  };
}

/**
 * Grade the SAVED campaign. The latest frozen Campaign Assurance run supplies
 * the exact revision identity when there is one; otherwise the campaign id
 * alone is sent and the server reports that no frozen run exists, which keeps
 * the verdict incomplete rather than silently dropping the fourth check.
 */
export async function runCampaignPresendVerdict(
  saved: SavedCampaignForCopilot,
  options: { signal?: AbortSignal } = {},
): Promise<CampaignPresendVerdict> {
  const blocker = verdictBlocker(saved);
  if (blocker) throw new Error(blocker);
  let identity: Record<string, string> = { campaign_id: saved.id };
  try {
    const latest = await getLatestCampaignAssurance(saved.id);
    const run = latest?.data?.detail?.run;
    if (run?.content_revision_id && run.source_hash) {
      identity = {
        campaign_id: saved.id,
        content_revision_id: run.content_revision_id,
        source_hash: run.source_hash,
      };
    }
  } catch {
    // No readable run: the campaign-only identity above is the honest request.
  }
  const raw = await api.post<unknown>(
    "/api/v1/presend/verdict",
    {
      subject: saved.subject,
      from: saved.fromEmail,
      html: saved.bodyHtml,
      text: saved.bodyHtml,
      ...identity,
    },
    {
      // Grading persists nothing: no replayable mutation identity.
      idempotencyKey: null,
      ...(options.signal ? { signal: options.signal } : {}),
    },
  );
  return decodeCampaignPresendVerdict(raw, {
    subject: saved.subject,
    from: saved.fromEmail,
    bodyLength: saved.bodyHtml.length,
  });
}

const TRUTHY_FLAG_VALUES = new Set(["true", "on", "1", "yes", "enabled"]);

/**
 * Subject Lab is opt-in per workspace (its variants call is LLM-cost). Read
 * through the server's resolver — the same rule as feature_flags.IsEnabled —
 * never a flag row's `enabled` column.
 */
export async function resolveSubjectLabEnabled(
  signal?: AbortSignal,
): Promise<boolean> {
  const resolution = await resolveFeatureFlag("subject_lab", signal);
  return TRUTHY_FLAG_VALUES.has(resolution.value.trim().toLowerCase());
}

/**
 * Why no subject test can be built from this saved campaign at all, or null.
 * The server refuses an A/B test without an audience, so it is checked here
 * rather than discovered as a 422.
 */
export function campaignTestBlocker(saved: SavedCampaignForCopilot): string | null {
  if (!saved.name) return "Name and save the campaign before starting an A/B test.";
  if (!saved.segmentId && !saved.listId) {
    return "Choose and save this campaign's audience before starting an A/B test.";
  }
  return null;
}

/** Why a subject test cannot be created from these subjects, or null. */
export function subjectTestBlocker(
  saved: SavedCampaignForCopilot,
  subjects: string[],
): string | null {
  const campaignBlocker = campaignTestBlocker(saved);
  if (campaignBlocker) return campaignBlocker;
  const distinct = new Set(subjects.map((subject) => subject.trim()).filter(Boolean));
  if (distinct.size < 2) return "An A/B test needs at least two distinct subjects.";
  if (distinct.size > 8) return "An A/B test supports at most eight subjects.";
  return null;
}

export interface SubjectTestReceipt {
  parentId: string;
  name: string;
  variantCount: number;
  bandit: "not-requested" | "saved" | "failed";
  banditError?: string;
}

/**
 * Create a NEW subject-line A/B test from the saved campaign; the campaign
 * itself is not changed. With `bandit`, the parent's allocation is then set to
 * Thompson sampling on opens with a 10% exploration floor.
 */
export async function createSubjectTestFromCampaign(
  saved: SavedCampaignForCopilot,
  subjects: string[],
  options: { bandit: boolean },
): Promise<SubjectTestReceipt> {
  const blocker = subjectTestBlocker(saved, subjects);
  if (blocker) throw new Error(blocker);
  const variants = Array.from(
    new Set(subjects.map((subject) => subject.trim()).filter(Boolean)),
  );
  const name = `${saved.name} (subject test)`;
  const created = await createCampaignABTest({
    name,
    subject_variants: variants,
    body_html: saved.bodyHtml,
    ...(saved.segmentId
      ? { audience_segment_id: saved.segmentId }
      : { audience_list_id: saved.listId }),
    ...(saved.fromName ? { from_name: saved.fromName } : {}),
    ...(saved.replyTo ? { reply_to: saved.replyTo } : {}),
    ...(saved.previewText ? { preview_text: saved.previewText } : {}),
    ...(saved.fromEmail
      ? { delivery_settings: { from_email: saved.fromEmail } }
      : {}),
  });
  const parentId = text(created?.parent?.id);
  if (!parentId) {
    throw new Error(
      "The A/B test response did not identify the new test. Check Campaigns before retrying so it is not created twice.",
    );
  }
  const receipt: SubjectTestReceipt = {
    parentId,
    name,
    variantCount: Array.isArray(created.children)
      ? created.children.length
      : variants.length,
    bandit: "not-requested",
  };
  if (!options.bandit) return receipt;
  try {
    await setABSettings(parentId, {
      winner_metric: "open_rate",
      evaluation_window_hours: 24,
      winner_recipients_pct: 100,
      sample_pct: 100,
      bandit_strategy: "thompson",
      explore_floor: 0.1,
      recompute_interval_minutes: 30,
    });
    return { ...receipt, bandit: "saved" };
  } catch (error) {
    return {
      ...receipt,
      bandit: "failed",
      banditError:
        error instanceof Error && error.message.trim()
          ? error.message
          : "The bandit setting was not saved.",
    };
  }
}
