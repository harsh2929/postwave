/**
 * lib/preflight-api.ts — the checks you run before a send.
 *
 * Five paths desktop reached and no web file did: the pre-send verdict, the
 * send-window check, subject-line scoring, the accessibility linter and
 * Subject Lab variants.
 *
 * COVERAGE: this module wires all five, plus /api/v1/subject-lab/score,
 * /api/v1/email-validation/check, /api/v1/email-validation/check-batch and
 * /api/v1/deliverability/eq-score.
 *
 * FOUR PLACES WHERE THE HEADLINE VALUE IS NOT THE WHOLE ANSWER:
 *
 * 1. `presend/verdict` returns `complete: false` alongside its verdict. In
 *    this workspace two of three components ERRORED — voice drift and
 *    placement are unavailable — so the verdict rests on the single check that
 *    ran. A "critical" from an incomplete run is at least a real failure; the
 *    dangerous case is the inverse, where everything that ran happened to pass
 *    and a green badge tells an operator it is safe to send when two thirds of
 *    the checks never executed. `complete` is therefore never dropped, and a
 *    passing verdict from an incomplete run is not allowed to read as a pass.
 *
 * 2. `send-window/check` returns `should: "allow"` with `enforcement: "off"`.
 *    That "allow" is not the window approving the send — it is nothing
 *    checking. Shown alone it reads as a check that passed on merit.
 *
 * 3. `subject-analyzer/score` returns `expected_open: 0` and
 *    `expected_click: 0` with `matched_history: 0`. Zero here means NO BASIS
 *    TO PREDICT, not a predicted zero percent. Rendering it as a rate is the
 *    difference between "we don't know" and "this subject line will fail".
 *
 * 4. `subject-lab/variants` answers 403 with a structured entitlement error
 *    carrying a `remedy` ("contact_workspace_admin"). Collapsing it into a
 *    generic failure throws away the one part that tells the operator what to
 *    do about it.
 */
import { api, ApiError } from "@/lib/api";

export interface PresendComponent {
  name: string;
  status: string;
  score?: number;
  message?: string;
  error?: string;
}

export interface PresendVerdict {
  verdict: string;
  /** False when one or more components did not run. Never drop this. */
  complete: boolean;
  summary: string;
  components: PresendComponent[];
  computed_at: string;
}

export interface SendWindowCheck {
  inside_window: boolean;
  /** "off" means nothing is enforcing the window, whatever `should` says. */
  enforcement: string;
  should: string;
  reason?: string;
}

export interface SubjectScore {
  subject: string;
  attributes: Record<string, unknown>;
  expected_open: number;
  expected_click: number;
  /** 0 means the expectations above have no basis, not that they are zero. */
  matched_history: number;
  suggestions: string[];
}

export interface A11yFinding {
  rule: string;
  severity: string;
  message: string;
  snippet: string;
  wcag: string;
}

