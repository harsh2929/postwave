/**
 * lib/list-hygiene-api.ts — spam-trap guard, soft-bounce recovery, sunset
 * policies, send windows and frequency caps.
 *
 * Eight paths were reached by desktop and by no web file. Together they are
 * the machinery that decides who STOPS receiving mail, and when.
 *
 * `automatic_reactivation_active: false` is the field that changes the meaning
 * of every other number on the soft-bounce endpoint. `eligible_now: 40` with
 * automation OFF means forty people are sitting recoverable and nothing will
 * recover them; with automation ON it means forty are about to be. Same
 * number, opposite implication for whether anybody needs to act.
 *
 * `send-window` answers `{"policy": null}` when no window is configured, which
 * means sending is unrestricted — the permissive default, and worth saying out
 * loud rather than rendering an empty panel.
 *
 * COVERAGE: this module wires 5 of them:
 *   /api/v1/send-window            (GET, and now PUT + DELETE)
 *   /api/v1/sending/frequency-caps
 *   /api/v1/soft-bounce-recovery/stats
 *   /api/v1/spam-trap-guard/stats
 *   /api/v1/sunset/policies
 * The remaining 3 are not called from web. The sentence above
 * describes the gap that was found, not the part that was closed.
 *
 * SEND-WINDOW EDITING (parity row campaigns-33). GET was read-only here and
 * the policy could be seen from web but never changed; desktop has had the
 * editor since SendWindowPolicyModal. PUT and DELETE are ScopeAdmin
 * server-side — a stricter gate than the read — so the caller must gate on
 * owner/admin, not merely on write access.
 *
 * THE WEEKDAY BITMAP IS GO's `time.Weekday` NUMBERING: bit `1<<0` is SUNDAY
 * through `1<<6` Saturday, and the server default 126 is Mon–Sat. Sending an
 * ISO 1..7 day index instead would silently shift every window by one day,
 * which is why the helpers below are the only place the bit maths happens.
 */
import { api } from "@/lib/api";

export interface SpamTrapStats {
  blocklisted_count: number;
  eligible_now: number;
  hits_last_30_days: number;
  observed_at?: string;
}

export interface SoftBounceStats {
  /** When false, nothing acts on `eligible_now`. */
  automatic_reactivation_active: boolean;
  disabled_count: number;
  eligible_now: number;
  eligible_suppressions_now: number;
  recovery_window_days: number;
}

/** Enforcement tiers the server accepts on PUT /api/v1/send-window. */
export const SEND_WINDOW_ENFORCEMENTS = [
  {
    value: "warn",
    label: "Warn",
    hint: "Sends outside the window are flagged but go out.",
  },
  {
    value: "block",
    label: "Block",
    hint: "Sends outside the window are rejected.",
  },
  {
    value: "off",
    label: "Off",
    hint: "The window is stored but nothing enforces it.",
  },
] as const;

export type SendWindowEnforcement =
  (typeof SEND_WINDOW_ENFORCEMENTS)[number]["value"];

export interface SendWindowPolicy {
  /** Local wall-clock "HH:MM"; the server formats the time columns this way. */
  start_local: string;
  end_local: string;
  /** IANA name. */
  timezone: string;
  /** Go time.Weekday bits: 1<<0 = Sunday … 1<<6 = Saturday. */
  weekday_bitmap: number;
  /** The server's own expansion of the bitmap ("Mon", "Tue", …). */
  weekdays: string[];
  enforcement: string;
  created_at?: string;
  updated_at?: string;
}

export interface SendWindow {
  /** Null means no window — sending is unrestricted. */
  policy: SendWindowPolicy | null;
}

export interface SendWindowPolicyInput {
  start_local: string;
  end_local: string;
  timezone: string;
  weekday_bitmap: number;
  enforcement: SendWindowEnforcement;
}

/** Go time.Weekday order — index IS the bit position. Do not reorder. */
export const WEEKDAY_LABELS = [
  "Sun",
  "Mon",
  "Tue",
  "Wed",
  "Thu",
  "Fri",
  "Sat",
] as const;

/** The server's default when a PUT omits the bitmap: Monday through Saturday. */
export const DEFAULT_WEEKDAY_BITMAP = 126;

export function bitmapHasDay(bitmap: number, day: number): boolean {
  if (day < 0 || day > 6) return false;
  return (bitmap & (1 << day)) !== 0;
}

