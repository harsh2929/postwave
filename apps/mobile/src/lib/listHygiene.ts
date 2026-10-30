/**
 * listHygiene — pure parsing/policy for the sunset (list-hygiene) surface
 * (desktop anchor: components/subscribers/SunsetPoliciesCard.tsx; server:
 * apps/api/internal/sunset/handlers.go — no release gate on the mount).
 *
 *   GET  /api/v1/sunset/policies              → {items:[Policy]}      admin
 *   POST /api/v1/sunset/policies              → 201 Policy            admin
 *   PUT  /api/v1/sunset/policies/{id}         → Policy                admin
 *   GET  /api/v1/sunset/policies/{id}/executions → {items:[Execution]} viewer
 *
 * RUN-NOW IS DELIBERATELY NOT HERE. POST /sunset/policies/{id}/run is
 * mounted and admin-scoped, but the desktop anchor withholds it on purpose
 * (SunsetPoliciesCard "Draft mode": the legacy endpoint is a synchronous
 * sweep with no reviewed plan, durable progress, cancellation, or receipt —
 * "No subscriber is changed from this desktop surface"). Parity means
 * matching that decision, not out-shipping it from a phone: definitions and
 * evidence travel, execution does not. For the same reason both the create
 * POST and the update PUT send `enabled: false` — new and edited
 * definitions stay paused, exactly as desktop's draftToInput does.
 *
 * The JSON is camelCase (`inactiveDays`, `excludedTags`) — the sunset
 * package, like segments, predates the snake_case house style.
 *
 * ROLE SHAPE OF THE WHOLE SURFACE: listing policies is ADMIN
 * (session_minimum_role=admin in the routeauth manifest). Executions are
 * viewer-readable, but they are only addressable BY policy id, which a
 * non-admin cannot enumerate — so the mobile surface is admin-only and the
 * entry point is withheld (not disabled) below admin.
 *
 * Validation mirrors the server's validatePolicy (handlers.go:343): name
 * required, inactiveDays in [30, 730], action one of suppress|tag|winback.
 */
import { transitionLabel } from "./direction";

export type SunsetAction = "suppress" | "tag" | "winback";

export const SUNSET_ACTION_OPTIONS: readonly {
  value: SunsetAction;
  label: string;
  hint: string;
}[] = [
  {
    value: "suppress",
    label: "Suppress",
    hint: "Stop mailing matches. They stay on their lists but become unmailable.",
  },
  {
    value: "tag",
    label: "Tag",
    hint: "Mark matches with a sunset tag; nothing else changes.",
  },
  {
    value: "winback",
    label: "Win-back",
    hint: "Queue matches for a re-engagement send before any suppression.",
  },
];

export const SUNSET_INACTIVE_DAYS_MIN = 30;
export const SUNSET_INACTIVE_DAYS_MAX = 730;

export interface SunsetPolicy {
  id: string;
  name: string;
  inactiveDays: number;
  action: SunsetAction | string;
  enabled: boolean;
  excludedTags: string[];
  updatedAt: string;
}

export interface SunsetExecution {
  id: string;
  subscriberId: string;
  actionTaken: string;
  reason: string;
  executedAt: string;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function items(res: unknown): Record<string, unknown>[] {
  const rows = (res as { items?: unknown[] } | null | undefined)?.items;
  if (!Array.isArray(rows)) return [];
  return rows.filter(
    (r): r is Record<string, unknown> => !!r && typeof r === "object",
  );
}

export function parseSunsetPolicy(raw: unknown): SunsetPolicy | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = r.id == null ? "" : String(r.id);
  if (!id) return null;
  return {
    id,
    name: str(r.name) || `Policy ${id}`,
    inactiveDays: num(r.inactiveDays),
    action: str(r.action),
    enabled: r.enabled === true,
    excludedTags: Array.isArray(r.excludedTags)
      ? r.excludedTags.filter((t): t is string => typeof t === "string")
      : [],
    updatedAt: str(r.updatedAt),
  };
}

