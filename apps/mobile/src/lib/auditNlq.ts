/**
 * lib/auditNlq.ts — asking the audit log a question in English, and the rules
 * for showing the answer honestly.
 *
 * ── WHY THIS EXISTS ON A PHONE ─────────────────────────────────────────────
 * The audit tab is the richest filter surface in the product: actor, action,
 * resource type, resource id, a time window. Typing that with a thumb is the
 * worst input modality for it, which is precisely the argument for natural
 * language. The server already does the hard part — see below — so mobile's
 * job is transport plus a display that never overstates what happened.
 *
 * ── WHAT THE SERVER ACTUALLY DOES ──────────────────────────────────────────
 * `POST /api/v1/audit/nlq` (apps/api/internal/handlers/audit_nlq.go) hands the
 * question to an LLM whose ONLY job is to emit a `StructuredFilters` struct —
 * actor_type / actor_label / action / resource_type / resource_id / since /
 * limit, validated against an allow-list of field names. Those filters are
 * then executed as a parameterised query against `audit_log` under tenant RLS
 * (`runFilteredAudit`, same WHERE shape as the List handler). The model never
 * writes SQL and never sees a row value at translation time.
 *
 * That is the CloudTrail-Lake pattern, and it is only worth anything if the
 * operator SEES the translation. So `structured_filters` is rendered verbatim
 * next to the results: a hallucinated filter must be visible, not silently
 * executed against fabricated rows. `describeAuditNlqFilters` is that display.
 *
 * ── THE PROJECTION IS NARROWER THAN THE LOG, AND THAT MATTERS ──────────────
 * `runFilteredAudit`'s SELECT projects id/action/resource/actor/user/ip/agent/
 * metadata/at — and NOT `redacted_fields`, `legal_hold`, `metadata_encrypted`
 * or `session_id`. The main feed's row card renders a "redacted" badge from
 * `redactedFields`, so rendering an NLQ result through that card would show NO
 * badge on a row that IS redacted. Absence is not zero: an answer row is
 * therefore drawn with its own compact renderer, and the sheet says in words
 * that provenance badges live on the log row, not here.
 *
 * ── COST IS A REAL CONSTRAINT, NOT A DECORATION ────────────────────────────
 * Every question spends workspace tokens against a per-tenant daily cap
 * (`audit.DailyCostTracker`). So asking is a MUTATION — never a query that a
 * refocus, a window change or a pull-to-refresh could re-run — and the
 * remaining budget is shown before the user commits to spending it.
 *
 * Import-free of react-native/expo/react-query, so every rule above is unit
 * tested under node. Generic over the row type for the same reason
 * `auditGrouping` is: the concrete `AuditRow` lives in hooks/useAudit, which
 * cannot be loaded in a node test.
 */
import { num } from "./format";

/** The translator's output, exactly as `audit.StructuredFilters` serialises. */
export interface AuditNlqFilters {
  actorType: string | null;
  actorLabel: string | null;
  action: string | null;
  resourceType: string | null;
  resourceId: string | null;
  /** RFC3339 lower bound the model chose, clamped server-side to retention. */
  since: string | null;
  limit: number | null;
}

/** The per-tenant daily token budget, from either endpoint's cost block. */
export interface AuditNlqBudget {
  usedTokens: number | null;
  capTokens: number | null;
  remainingTokens: number | null;
  resetAt: string | null;
}

/** Provenance of one answer. Shown so the translation can be audited. */
export interface AuditNlqTrace {
  reasoning: string | null;
  model: string | null;
  cacheHit: boolean;
  retentionDays: number | null;
  totalTokens: number | null;
}