export function toggleWeekday(bitmap: number, day: number): number {
  if (day < 0 || day > 6) return bitmap;
  return bitmap ^ (1 << day);
}

/** "Mon, Tue, Wed"; "No days" when the bitmap is empty. */
export function weekdaysLabel(bitmap: number): string {
  const days = WEEKDAY_LABELS.filter((_, index) => bitmapHasDay(bitmap, index));
  return days.length > 0 ? days.join(", ") : "No days";
}

/**
 * The server's PUT validation, mirrored so the form can say what is wrong
 * before spending a round trip. Returns null when the draft is submittable.
 *
 * This never REPLACES the server check — a 422 still renders its own sentence.
 */
export function validateSendWindowDraft(draft: {
  start_local: string;
  end_local: string;
  weekday_bitmap: number;
}): string | null {
  const hhmm = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (!hhmm.test(draft.start_local)) return "Start time must be HH:MM.";
  if (!hhmm.test(draft.end_local)) return "End time must be HH:MM.";
  // String compare is safe for zero-padded HH:MM and matches the server, which
  // rejects any end that is not strictly after the start.
  if (draft.end_local <= draft.start_local) {
    return "End time must be after start time.";
  }
  if (draft.weekday_bitmap <= 0 || draft.weekday_bitmap > 127) {
    return "Pick at least one weekday.";
  }
  return null;
}

function num(v: unknown): number {
  return Number.isFinite(v) ? Number(v) : 0;
}
function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

export async function getSpamTrapStats(): Promise<SpamTrapStats> {
  const res = await api.get<SpamTrapStats>("/api/v1/spam-trap-guard/stats");
  return {
    blocklisted_count: num(res?.blocklisted_count),
    eligible_now: num(res?.eligible_now),
    hits_last_30_days: num(res?.hits_last_30_days),
    observed_at: res?.observed_at,
  };
}

export async function getSoftBounceStats(): Promise<SoftBounceStats> {
  const res = await api.get<SoftBounceStats>(
    "/api/v1/soft-bounce-recovery/stats",
  );
  return {
    automatic_reactivation_active: res?.automatic_reactivation_active === true,
    disabled_count: num(res?.disabled_count),
    eligible_now: num(res?.eligible_now),
    eligible_suppressions_now: num(res?.eligible_suppressions_now),
    recovery_window_days: num(res?.recovery_window_days),
  };
}

/**
 * GET /api/v1/sunset/policies (ScopeAdmin). Rows that do not carry an id and a
 * name are dropped rather than rendered as editable policies nobody can
 * address; see the sunset section at the end of this file for the shape.
 */
export async function listSunsetPolicies(): Promise<SunsetPolicy[]> {
  const res = await api.get<{ items?: unknown }>("/api/v1/sunset/policies");
  return asArray(res?.items)
    .map(parseSunsetPolicy)
    .filter((policy): policy is SunsetPolicy => policy !== null);
}

export async function listFrequencyCaps(): Promise<unknown[]> {
  const res = await api.get<{ rules?: unknown }>(
    "/api/v1/sending/frequency-caps",
  );
  return asArray(res?.rules);
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function parseSendWindowPolicy(raw: unknown): SendWindowPolicy | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  const start = str(row.start_local);
  const end = str(row.end_local);
  // A row with no window is not a policy. Returning a half-parsed object here
  // would render as "a send window is configured" over nothing.
  if (!start || !end) return null;
  return {
    start_local: start,
    end_local: end,
    timezone: str(row.timezone) || "UTC",
    weekday_bitmap: num(row.weekday_bitmap),
    weekdays: Array.isArray(row.weekdays)
      ? row.weekdays.filter((d): d is string => typeof d === "string")
      : [],
    enforcement: str(row.enforcement),
    ...(str(row.created_at) ? { created_at: str(row.created_at) } : {}),
    ...(str(row.updated_at) ? { updated_at: str(row.updated_at) } : {}),
  };
}

export async function getSendWindow(): Promise<SendWindow> {
  const res = await api.get<{ policy?: unknown }>("/api/v1/send-window");
  return { policy: parseSendWindowPolicy(res?.policy) };
}

/**
 * Upsert the tenant-wide send window (ScopeAdmin server-side).
 *
 * Unlike GET, the response is the bare policy, NOT `{policy: …}`.
 */
