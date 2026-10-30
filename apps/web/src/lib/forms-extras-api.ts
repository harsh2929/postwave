// SPDX-License-Identifier: AGPL-3.0-only
//
// Transport + pure helpers for the forms parity extras (desktop → web):
//
//   * server-authored embed snippets  GET  /api/v1/forms/{id}/embed/{flavor}
//   * spam-protection settings        PATCH /api/v1/forms/{id}  (via updateForm,
//                                      so the cached If-Match token is shared)
//   * reload after a 412 edit conflict GET  /api/v1/forms/{id}  (via getForm,
//                                      which re-captures the fresh ETag)
//   * chart-data CSV builders for the analytics tab (client-side export of data
//     the tab already loads, plus the submissions window for admins)
//
// Desktop references: apps/desktop/src/components/FormDetailSlideover.tsx
// (canonicalEmbedFromResponse, requestConflictReload) and
// apps/desktop/src/components/forms/FormSpamSettings.tsx (parse/apply).

import { api, isApiError } from "./api";
import { toCsv } from "./analytics-format";
import { getForm, listSubmissions, updateForm } from "./forms-api";
import type {
  Form,
  FormSettings,
  FormSubmission,
  FormVisitPoint,
  SubmissionStatus,
} from "./forms-types";

// --- Embed snippets (automation-14) ----------------------------------------

/** Flavors the web share picker requests. The server also knows `wordpress`
 * and `inline`; desktop exposes exactly these three plus the hosted URL. */
export type FormEmbedFlavor = "iframe" | "script" | "react";

/** The picker's tabs: `hosted` reads the canonical public URL, which the
 * server returns alongside every flavor (desktop asks the iframe flavor). */
export type FormShareTab = "hosted" | FormEmbedFlavor;

export const FORM_SHARE_TABS: ReadonlyArray<{
  value: FormShareTab;
  label: string;
}> = [
  { value: "hosted", label: "Hosted page" },
  { value: "iframe", label: "Iframe" },
  { value: "script", label: "Script" },
  { value: "react", label: "React" },
];

export function embedFlavorForTab(tab: FormShareTab): FormEmbedFlavor {
  return tab === "hosted" ? "iframe" : tab;
}

/** A server response that passed every check in `parseCanonicalEmbed`. */
export interface CanonicalFormEmbed {
  flavor: FormEmbedFlavor;
  snippet: string;
  language: string;
  instructions: string;
  publicHost: string;
  publicUrl: string;
}

export const EMBED_CONTRACT_ERROR =
  "The server did not return a valid canonical share contract. Copying stays disabled until it does.";

export class FormEmbedContractError extends Error {
  constructor() {
    super(EMBED_CONTRACT_ERROR);
    this.name = "FormEmbedContractError";
  }
}

function isLocalHttpUrl(url: URL): boolean {
  const h = url.hostname.toLowerCase();
  return (
    url.protocol === "http:" &&
    (h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]")
  );
}

/**
 * Validate the embed response before a single byte of it is offered for
 * copying. Ported from desktop's `canonicalEmbedFromResponse`: the flavor must
 * echo the request, every field must be a string, the host and URL must be
 * HTTPS (or loopback HTTP), credential-free, same-origin, and the URL must sit
 * under `<host>/forms/`. Anything else returns null — an operator pasting a
 * snippet that points somewhere unexpected is the failure this prevents.
 */
export function parseCanonicalEmbed(
  raw: unknown,
  expected: FormEmbedFlavor,
): CanonicalFormEmbed | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (
    r.flavor !== expected ||
    typeof r.snippet !== "string" ||
    r.snippet.trim() === "" ||
    typeof r.language !== "string" ||
    typeof r.instructions !== "string" ||
    typeof r.public_host !== "string" ||
    typeof r.public_url !== "string"
  ) {
    return null;
  }
  try {
    const host = new URL(r.public_host);
    const url = new URL(r.public_url);
    const safe = (u: URL) => u.protocol === "https:" || isLocalHttpUrl(u);
    if (
      !safe(host) ||
      !safe(url) ||
      host.username ||
      host.password ||
      url.username ||
      url.password
    ) {
      return null;
    }
    // Serialized-prefix match: this also pins the URL to the host's origin
    // (scheme, host and normalized port all precede the path), which desktop
    // checks separately.
    const canonicalHost = host.toString().replace(/\/$/, "");
    if (!url.toString().startsWith(`${canonicalHost}/forms/`)) return null;
    return {
      flavor: expected,
      snippet: r.snippet,
      language: r.language,
      instructions: r.instructions,
      publicHost: canonicalHost,
      publicUrl: url.toString(),
    };
  } catch {
    return null;
  }
}

