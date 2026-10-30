/**
 * feed-sources-helpers — pure logic behind FeedSourcesSection /
 * FeedSourceFormModal (R1, apps/api/internal/feed_ingest).
 *
 * High-stakes invariants (mirrored from ROADMAP-WRAPPERS.md §R1):
 *   1. `schedule` is "manual" | "daily" | "weekly" — there is NO
 *      monthly cadence; offering one would 400 (`invalid_input`).
 *   2. A FAILED poll is still HTTP 200 with `status:"failed"` +
 *      `error` text — summarizePollResult branches on `status`, never
 *      on the ApiResult error path.
 *   3. Polls only ever mint DRAFT campaigns — copy must never imply
 *      anything sends automatically.
 *   4. Run statuses are rendered, not switched exhaustively — the
 *      wire shape documents "ok" | "no_new_items" | "failed" but the
 *      helpers tolerate unknown values verbatim.
 *
 * Kept free of React/DOM so the node-env vitest suite can exercise
 * the validation + formatting paths directly.
 */

import type {
  FeedPollResult,
  FeedSource,
  FeedSourceCreateInput,
  FeedSourceUpdateInput,
  List,
} from "../../lib/api-client";

/** Mirrors feed_ingest's schedule whitelist — no monthly. */
export const FEED_SCHEDULES = [
  {
    value: "manual",
    label: "Manual",
    hint: "Polls only when you click Poll now.",
  },
  {
    value: "daily",
    label: "Daily",
    hint: "The poller checks the feed every 24 hours.",
  },
  {
    value: "weekly",
    label: "Weekly",
    hint: "The poller checks the feed every 7 days.",
  },
] as const;

export type FeedSchedule = (typeof FEED_SCHEDULES)[number]["value"];

/** Honest placeholder documentation for the subject template input. */
export const SUBJECT_TEMPLATE_HELP =
  "Placeholders: {{title}} = newest item's title, {{name}} = this feed source's name, {{count}} = new items found in the poll.";

export type FeedTargetKind = "all" | "list" | "segment";

/** Form draft as typed by the operator. */
export interface FeedSourceDraft {
  name: string;
  url: string;
  schedule: FeedSchedule;
  subjectTemplate: string;
  targetKind: FeedTargetKind;
  listId: string;
  segmentId: string;
  enabled: boolean;
}

export const EMPTY_FEED_DRAFT: FeedSourceDraft = {
  name: "",
  url: "",
  schedule: "daily",
  subjectTemplate: "{{title}}",
  targetKind: "all",
  listId: "",
  segmentId: "",
  enabled: true,
};

/** Seed the edit form from a stored source row. */
export function sourceToDraft(s: FeedSource): FeedSourceDraft {
  const schedule: FeedSchedule = FEED_SCHEDULES.some(
    (o) => o.value === s.schedule,
  )
    ? s.schedule
    : "manual";
  return {
    name: s.name,
    url: s.url,
    schedule,
    subjectTemplate: s.subject_template,
    targetKind: s.segment_id ? "segment" : s.list_id ? "list" : "all",
    listId: s.list_id ?? "",
    segmentId: s.segment_id ?? "",
    enabled: s.enabled,
  };
}

export interface FeedSourceDraftValidation {
  ok: boolean;
  errors: {
    name?: string;
    url?: string;
    subjectTemplate?: string;
    target?: string;
  };
}

/**
 * Client-side mirror of feed_ingest's create validation so the 400
 * `invalid_input` backstop almost never fires.
 */