export function parseSunsetPolicies(res: unknown): SunsetPolicy[] {
  const out: SunsetPolicy[] = [];
  for (const raw of items(res)) {
    const parsed = parseSunsetPolicy(raw);
    if (parsed) out.push(parsed);
  }
  return out;
}

export function parseSunsetExecutions(res: unknown): SunsetExecution[] {
  return items(res)
    .filter((r) => r.id != null)
    .map((r) => ({
      id: String(r.id),
      subscriberId: str(r.subscriberId),
      actionTaken: str(r.actionTaken),
      reason: str(r.reason),
      executedAt: str(r.executedAt),
    }));
}

export interface SunsetPolicyDraft {
  name: string;
  inactiveDays: number;
  action: SunsetAction;
  excludedTags: string[];
}

/** Mirrors the server's validatePolicy so the form fails at the field, not
 * with a round-tripped 400. Returns null when the draft would be accepted. */
export function sunsetPolicyProblem(draft: SunsetPolicyDraft): string | null {
  if (!draft.name.trim()) return "A policy needs a name.";
  if (
    !Number.isInteger(draft.inactiveDays) ||
    draft.inactiveDays < SUNSET_INACTIVE_DAYS_MIN ||
    draft.inactiveDays > SUNSET_INACTIVE_DAYS_MAX
  ) {
    return `Inactive days must be between ${SUNSET_INACTIVE_DAYS_MIN} and ${SUNSET_INACTIVE_DAYS_MAX}.`;
  }
  if (!SUNSET_ACTION_OPTIONS.some((o) => o.value === draft.action)) {
    return "Pick what happens to matches: suppress, tag, or win-back.";
  }
  return null;
}

/**
 * The body both the create POST and the update PUT send. `enabled` is
 * hard-false — new and edited definitions stay paused until execution is
 * production-safe, mirroring desktop's draftToInput (see the file header).
 */
export function sunsetPolicyBody(draft: SunsetPolicyDraft): {
  name: string;
  inactiveDays: number;
  action: SunsetAction;
  enabled: false;
  excludedTags: string[];
} {
  return {
    name: draft.name.trim(),
    inactiveDays: draft.inactiveDays,
    action: draft.action,
    enabled: false,
    excludedTags: draft.excludedTags,
  };
}

/** Comma-separated tag input → trimmed, deduped list (desktop parseExcludedTags). */
export function parseExcludedTagsInput(input: string): string[] {
  const out: string[] = [];
  for (const part of input.split(",")) {
    const tag = part.trim();
    if (tag && !out.includes(tag)) out.push(tag);
  }
  return out;
}

/** One row line: what the policy matches and what it would do about it. */
export function sunsetCriteriaLine(policy: {
  inactiveDays: number;
  action: SunsetAction | string;
  excludedTags: string[];
}): string {
  const action =
    SUNSET_ACTION_OPTIONS.find((o) => o.value === policy.action)?.label ??
    policy.action;
  const excl =
    policy.excludedTags.length > 0
      ? ` · excludes ${policy.excludedTags.join(", ")}`
      : "";
  // `transitionLabel`, not a literal arrow: this line says a MATCH becomes an
  // ACTION, and the connector has to point the way the sentence reads once the
  // layout mirrors.
  return `${transitionLabel(
    `Inactive ≥ ${policy.inactiveDays} days`,
    action,
  )}${excl}`;
}

export const SUNSET_ADMIN_CAPTION =
  "Sunset policies decide who stops being mailed. Managing them needs the admin role.";

/**
 * The draft-mode banner — desktop's SunsetExecutionGate copy, condensed.
 * Rendered verbatim wherever policies are shown so nobody mistakes a saved
 * definition for a running automation.
 */
export const SUNSET_DRAFT_MODE_NOTE =
  "Sweeps are unavailable in this release. Policies you save stay paused until execution ships with an impact preview, progress, cancellation, and a receipt — no subscriber is changed from this screen.";