/**
 * GET /api/v1/forms/{id}/embed/{flavor} — admin-scoped. A 503
 * `forms_public_host_unconfigured` arrives as an ApiError carrying the
 * server's sentence; a malformed 200 throws `FormEmbedContractError`.
 */
export async function getFormEmbedSnippet(
  formId: string,
  flavor: FormEmbedFlavor,
): Promise<CanonicalFormEmbed> {
  const raw = await api.get<unknown>(
    `/api/v1/forms/${encodeURIComponent(formId)}/embed/${flavor}`,
  );
  const parsed = parseCanonicalEmbed(raw, flavor);
  if (!parsed) throw new FormEmbedContractError();
  return parsed;
}

/** What the picker shows for a tab: the hosted URL, or the snippet verbatim. */
export function shareTextForTab(
  tab: FormShareTab,
  embed: CanonicalFormEmbed,
): string {
  return tab === "hosted" ? embed.publicUrl : embed.snippet;
}

// --- Spam protection (automation-13) ---------------------------------------

export type CaptchaProvider = "" | "recaptcha" | "hcaptcha" | "turnstile";

export interface SpamSettings {
  honeypotEnabled: boolean;
  captchaProvider: CaptchaProvider;
  captchaSiteKey: string;
  /** "" = off. Integer 0..1000 otherwise. */
  rateLimitPerMin: number | "";
}

/** The settings keys this card owns, beside the typed FormSettings ones. */
export type SpamSettingsKeys = {
  honeypotEnabled?: boolean;
  captchaProvider?: Exclude<CaptchaProvider, "">;
  captchaSiteKey?: string;
  rateLimitPerMin?: number;
};

export const RATE_LIMIT_MAX = 1000;
export const SITE_KEY_MAX = 256;

const PROVIDERS: ReadonlyArray<Exclude<CaptchaProvider, "">> = [
  "recaptcha",
  "hcaptcha",
  "turnstile",
];

/**
 * Read SpamSettings out of a form's `settings` jsonb. Tolerant of missing or
 * mistyped values. A form configured through web's older reCAPTCHA toggle
 * (`captchaRequired` + `recaptchaSiteKey`, FORM-034) reads back as the
 * reCAPTCHA provider so the two editors agree on what is configured.
 */
export function parseSpamSettings(
  settings: FormSettings | Record<string, unknown> | null | undefined,
): SpamSettings {
  const s = (settings ?? {}) as Record<string, unknown>;
  const rawProvider = String(s.captchaProvider ?? "").toLowerCase();
  let captchaProvider: CaptchaProvider = (
    PROVIDERS as readonly string[]
  ).includes(rawProvider)
    ? (rawProvider as CaptchaProvider)
    : "";
  let captchaSiteKey = typeof s.captchaSiteKey === "string" ? s.captchaSiteKey : "";
  if (!captchaProvider && s.captchaRequired === true) {
    captchaProvider = "recaptcha";
    captchaSiteKey =
      typeof s.recaptchaSiteKey === "string" ? s.recaptchaSiteKey : "";
  }
  const rate = s.rateLimitPerMin;
  return {
    // The server default is on (and the check is unconditional at submit).
    honeypotEnabled:
      s.honeypotEnabled === undefined ? true : s.honeypotEnabled === true,
    captchaProvider,
    captchaSiteKey,
    rateLimitPerMin:
      typeof rate === "number" && Number.isInteger(rate) && rate > 0
        ? rate
        : "",
  };
}

export function sameSpamSettings(a: SpamSettings, b: SpamSettings): boolean {
  return (
    a.honeypotEnabled === b.honeypotEnabled &&
    a.captchaProvider === b.captchaProvider &&
    a.captchaSiteKey.trim() === b.captchaSiteKey.trim() &&
    a.rateLimitPerMin === b.rateLimitPerMin
  );
}