export interface A11yReport {
  findings: A11yFinding[];
  counts: Record<string, number>;
  score: number;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

export async function getPresendVerdict(): Promise<PresendVerdict> {
  const r = await api.post<Record<string, unknown>>("/api/v1/presend/verdict", {});
  return {
    verdict: str(r?.verdict),
    complete: r?.complete === true,
    summary: str(r?.summary),
    components: asArray<Record<string, unknown>>(r?.components).map((c) => ({
      name: str(c?.name),
      status: str(c?.status),
      score: typeof c?.score === "number" ? c.score : undefined,
      message: str(c?.message) || undefined,
      error: str(c?.error) || undefined,
    })),
    computed_at: str(r?.computed_at),
  };
}

export async function checkSendWindow(
  scheduledAt: string,
): Promise<SendWindowCheck> {
  const parsed = new Date(scheduledAt);
  if (!scheduledAt.trim() || !Number.isFinite(parsed.getTime())) {
    throw new Error("Scheduled time must be a valid date and time.");
  }
  const r = await api.post<Record<string, unknown>>("/api/v1/send-window/check", {
    scheduled_at: scheduledAt,
  });
  return {
    inside_window: r?.inside_window === true,
    enforcement: str(r?.enforcement),
    should: str(r?.should),
    reason: str(r?.reason) || undefined,
  };
}

export async function scoreSubject(subject: string): Promise<SubjectScore> {
  const r = await api.post<Record<string, unknown>>(
    "/api/v1/subject-analyzer/score",
    { subject },
  );
  return {
    subject: str(r?.subject),
    attributes: obj(r?.attributes),
    expected_open: num(r?.expected_open),
    expected_click: num(r?.expected_click),
    matched_history: num(r?.matched_history),
    suggestions: asArray<string>(r?.suggestions),
  };
}

/**
 * Run the WCAG heuristics over an email body.
 *
 * `subject` is optional because the standalone preflight tool lints pasted
 * HTML with no campaign behind it. When it IS available — the campaign send
 * gate has one — passing it turns on the server's subject-length rule
 * (apps/api/internal/a11y: `ruleSubjectLength`), which is silent otherwise.
 * An empty subject is omitted rather than sent as "", so a campaign with no
 * subject yet is not linted as though it had a zero-length one.
 */
export async function checkAccessibility(
  html: string,
  subject?: string,
  options: { signal?: AbortSignal } = {},
): Promise<A11yReport> {
  const trimmedSubject = subject?.trim() ?? "";
  const r = await api.post<Record<string, unknown>>(
    "/api/v1/a11y/check",
    trimmedSubject ? { html, subject: trimmedSubject } : { html },
    {
      // A lint computes nothing durable: never mint a mutation identity for it.
      idempotencyKey: null,
      signal: options.signal,
    },
  );
  return {
    findings: asArray<Record<string, unknown>>(r?.findings).map((f) => ({
      rule: str(f?.rule),
      severity: str(f?.severity),
      message: str(f?.message),
      snippet: str(f?.snippet),
      wcag: str(f?.wcag),
    })),
    counts: obj(r?.counts) as Record<string, number>,
    score: num(r?.score),
  };
}

export interface EntitlementRefusal {
  code: string;
  message: string;
  /**
   * The server's OWN statement of what resolves the denial, read off the
   * parsed `denial` rather than guessed.
   *
   * EMPTY IS MEANINGFUL. @postwave/errors documents an absent remedy as "the
   * caller cannot self-serve, which is itself worth saying rather than
   * inventing a button" — so this stays empty rather than being filled with a
   * plausible-sounding instruction the server never gave.
   */
  remedy: string;
  /** plan / role / flag / quota / policy / runtime — these need different UI. */
  reason: string;
  /** What was refused, e.g. "subject_lab". */
  subject: string;
}

/**
 * Subject Lab variants, which this workspace is not entitled to.
 *
 * Returns the refusal rather than throwing it away: the server names a remedy
 * and a generic "request failed" would lose it.
 */
export const SUBJECT_LAB_AXES = [
  "length",
  "emoji",
  "question",
  "personalization",
] as const;
export type SubjectLabAxis = (typeof SUBJECT_LAB_AXES)[number];

export interface SubjectLabGeneration {
  variants: string[];
  axis: SubjectLabAxis;
  generated_at: string;
}

export async function generateSubjectVariants(input: {
  seedSubject: string;
  axis: SubjectLabAxis;
  count?: number;
  bodyExcerpt?: string;
}): Promise<SubjectLabGeneration | { refused: EntitlementRefusal }> {
  const seed = input.seedSubject.trim();
  const count = input.count ?? 6;
  if (seed.length < 10 || seed.length > 998) {
    throw new Error("Subject Lab seed must be between 10 and 998 characters.");
  }
  if (!SUBJECT_LAB_AXES.includes(input.axis) || count < 5 || count > 8) {
    throw new Error("Subject Lab options are outside the supported bounds.");
  }
  try {
    const r = await api.post<Record<string, unknown>>(
      "/api/v1/subject-lab/variants",
      {
        seed_subject: seed,
        axis: input.axis,
        count,
        ...(input.bodyExcerpt?.trim()
          ? { body_excerpt: input.bodyExcerpt.slice(0, 2_000) }
          : {}),
      },
    );
    const variants = asArray<unknown>(r?.variants)
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim())
      .filter(Boolean)
      .slice(0, 8);
    return {
      variants,
      axis: SUBJECT_LAB_AXES.includes(r?.axis as SubjectLabAxis)
        ? (r.axis as SubjectLabAxis)
        : input.axis,
      generated_at: str(r?.generated_at),
    };
  } catch (err) {
    if (err instanceof ApiError && err.code === "feature_disabled") {
      return {
        refused: {
          code: err.code,
          message: err.message,
          remedy: err.denial?.remedy ?? "",
          reason: err.denial?.reason ?? "",
          subject: err.denial?.subject ?? "",
        },
      };
    }
    throw err;
  }
}