export function validateFeedSourceDraft(
  draft: FeedSourceDraft,
): FeedSourceDraftValidation {
  const errors: FeedSourceDraftValidation["errors"] = {};
  if (!draft.name.trim()) {
    errors.name = "Name is required.";
  }
  const url = draft.url.trim();
  if (!url) {
    errors.url = "Feed URL is required.";
  } else if (!/^https?:\/\/\S+$/i.test(url)) {
    errors.url = "Feed URL must start with http:// or https://.";
  }
  if (!draft.subjectTemplate.trim()) {
    errors.subjectTemplate = "Subject template is required.";
  }
  if (draft.targetKind === "list" && !draft.listId) {
    errors.target = "Pick a target list.";
  }
  if (draft.targetKind === "segment" && !draft.segmentId) {
    errors.target = "Pick a target segment.";
  }
  return { ok: Object.keys(errors).length === 0, errors };
}

/**
 * Draft → POST body. `list_id` / `segment_id` are sent as explicit
 * nulls (not omitted) so flipping targeting back to "all subscribers"
 * actually clears the stored columns on edit.
 */
export function draftToInput(draft: FeedSourceDraft): FeedSourceCreateInput &
  FeedSourceUpdateInput {
  return {
    name: draft.name.trim(),
    url: draft.url.trim(),
    schedule: draft.schedule,
    subject_template: draft.subjectTemplate.trim(),
    list_id: draft.targetKind === "list" ? draft.listId : null,
    segment_id: draft.targetKind === "segment" ? draft.segmentId : null,
    enabled: draft.enabled,
  };
}

export interface PollOutcome {
  tone: "good" | "bad" | "neutral";
  headline: string;
  detail?: string;
}

/**
 * Render a manual-poll result verbatim. IMPORTANT: a failed poll is a
 * 200 with status:"failed" + error text — callers reach here with the
 * raw FeedPollResult, never via the ApiResult error path.
 */
export function summarizePollResult(r: FeedPollResult): PollOutcome {
  if (r.status === "failed") {
    return {
      tone: "bad",
      headline: "Poll failed",
      detail: r.error || "The poller reported a failure without details.",
    };
  }
  if (r.new_items > 0) {
    return {
      tone: "good",
      headline: `${r.new_items} new ${r.new_items === 1 ? "item" : "items"} of ${r.items_seen} seen`,
      detail: r.campaign_id
        ? "A draft campaign was created — review and send it yourself; nothing sends automatically."
        : "No draft campaign id was returned by the poller.",
    };
  }
  return {
    tone: "neutral",
    headline: `No new items (${r.items_seen} seen)`,
    detail: "No draft campaign was created.",
  };
}

/** Badge class for a run / poll status chip. Unknown statuses stay plain. */
export function runStatusBadgeClass(status: string | undefined): string {
  const s = (status ?? "").toLowerCase();
  if (s === "failed") return "badge danger";
  if (s === "ok" || s === "succeeded") return "badge accent";
  return "badge";
}

/** Human label for a run / poll status — unknown values pass through. */
export function runStatusLabel(status: string | undefined): string {
  const s = (status ?? "").toLowerCase();
  if (s === "ok" || s === "succeeded") return "Succeeded";
  if (s === "failed") return "Failed";
  if (s === "no_new_items") return "No new items";
  return status ? status.replace(/_/g, " ") : "—";
}

/** "Never" for null/absent/garbage timestamps; localized otherwise. */
export function lastPolledLabel(iso: string | null | undefined): string {
  if (!iso) return "Never";
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return "Never";
  return t.toLocaleString();
}

/** Localized run timestamp; em dash for absent/garbage values. */
export function fmtRunTimestamp(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return "—";
  return t.toLocaleString();
}

/**
 * Unwrap the Listmonk lists envelope ({data:{results}} | {items} |
 * bare array | …). Same defensive shape AudienceSyncFormModal uses.
 */
export function unwrapLists(payload: unknown): List[] {
  if (Array.isArray(payload)) return payload as List[];
  if (payload && typeof payload === "object") {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = payload as any;
    const inner = r.data ?? r;
    const arr = Array.isArray(inner)
      ? inner
      : (inner.results ?? r.items ?? r.results ?? []);
    return Array.isArray(arr) ? (arr as List[]) : [];
  }
  return [];
}