export async function putSendWindow(
  input: SendWindowPolicyInput,
): Promise<SendWindowPolicy | null> {
  const res = await api.put<unknown>("/api/v1/send-window", {
    start_local: input.start_local,
    end_local: input.end_local,
    timezone: input.timezone,
    weekday_bitmap: input.weekday_bitmap,
    enforcement: input.enforcement,
  });
  return parseSendWindowPolicy(res);
}

/**
 * Remove the policy entirely (ScopeAdmin, 204).
 *
 * Removing is NOT the same as setting enforcement to "off": "off" keeps the
 * declared hours on the record for later, this deletes them.
 */
export async function deleteSendWindow(): Promise<void> {
  await api.delete<unknown>("/api/v1/send-window");
}

/* ------------------------------------------------------------------ *
 * Sunset policies (parity row audience-43).
 *
 * Web listed the policies and could do nothing else; desktop's
 * SunsetPoliciesCard has had create / edit / delete, per-policy execution
 * history and the re-engagement template preview.
 *
 * THIS API SERIALIZES camelCase (`inactiveDays`, `excludedTags`), not the
 * snake_case the rest of this file reads. Sending `inactive_days` is silently
 * ignored by Go's decoder and then fails validation as "0 days".
 *
 * EVERY SAVE IS PAUSED (`enabled: false`). Desktop withholds execution — the
 * synchronous `/run` endpoint has no reviewed plan, progress, cancellation or
 * receipt — so definitions are stored paused and nothing here calls `/run`.
 * PUT is a full replace, so editing a legacy-enabled row also pauses it.
 *
 * Policy CRUD is ScopeAdmin; history and preview are ScopeReadReports.
 * ------------------------------------------------------------------ */

export const SUNSET_ACTIONS = ["suppress", "tag", "winback"] as const;
export type SunsetAction = (typeof SUNSET_ACTIONS)[number];

export const SUNSET_ACTION_LABELS: Record<SunsetAction, string> = {
  suppress: "Suppress (stop all sends)",
  tag: "Tag for review",
  winback: "Queue win-back email",
};

/** Server-enforced bounds (sunset handlers validate 30..730). */
export const SUNSET_INACTIVE_DAYS_MIN = 30;
export const SUNSET_INACTIVE_DAYS_MAX = 730;

/** History rows requested per policy (the server clamps at 500). */
export const SUNSET_EXECUTION_LIMIT = 50;

export interface SunsetPolicy {
  id: string;
  name: string;
  inactiveDays: number;
  /** suppress | tag | winback — kept as the server's string. */
  action: string;
  enabled: boolean;
  excludedTags: string[];
  createdAt?: string;
  updatedAt?: string;
}

export interface SunsetPolicyInput {
  name: string;
  inactiveDays: number;
  action: SunsetAction;
  /** Always false: execution is withheld, so every definition saves paused. */
  enabled: false;
  excludedTags: string[];
}

export interface SunsetExecution {
  id: string;
  subscriberId: string;
  /** suppress | tag | winback | skipped */
  actionTaken: string;
  reason: string;
  executedAt: string;
}

/**
 * Brand fields for the re-engagement preview. The Go struct has NO json tags,
 * so its field names cross the wire verbatim — hence the PascalCase.
 */
export interface SunsetBrandSnapshot {
  WorkspaceName?: string;
  SenderName?: string;
  ProductName?: string;
  Tone?: SunsetTone;
  HomepageURL?: string;
  UnsubscribeURL?: string;
}

export const SUNSET_TONES = ["casual", "formal", "professional"] as const;
export type SunsetTone = (typeof SUNSET_TONES)[number];

export const SUNSET_TEMPLATE_VARIANTS = [
  { value: "soft", label: "Soft (we miss you)" },
  { value: "direct", label: "Direct (still want these?)" },
  { value: "last_chance", label: "Last chance (final notice)" },
] as const;
export type SunsetTemplateVariant =
  (typeof SUNSET_TEMPLATE_VARIANTS)[number]["value"];

export interface SunsetReengagementTemplate {
  subject: string;
  preheader: string;
  bodyText: string;
  /** Rendered as source text only — never injected into the page. */
  bodyHtml: string;
  primaryCta: string;
  candidateCount: number;
  variant: string;
}