export interface AuditNlqAnswer<Row> {
  /** The question as the server echoed it back. */
  question: string;
  filters: AuditNlqFilters;
  /** Field names the model invented; the server dropped them. */
  invalidFields: string[];
  rows: Row[];
  /**
   * Rows matching the filter across the whole log, which is NOT `rows.length`
   * — the translator's `limit` caps what came back. Null when the server did
   * not say, which renders as an em-dash rather than as a count of zero.
   */
  totalCount: number | null;
  /** The model's one-paragraph reading of the results. May be empty. */
  summary: string;
  trace: AuditNlqTrace;
  budget: AuditNlqBudget;
}

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** A non-empty trimmed string, or null. Empty string is absence, not "". */
function str(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/** A finite number, or null. Never coerces a missing measurement to 0. */
function int(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

export function parseAuditNlqFilters(value: unknown): AuditNlqFilters {
  const raw = obj(value);
  return {
    actorType: str(raw["actor_type"]),
    actorLabel: str(raw["actor_label"]),
    action: str(raw["action"]),
    resourceType: str(raw["resource_type"]),
    resourceId: str(raw["resource_id"]),
    since: str(raw["since"]),
    limit: int(raw["limit"]),
  };
}

export function parseAuditNlqBudget(value: unknown): AuditNlqBudget {
  const raw = obj(value);
  return {
    usedTokens: int(raw["daily_usage_tokens"]),
    capTokens: int(raw["daily_cap_tokens"]),
    remainingTokens: int(raw["remaining_tokens"]),
    resetAt: str(raw["reset_at"]),
  };
}

/**
 * `GET /api/v1/audit/nlq/cost-status` also answers the availability question
 * the POST route can only answer by failing: `nlq_available` is literally
 * `h.NLQLLM != nil` (audit_nlq.go:255). A client therefore never has to guess
 * whether the pipeline is configured, and never has to learn it from a 503
 * after the user has already typed a question.
 *
 * `null` means the field was absent — an older gateway — which is treated as
 * "unknown, let the user try" rather than as a negative claim.
 */
export function parseAuditNlqAvailability(value: unknown): boolean | null {
  const raw = obj(value)["nlq_available"];
  return typeof raw === "boolean" ? raw : null;
}

export function parseAuditNlqAnswer<Row>(value: unknown): AuditNlqAnswer<Row> {
  const raw = obj(value);
  const trace = obj(raw["trace"]);
  const promptTokens = int(trace["prompt_tokens"]);
  const responseTokens = int(trace["response_tokens"]);
  const summaryTokens = int(trace["summary_tokens"]);
  const anyTokens =
    promptTokens !== null || responseTokens !== null || summaryTokens !== null;
  const invalid = raw["invalid_fields"];
  return {
    question: str(raw["query_preview"]) ?? "",
    filters: parseAuditNlqFilters(raw["structured_filters"]),
    invalidFields: Array.isArray(invalid)
      ? invalid.filter((f): f is string => typeof f === "string" && f !== "")
      : [],
    rows: Array.isArray(raw["results"]) ? (raw["results"] as Row[]) : [],
    totalCount: int(raw["total_count"]),
    summary: str(raw["summary"]) ?? "",
    trace: {
      reasoning: str(trace["reasoning"]),
      model: str(trace["model"]),
      cacheHit: trace["cache_hit"] === true,
      retentionDays: int(trace["retention_days"]),
      totalTokens: anyTokens
        ? (promptTokens ?? 0) + (responseTokens ?? 0) + (summaryTokens ?? 0)
        : null,
    },
    budget: parseAuditNlqBudget(raw["cost_status"]),
  };
}

export interface AuditNlqFilterFact {
  label: string;
  value: string;
}

/**
 * The translation, as label/value pairs to render verbatim.
 *
 * Only fields the model actually set appear — a table of seven rows where six
 * say "any" buries the one that narrowed the search. An empty result means the
 * model narrowed nothing, which is itself worth saying out loud (see
 * `AUDIT_NLQ_NO_FILTER_NOTE`).
 */
export function describeAuditNlqFilters(
  filters: AuditNlqFilters,
): AuditNlqFilterFact[] {
  const out: AuditNlqFilterFact[] = [];
  if (filters.actorType)
    out.push({ label: "Actor type", value: filters.actorType });
  if (filters.actorLabel)
    out.push({ label: "Actor", value: filters.actorLabel });
  if (filters.action)
    out.push({ label: "Action contains", value: filters.action });
  if (filters.resourceType) {
    out.push({ label: "Resource type", value: filters.resourceType });
  }
  if (filters.resourceId) {
    out.push({ label: "Resource id contains", value: filters.resourceId });
  }
  if (filters.since) out.push({ label: "Since", value: filters.since });
  if (filters.limit !== null) {
    out.push({ label: "Row limit", value: String(filters.limit) });
  }
  return out;
}

export const AUDIT_NLQ_NO_FILTER_NOTE =
  "The translation narrowed nothing — these are the most recent events in the log, not a filtered answer.";

/**
 * "N of M shown" for an answer, with absence rendered as an em-dash.
 *
 * `total_count` is a COUNT(*) over the same WHERE with no LIMIT, so it is the
 * honest denominator; `rows.length` is capped by the limit the model chose.
 * Reporting only the latter would let a 500-row answer read as 50 events.
 */
export function auditNlqResultSentence(
  shown: number,
  totalCount: number | null,
): string {
  const total = num(totalCount);
  if (shown === 0) {
    return totalCount === 0
      ? "No events matched this translation."
      : `No events returned (${total} matched).`;
  }
  if (totalCount !== null && totalCount <= shown) {
    return `${num(shown)} event${shown === 1 ? "" : "s"} matched.`;
  }
  return `Showing ${num(shown)} of ${total} matching events.`;
}

/**
 * The budget line, or null when the server reports no cap (cap 0 = unlimited
 * in `DailyCostTracker`, so a "0 tokens left" line would be a lie).
 */
export function auditNlqBudgetSentence(
  budget: AuditNlqBudget | null,
): string | null {
  if (!budget || budget.capTokens === null || budget.capTokens <= 0)
    return null;
  const remaining = budget.remainingTokens;
  if (remaining === null) return null;
  if (remaining <= 0) {
    return "This workspace has spent its daily question budget. It resets at midnight UTC.";
  }
  return `${num(remaining)} of ${num(budget.capTokens)} tokens left today.`;
}

/** True when the cap is set AND exhausted — the one state that disables Ask. */
export function auditNlqBudgetExhausted(
  budget: AuditNlqBudget | null,
): boolean {
  if (!budget || budget.capTokens === null || budget.capTokens <= 0)
    return false;
  return budget.remainingTokens !== null && budget.remainingTokens <= 0;
}

/** The handler's own `nlqQueryMaxLen`, so the field stops a doomed round trip. */
export const AUDIT_NLQ_QUERY_MAX_LEN = 2000;

/**
 * Reader-facing copy for every failure the handler can produce, mapped from
 * its own codes (`audit_nlq.go` + `audit.TranslateLLMError`). A raw code in an
 * alert teaches nothing; these say what to do next.
 */
export function auditNlqErrorMessage(
  status: number,
  code: string | undefined,
  message: string | undefined,
): string {
  if (code === "nlq_unavailable" || (status === 503 && !code)) {
    return "Ask is not switched on for this workspace. An administrator has to configure the audit assistant on the API server.";
  }
  if (code === "nlq_llm_auth") {
    return "The audit assistant's model credentials were rejected by the provider. An administrator has to fix them on the API server.";
  }
  if (code === "cost_cap_exceeded") {
    return "This workspace has spent its daily question budget. It resets at midnight UTC.";
  }
  if (code === "nlq_llm_rate_limited" || status === 429) {
    return "The model is rate-limited right now. Wait a moment and ask again.";
  }
  if (code === "nlq_bad_translation") {
    return "The model returned something this server could not read as a filter. Try rephrasing the question.";
  }
  if (code === "nlq_timeout" || status === 504) {
    return "Translating the question took too long. Try a shorter, more specific question.";
  }
  if (code === "empty_query") return "Type a question first.";
  if (code === "query_too_long") {
    return "That question is too long. Keep it under 2,000 characters.";
  }
  if (status === 401 || status === 403) {
    return "You do not have permission to run audit questions in this workspace.";
  }
  if (code === "nlq_llm_error" || status === 502) {
    return "The model could not be reached. Try again in a moment.";
  }
  // A server sentence beats our generic copy; a transport string does not.
  return message && message.length < 200 && /\s/u.test(message)
    ? message
    : "The question could not be answered. Try again in a moment.";
}

/**
 * WHAT THE SURFACE MUST DISCLOSE, beyond the Article-50 sentence.
 *
 * The generic "responses are generated automatically and may be inaccurate"
 * misdescribes this pipeline in BOTH directions: the model does not write the
 * answer (the rows come from a parameterised query under RLS), but it DOES
 * choose the filter, so a wrong filter yields real rows that answer a
 * different question. Naming that is the only way the reader can calibrate.
 */
export const AUDIT_NLQ_PROVENANCE_NOTE =
  "The model only chooses the filter shown above; the events themselves come from your workspace's audit log, queried directly. Check the filter before trusting the answer.";

/**
 * The projection gap, said in words. See the file header — an NLQ result row
 * cannot carry the redaction / legal-hold / encrypted-metadata provenance the
 * log's own cards show, and a missing badge must never read as "clean".
 */
export const AUDIT_NLQ_PROJECTION_NOTE =
  "Redaction, legal-hold and encrypted-metadata badges are not part of this answer's projection — open the event in the log to see them.";

/**
 * ── WHO MAY ASK ────────────────────────────────────────────────────────────
 * Reading the audit log is `audit:read` / role `viewer`. ASKING is not: the
 * mount site wraps `POST /api/v1/audit/nlq` in the same
 * `apikeys.RequireScope(ScopeAuditRead)` as the list
 * (server/audit_operations.go:50), but apps/api authorises TWICE, and
 * routeauth's manifest row for that path reads
 *
 *   POST /api/v1/audit/nlq   session_minimum_role: admin
 *                            api_key_scopes: ["audit:execute_actions"]
 *                            review_status: reviewed
 *
 * The effective floor is the STRICTER of the two, so a viewer or editor
 * holding `audit:read` would be offered an input whose only possible answer is
 * `403 insufficient_role`. That is the exact shape of the saved-view bug
 * `auditSavedViewPolicy` exists to close, so it shares that module's
 * predicate rather than restating it.
 *
 * The GET cost-status row is `viewer`, so budget can be read by anyone who can
 * read the log — but there is no reason to spend a request on a budget the
 * reader may not spend, so the screen only asks once the floor is met.
 */
export interface AuditNlqAccess {
  /** May the client offer the Ask control at all? */
  allowed: boolean;
  /** False while the scope probe is in flight — render neither yet. */
  known: boolean;
  /** Why the control is absent, or null when it is not. */
  notice: string | null;
}

export function auditNlqAccess(input: {
  /** `auditExecuteFloorMet`'s answer: true / false / null while unknown. */
  floorMet: boolean | null;
  mode: "session" | "api_key" | null | undefined;
  /**
   * The server's `nlq_available`, or null when unknown. False hides the
   * control entirely: a permanently-dead AI input on a compliance surface
   * invites "why is this here?" rather than answering it.
   */
  available: boolean | null;
}): AuditNlqAccess {
  if (input.floorMet === null)
    return { allowed: false, known: false, notice: null };
  if (!input.floorMet) {
    return {
      allowed: false,
      known: true,
      notice:
        input.mode === "api_key"
          ? "This API key can read the audit log but not question it — the route policy requires audit:execute_actions."
          : "Asking the audit log a question is limited to workspace owners and admins. You can still filter the log by hand.",
    };
  }
  if (input.available === false) {
    return {
      allowed: false,
      known: true,
      notice:
        "The audit assistant is not configured on this server, so questions cannot be answered. Filtering the log by hand still works.",
    };
  }
  return { allowed: true, known: true, notice: null };
}