/** Field-level problems, or null when the draft can be saved. */
export function validateSpamSettings(
  spam: SpamSettings,
): { rateLimit?: string; siteKey?: string } | null {
  const out: { rateLimit?: string; siteKey?: string } = {};
  if (
    spam.rateLimitPerMin !== "" &&
    (!Number.isInteger(spam.rateLimitPerMin) ||
      spam.rateLimitPerMin < 0 ||
      spam.rateLimitPerMin > RATE_LIMIT_MAX)
  ) {
    out.rateLimit = `Enter a whole number from 0 to ${RATE_LIMIT_MAX}, or leave it blank for no limit.`;
  }
  const key = spam.captchaSiteKey.trim();
  if (key.length > SITE_KEY_MAX) {
    out.siteKey = `Site keys are at most ${SITE_KEY_MAX} characters.`;
  } else if (/\s/.test(key)) {
    out.siteKey = "Site keys contain no spaces. Paste the public key exactly.";
  }
  return out.rateLimit || out.siteKey ? out : null;
}

/**
 * Fold SpamSettings into the form's FULL settings map. PATCH replaces
 * `settings` wholesale server-side, so every other key must ride along.
 *
 * Only reCAPTCHA can be enforced today: the server verifies against the
 * deployment's reCAPTCHA secret when `captchaRequired` is set. Choosing
 * reCAPTCHA therefore also sets the enforced keys; choosing hCaptcha or
 * Turnstile clears them, because requiring reCAPTCHA would render the wrong
 * provider's widget. The provider/site-key/rate-limit keys mirror desktop's
 * FormSpamSettings exactly so both editors round-trip the same jsonb.
 */
export function applySpamSettings(
  settings: FormSettings,
  spam: SpamSettings,
): FormSettings & SpamSettingsKeys {
  const next: FormSettings & SpamSettingsKeys = { ...settings };
  next.honeypotEnabled = spam.honeypotEnabled;
  const key = spam.captchaSiteKey.trim();
  if (spam.captchaProvider) {
    next.captchaProvider = spam.captchaProvider;
    if (key) next.captchaSiteKey = key;
    else delete next.captchaSiteKey;
  } else {
    delete next.captchaProvider;
    delete next.captchaSiteKey;
  }
  if (spam.captchaProvider === "recaptcha") {
    next.captchaRequired = true;
    if (key) next.recaptchaSiteKey = key;
    else delete next.recaptchaSiteKey;
  } else {
    next.captchaRequired = false;
    delete next.recaptchaSiteKey;
  }
  if (typeof spam.rateLimitPerMin === "number" && spam.rateLimitPerMin > 0) {
    next.rateLimitPerMin = spam.rateLimitPerMin;
  } else {
    delete next.rateLimitPerMin;
  }
  return next;
}

/**
 * PATCH /api/v1/forms/{id} with `{settings}` only. Goes through forms-api's
 * updateForm so the If-Match token captured by the last getForm is sent, and
 * refuses the offline queue: a spam setting that silently lands later is not
 * one the operator can reason about.
 */
export function saveFormSpamSettings(
  form: Pick<Form, "id" | "settings">,
  spam: SpamSettings,
): Promise<Form> {
  return updateForm(
    form.id,
    { settings: applySpamSettings(form.settings, spam) },
    { requireOnline: true },
  );
}

// --- Edit conflicts (automation-22) ----------------------------------------

/** The server refused a write because the form moved on (If-Match stale). */
export function isFormEditConflict(err: unknown): boolean {
  return isApiError(err) && err.status === 412;
}

/**
 * GET /api/v1/forms/{id}. Through getForm so the fresh ETag is captured and
 * the next save carries the token for the version the operator now sees.
 */
export function reloadLatestForm(formId: string): Promise<Form> {
  return getForm(formId);
}

// --- Chart data CSV (automation-19) ----------------------------------------

export const CHART_CSV_FILES = {
  visits: "form-hosted-page-visits.csv",
  volume: "form-daily-submission-volume.csv",
  statusMix: "form-submission-status-mix.csv",
} as const;

const DAY_MS = 86_400_000;