export function parseSunsetPolicy(raw: unknown): SunsetPolicy | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  const id = str(row.id);
  const name = str(row.name);
  if (!id || !name) return null;
  return {
    id,
    name,
    inactiveDays: num(row.inactiveDays),
    action: str(row.action),
    enabled: row.enabled === true,
    excludedTags: Array.isArray(row.excludedTags)
      ? row.excludedTags.filter((t): t is string => typeof t === "string")
      : [],
    ...(str(row.createdAt) ? { createdAt: str(row.createdAt) } : {}),
    ...(str(row.updatedAt) ? { updatedAt: str(row.updatedAt) } : {}),
  };
}

function parseSunsetExecution(raw: unknown): SunsetExecution | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  const id = str(row.id);
  if (!id) return null;
  return {
    id,
    subscriberId: str(row.subscriberId),
    actionTaken: str(row.actionTaken),
    reason: str(row.reason),
    executedAt: str(row.executedAt),
  };
}

/** Comma-separated tag input → trimmed, de-duplicated list. */
export function parseExcludedTags(input: string): string[] {
  const out: string[] = [];
  for (const part of input.split(",")) {
    const tag = part.trim();
    if (tag && !out.includes(tag)) out.push(tag);
  }
  return out;
}

/**
 * The server's policy validation, mirrored so the form can name the field
 * before a round trip. Empty object = submittable. A 422 still renders the
 * server's own sentence.
 */
export function validateSunsetPolicyInput(input: {
  name: string;
  inactiveDays: number;
  action: string;
}): Partial<Record<"name" | "inactiveDays" | "action", string>> {
  const errors: Partial<Record<"name" | "inactiveDays" | "action", string>> =
    {};
  if (!input.name.trim()) errors.name = "Name is required.";
  if (
    !Number.isInteger(input.inactiveDays) ||
    input.inactiveDays < SUNSET_INACTIVE_DAYS_MIN ||
    input.inactiveDays > SUNSET_INACTIVE_DAYS_MAX
  ) {
    errors.inactiveDays = `Inactive days must be a whole number between ${SUNSET_INACTIVE_DAYS_MIN} and ${SUNSET_INACTIVE_DAYS_MAX}.`;
  }
  if (!(SUNSET_ACTIONS as readonly string[]).includes(input.action)) {
    errors.action = "Pick a sunset action.";
  }
  return errors;
}

/** "Inactive ≥ 180 days → Suppress (stop all sends) · excludes vip". */
export function describeSunsetCriteria(policy: SunsetPolicy): string {
  const label =
    SUNSET_ACTION_LABELS[policy.action as SunsetAction] ?? policy.action;
  const excluded =
    policy.excludedTags.length > 0
      ? ` · excludes ${policy.excludedTags.join(", ")}`
      : "";
  return `Inactive ≥ ${policy.inactiveDays} days → ${label}${excluded}`;
}

const MAX_BRAND_TEXT_CHARACTERS = 160;
const MAX_BRAND_TEXT_BYTES = 512;
const MAX_BRAND_URL_BYTES = 2048;

const BRAND_FIELD_LABELS: Record<keyof SunsetBrandSnapshot, string> = {
  WorkspaceName: "Workspace name",
  SenderName: "Sender name",
  ProductName: "Product name",
  Tone: "Tone",
  HomepageURL: "Homepage URL",
  UnsubscribeURL: "Unsubscribe URL",
};

/**
 * The preview endpoint's bounds, mirrored: ≤160 characters of printable text,
 * and absolute HTTPS URLs without credentials. The URLs become clickable links
 * in generated copy, so the phishing-resistant contract is worth enforcing
 * before the request, not only after it.
 */
export function validateSunsetBrand(
  brand: SunsetBrandSnapshot,
): { field: keyof SunsetBrandSnapshot; message: string } | null {
  const encoder = new TextEncoder();
  for (const field of ["WorkspaceName", "SenderName", "ProductName"] as const) {
    const value = brand[field]?.trim() ?? "";
    if (
      Array.from(value).length > MAX_BRAND_TEXT_CHARACTERS ||
      encoder.encode(value).byteLength > MAX_BRAND_TEXT_BYTES
    ) {
      return {
        field,
        message: `${BRAND_FIELD_LABELS[field]} must be at most ${MAX_BRAND_TEXT_CHARACTERS} characters.`,
      };
    }
    if (/\p{Cc}/u.test(value)) {
      return {
        field,
        message: `${BRAND_FIELD_LABELS[field]} can't contain control characters.`,
      };
    }
  }
  for (const field of ["HomepageURL", "UnsubscribeURL"] as const) {
    const value = brand[field]?.trim() ?? "";
    if (value === "") continue;
    const message = `${BRAND_FIELD_LABELS[field]} must be an absolute HTTPS URL without embedded credentials.`;
    if (encoder.encode(value).byteLength > MAX_BRAND_URL_BYTES) {
      return { field, message: `${BRAND_FIELD_LABELS[field]} is too long.` };
    }
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      return { field, message };
    }
    if (
      parsed.protocol !== "https:" ||
      parsed.hostname === "" ||
      parsed.username !== "" ||
      parsed.password !== ""
    ) {
      return { field, message };
    }
  }
  return null;
}