/**
 * A verdict that reads as safe but rests on checks that did not all run.
 *
 * This is the combination a green badge would misrepresent: everything that
 * executed passed, and some things never executed.
 */
export function passingButIncomplete(v: PresendVerdict): boolean {
  const failing = v.verdict === "critical" || v.verdict === "warn";
  return !failing && !v.complete;
}

/** Components that could not run, as opposed to ones that ran and failed. */
export function unavailableComponents(v: PresendVerdict): PresendComponent[] {
  return v.components.filter((c) => c.status === "error");
}

/** True when the expectation figures have no historical basis. */
export function expectationsUnfounded(s: SubjectScore): boolean {
  return s.matched_history === 0;
}

/**
 * Scores subject-line variants against sent history.
 *
 * Refuses with `insufficient_history` when there is nothing to score against,
 * which is a statement about YOUR ACCOUNT rather than about the subject
 * lines. The caller surfaces that distinction rather than reporting a failure.
 */
export interface ScoredSubjectVariant {
  text: string;
  predicted_open: number;
  ci_low: number;
  ci_high: number;
  matched_n: number;
  low_confidence: boolean;
  below_baseline: boolean;
}

export interface SubjectVariantScores {
  baseline_open: number;
  window_days: number;
  variants: ScoredSubjectVariant[];
}

export async function scoreSubjectVariants(
  subjects: string[],
): Promise<SubjectVariantScores | { insufficientHistory: true }> {
  const bounded = subjects.map((subject) => subject.trim());
  if (
    bounded.length < 1 ||
    bounded.length > 16 ||
    bounded.some((subject) => !subject || subject.length > 998)
  ) {
    throw new Error("Provide between 1 and 16 bounded subject lines.");
  }
  try {
    const r = await api.post<Record<string, unknown>>("/api/v1/subject-lab/score", {
      subjects: bounded,
    });
    return {
      baseline_open: num(r?.baseline_open),
      window_days: num(r?.window_days),
      variants: asArray<Record<string, unknown>>(r?.variants).map((variant) => ({
        text: str(variant.text),
        predicted_open: num(variant.predicted_open),
        ci_low: num(variant.ci_low),
        ci_high: num(variant.ci_high),
        matched_n: num(variant.matched_n),
        low_confidence: variant.low_confidence === true,
        below_baseline: variant.below_baseline === true,
      })),
    };
  } catch (err) {
    if (err instanceof ApiError && err.code === "insufficient_history") {
      return { insufficientHistory: true };
    }
    throw err;
  }
}

export interface EmailVerdict {
  email: string;
  /** Technically deliverable. NOT the same as "good to send to". */
  valid: boolean;
  /** ok | role_account | disposable | no_mx | syntax_invalid | … */
  verdict: string;
  domain: string;
  has_mx: boolean;
  disposable: boolean;
  role_account: boolean;
  reasons: string[];
}