function utcDayStart(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** First millisecond of the `days`-long UTC window ending today. */
export function windowStartMs(days: number, now: number = Date.now()): number {
  return utcDayStart(now) - (Math.max(1, days) - 1) * DAY_MS;
}

export function visitsCsv(visits: readonly FormVisitPoint[]): string {
  const rows: Array<Array<string | number>> = [["Date", "Visits"]];
  for (const p of visits) rows.push([p.date, p.count]);
  return toCsv(rows);
}

export interface DailyVolume {
  date: string;
  submissions: number;
}

/** Zero-filled per-UTC-day submission counts over the window. */
export function dailySubmissionVolume(
  submissions: readonly FormSubmission[],
  days: number,
  now: number = Date.now(),
): DailyVolume[] {
  const start = windowStartMs(days, now);
  const counts = new Map<string, number>();
  const out: DailyVolume[] = [];
  for (let i = 0; i < Math.max(1, days); i++) {
    const date = isoDay(start + i * DAY_MS);
    counts.set(date, 0);
  }
  for (const s of submissions) {
    const at = Date.parse(s.submittedAt);
    if (!Number.isFinite(at)) continue;
    // Only the window's own days are keys, so anything outside it is dropped.
    const date = isoDay(utcDayStart(at));
    if (counts.has(date)) counts.set(date, (counts.get(date) ?? 0) + 1);
  }
  for (const [date, n] of counts) out.push({ date, submissions: n });
  return out;
}

export function dailySubmissionVolumeCsv(volume: readonly DailyVolume[]): string {
  const rows: Array<Array<string | number>> = [["Date", "Submissions"]];
  for (const v of volume) rows.push([v.date, v.submissions]);
  return toCsv(rows);
}

export interface StatusMixRow {
  status: SubmissionStatus;
  label: string;
  submissions: number;
  /** Percentage of the window's submissions, one decimal; 0 when empty. */
  share: number;
}

const STATUS_ORDER: ReadonlyArray<{ status: SubmissionStatus; label: string }> =
  [
    { status: "confirmed", label: "Confirmed" },
    { status: "pending", label: "Pending" },
    { status: "unsubscribed", label: "Unsubscribed" },
  ];

export function submissionStatusMix(
  submissions: readonly FormSubmission[],
  days: number,
  now: number = Date.now(),
): StatusMixRow[] {
  const start = windowStartMs(days, now);
  const inWindow = submissions.filter((s) => {
    const at = Date.parse(s.submittedAt);
    return Number.isFinite(at) && at >= start;
  });
  const total = inWindow.length;
  return STATUS_ORDER.map(({ status, label }) => {
    const n = inWindow.filter((s) => s.status === status).length;
    return {
      status,
      label,
      submissions: n,
      share: total === 0 ? 0 : Math.round((n / total) * 1000) / 10,
    };
  });
}

export function statusMixCsv(mix: readonly StatusMixRow[]): string {
  const rows: Array<Array<string | number>> = [
    ["Status", "Submissions", "Share (%)"],
  ];
  for (const m of mix) rows.push([m.label, m.submissions, m.share]);
  return toCsv(rows);
}

export interface SubmissionWindow {
  items: FormSubmission[];
  /** True when the page cap stopped the walk before the window's start. */
  truncated: boolean;
}

/**
 * Walk GET /api/v1/forms/{id}/submissions (newest first, keyset cursor) until
 * a page reaches past the window's start. Admin-scoped server-side. Capped at
 * `maxPages` × 1000 rows; `truncated` says the counts are a lower bound.
 */
export async function listSubmissionsInWindow(
  formId: string,
  days: number,
  now: number = Date.now(),
  maxPages = 20,
): Promise<SubmissionWindow> {
  const start = windowStartMs(days, now);
  const items: FormSubmission[] = [];
  let cursor = "";
  for (let page = 0; page < maxPages; page++) {
    const res = await listSubmissions(formId, { cursor, limit: 1000 });
    const rows = Array.isArray(res.items) ? res.items : [];
    items.push(...rows);
    const oldest = rows.length ? Date.parse(rows[rows.length - 1].submittedAt) : NaN;
    if (!res.nextCursor || rows.length === 0) return { items, truncated: false };
    if (Number.isFinite(oldest) && oldest < start) {
      return { items, truncated: false };
    }
    cursor = res.nextCursor;
  }
  return { items, truncated: true };
}