function policyBody(input: SunsetPolicyInput): SunsetPolicyInput {
  return {
    name: input.name.trim(),
    inactiveDays: input.inactiveDays,
    action: input.action,
    enabled: false,
    excludedTags: [...input.excludedTags],
  };
}

function requirePolicy(res: unknown, verb: string): SunsetPolicy {
  const policy = parseSunsetPolicy(res);
  if (!policy) {
    throw new Error(
      `The server did not return the ${verb} policy. Refresh before editing it again.`,
    );
  }
  return policy;
}

/** POST /api/v1/sunset/policies (ScopeAdmin, 201). */
export async function createSunsetPolicy(
  input: SunsetPolicyInput,
): Promise<SunsetPolicy> {
  const res = await api.post<unknown>(
    "/api/v1/sunset/policies",
    policyBody(input),
    { requireOnline: true },
  );
  return requirePolicy(res, "created");
}

/** PUT /api/v1/sunset/policies/{id} (ScopeAdmin) — full replace. */
export async function updateSunsetPolicy(
  id: string,
  input: SunsetPolicyInput,
): Promise<SunsetPolicy> {
  const res = await api.put<unknown>(
    `/api/v1/sunset/policies/${encodeURIComponent(id)}`,
    policyBody(input),
    { requireOnline: true },
  );
  return requirePolicy(res, "updated");
}

/**
 * DELETE /api/v1/sunset/policies/{id} (ScopeAdmin, 204). Past executions stay
 * in the history and no subscriber is changed.
 */
export async function deleteSunsetPolicy(id: string): Promise<void> {
  await api.delete<unknown>(
    `/api/v1/sunset/policies/${encodeURIComponent(id)}`,
    { requireOnline: true },
  );
}

/** GET /api/v1/sunset/policies/{id}/executions?limit= (ScopeReadReports). */
export async function listSunsetExecutions(
  id: string,
  limit: number = SUNSET_EXECUTION_LIMIT,
): Promise<SunsetExecution[]> {
  const res = await api.get<{ items?: unknown }>(
    `/api/v1/sunset/policies/${encodeURIComponent(id)}/executions`,
    { query: { limit } },
  );
  return asArray(res?.items)
    .map(parseSunsetExecution)
    .filter((row): row is SunsetExecution => row !== null);
}

/**
 * POST /api/v1/sunset/reengagement/preview (ScopeReadReports). A pure template
 * generator: ONE template back, no recipients selected, nothing sent. Opted out
 * of the idempotency key and the offline queue — replaying a copy preview later
 * would be meaningless.
 */
export async function previewSunsetReengagement(input: {
  brand: SunsetBrandSnapshot;
  variant: SunsetTemplateVariant;
}): Promise<SunsetReengagementTemplate> {
  const brand: SunsetBrandSnapshot = {};
  for (const [key, value] of Object.entries(input.brand) as [
    keyof SunsetBrandSnapshot,
    string | undefined,
  ][]) {
    const trimmed = value?.trim();
    if (trimmed) (brand as Record<string, string>)[key] = trimmed;
  }
  const res = await api.post<Record<string, unknown>>(
    "/api/v1/sunset/reengagement/preview",
    { brand, variant: input.variant },
    { idempotencyKey: null },
  );
  const subject = str(res?.subject);
  if (!subject) {
    throw new Error("The preview service returned no template.");
  }
  return {
    subject,
    preheader: str(res?.preheader),
    bodyText: str(res?.bodyText),
    bodyHtml: str(res?.bodyHtml),
    primaryCta: str(res?.primaryCta),
    candidateCount: num(res?.candidateCount),
    variant: str(res?.variant) || input.variant,
  };
}