function toVerdict(o: Record<string, unknown>): EmailVerdict {
  return {
    email: str(o?.email),
    valid: o?.valid === true,
    verdict: str(o?.verdict),
    domain: str(o?.domain),
    has_mx: o?.has_mx === true,
    disposable: o?.disposable === true,
    role_account: o?.role_account === true,
    reasons: asArray<string>(o?.reasons),
  };
}

/**
 * Checks a single address.
 *
 * `valid` AND `verdict` ARE DIFFERENT QUESTIONS. info@example.com comes back
 * `valid: true` with `verdict: "role_account"` — deliverable, and a shared
 * inbox nobody owns, which is a poor engagement signal and a common route
 * into a spam trap. A green tick on `valid` alone would encourage adding
 * exactly the addresses a list-hygiene tool exists to discourage.
 */
export async function checkEmail(email: string): Promise<EmailVerdict> {
  return toVerdict(
    await api.post<Record<string, unknown>>("/api/v1/email-validation/check", {
      email,
    }),
  );
}

export async function checkEmailBatch(emails: string[]): Promise<EmailVerdict[]> {
  const bounded = Array.from(new Set(emails.map((email) => email.trim())));
  if (
    bounded.length < 1 ||
    bounded.length > 1_000 ||
    bounded.some((email) => !email || email.length > 254)
  ) {
    throw new Error("Provide between 1 and 1,000 bounded email addresses.");
  }
  const r = await api.post<{ results?: unknown }>(
    "/api/v1/email-validation/check-batch",
    { emails: bounded },
  );
  return asArray<Record<string, unknown>>(r?.results).map(toVerdict);
}

/** Deliverable, but not an address you should be adding. */
export function deliverableButUnwise(v: EmailVerdict): boolean {
  return v.valid && (v.role_account || v.disposable);
}

export interface EqReason {
  code: string;
  message: string;
  severity: string;
  bucket: string;
}

export interface EqComponent {
  score: number;
  weight: number;
  reasons: EqReason[];
}

export interface EqScore {
  score: number;
  grade: string;
  content: EqComponent;
  auth: EqComponent;
}

function toComponent(v: unknown): EqComponent {
  const o = (v ?? {}) as Record<string, unknown>;
  return {
    score: num(o?.score),
    weight: num(o?.weight),
    reasons: asArray<Record<string, unknown>>(o?.reasons).map((r) => ({
      code: str(r?.code),
      message: str(r?.message),
      severity: str(r?.severity),
      bucket: str(r?.bucket),
    })),
  };
}

/**
 * Pre-send EQ score.
 *
 * THE OVERALL GRADE HIDES WHICH HALF FAILED. This workspace scores 59 / grade
 * F, and the breakdown is content 100 and auth 15 — the copy is faultless and
 * the entire failure is one unverified sending domain. A lone "F" sends
 * someone rewriting an email that was never the problem, so the components
 * are always shown and the dominant one is named.
 */
export async function getEqScore(input: {
  from: string;
  subject: string;
  html: string;
}): Promise<EqScore> {
  const r = await api.post<Record<string, unknown>>(
    "/api/v1/deliverability/eq-score",
    input,
  );
  return {
    score: num(r?.score),
    grade: str(r?.grade),
    content: toComponent(r?.content),
    auth: toComponent(r?.auth),
  };
}

/** The component dragging the overall score down, if one clearly is. */
export function weakestComponent(e: EqScore): "content" | "auth" | null {
  if (e.content.score === e.auth.score) return null;
  return e.content.score < e.auth.score ? "content" : "auth";
}

/**
 * The saved subscribers-list view preference for the signed-in user.
 *
 * Returns `{}` when nothing has been saved. An empty object is NOT a default
 * view — it means the user has never set one, so callers must supply their
 * own default rather than treating the response as authoritative.
 */
export async function getSubscribersViewPref(): Promise<Record<string, unknown>> {
  const r = await api.get<unknown>("/api/v1/me/prefs/subscribers_view");
  return r && typeof r === "object" && !Array.isArray(r)
    ? (r as Record<string, unknown>)
    : {};
}
