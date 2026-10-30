/**
 * api/forms.ts — the signup-form surface: monitoring reads, and since the
 * desktop-parity pass, the lifecycle writes.
 *
 * Routes (apps/api/internal/server/sending_forms_routes.go:103-120):
 *   GET    /api/v1/forms                  read:campaigns
 *   GET    /api/v1/forms/{id}             read:campaigns
 *   PATCH  /api/v1/forms/{id}             write:campaigns (editor on session)
 *   DELETE /api/v1/forms/{id}             ADMIN — cascades through responses
 *   GET    /api/v1/forms/{id}/analytics   read:reports   (per-day visits)
 *   GET    /api/v1/forms/{id}/submissions ADMIN          (contains PII)
 *   GET    /api/v1/forms/{id}/submissions.csv ADMIN      (text/csv)
 *
 * The submissions CSV used to be recorded here as "deliberately NOT wrapped —
 * it needs a stream token and a file download". That reasoning is obsolete:
 * the discounts surface has shared its redemptions CSV as bounded TEXT through
 * the share sheet since COMMERCE#31 (lib/discountExport.ts), and this module
 * now does the same via `fetchFormSubmissionsCsv` + lib/formSubmissionsExport.
 *
 * The list payload already carries submissions30d / visits30d /
 * conversionRate per form (forms.FormListItem), so the four headline KPIs
 * need no extra request.
 */
import {
  checkedApiResult,
  rawRequest,
  sdkResource,
  type AIApiResult,
} from "./request";
import type {
  FormVariantPromotionWire,
  FormVariantWire,
} from "@/lib/formVariants";

export type FormStatus = "draft" | "published" | "archived";

/** GET /api/v1/forms row — forms.FormListItem. */
export interface FormListItem {
  id: string;
  slug?: string;
  name?: string;
  status?: FormStatus | string;
  optInMode?: "single" | "double" | string;
  stepCount?: number;
  createdAt?: string;
  updatedAt?: string;
  submissions30d?: number;
  /** 0..100, server-computed per form. */
  conversionRate?: number;
  /** Hosted-page views over 30 days. 0 for forms that predate migration 0366. */
  visits30d?: number;
}

export type FormDetail = FormListItem & {
  settings?: Record<string, unknown> | null;
  structure?: Record<string, unknown> | null;
};

export interface FormVisitPoint {
  /** YYYY-MM-DD, UTC bucket, zero-filled by the server. */
  date: string;
  count: number;
}

export interface FormAnalytics {
  form_id?: string;
  days?: number;
  visits?: FormVisitPoint[];
  visits_total?: number;
}

/** GET /api/v1/forms/{id}/submissions row. Admin-only: carries PII. */
export interface FormSubmission {
  id: string;
  formId?: string;
  email?: string;
  status?: string;
  submittedAt?: string;
  confirmedAt?: string | null;
}

/**
 * The list endpoint historically returns a bare array. Accept the envelope
 * shapes too rather than assuming — a shape assumption here renders as a
 * silently-empty screen, which is the exact failure class this app has paid
 * for before.
 */
export type FormListResponse =
  | FormListItem[]
  | { items?: FormListItem[]; data?: FormListItem[]; forms?: FormListItem[] };

export function normalizeFormListResponse(
  response: FormListResponse | null | undefined,
): FormListItem[] {
  if (Array.isArray(response)) return response;
  if (!response || typeof response !== "object") return [];
  const candidate = response.items ?? response.data ?? response.forms;
  return Array.isArray(candidate) ? candidate : [];
}

/** GET /api/v1/forms — optional `query` narrows server-side by name/slug. */
export async function listForms(
  query?: string,
): Promise<AIApiResult<FormListResponse>> {
  const trimmed = (query ?? "").trim();
  const path = trimmed
    ? `/api/v1/forms?query=${encodeURIComponent(trimmed)}`
    : "/api/v1/forms";
  return rawRequest<FormListResponse>("GET", path);
}

/** GET /api/v1/forms/{id} */
export async function getForm(id: string): Promise<AIApiResult<FormDetail>> {
  return rawRequest<FormDetail>(
    "GET",
    `/api/v1/forms/${encodeURIComponent(id)}`,
  );
}

/** GET /api/v1/forms/{id}/analytics?days=N — per-day hosted-page visits. */
export async function getFormAnalytics(
  id: string,
  days = 30,
): Promise<AIApiResult<FormAnalytics>> {
  const window = Number.isFinite(days) ? Math.min(90, Math.max(1, days)) : 30;
  return rawRequest<FormAnalytics>(
    "GET",
    `/api/v1/forms/${encodeURIComponent(id)}/analytics?days=${window}`,
  );
}

/**
 * GET /api/v1/forms/{id}/submissions — ADMIN scope.
 *
 * The server keeps this at admin because the rows carry email addresses,
 * IP/user-agent metadata and arbitrary custom fields, and the scope vocabulary
 * has no form-response PII permission yet. The caller must gate the affordance
 * on an admin effective role; the response is a bare array.
 */
export async function listFormSubmissions(
  id: string,
  limit = 25,
): Promise<AIApiResult<FormSubmission[]>> {
  const bounded = Number.isFinite(limit) ? Math.min(200, Math.max(1, limit)) : 25;
  return rawRequest<FormSubmission[]>(
    "GET",
    `/api/v1/forms/${encodeURIComponent(id)}/submissions?limit=${bounded}`,
  );
}

/**
 * Re-send a double-opt-in confirmation. ADMIN, like the list it acts on.
 *
 * The form detail already renders every submission's status, so a `pending`
 * row is visibly a subscriber who never confirmed — and the only recovery for
 * that is another confirmation email. This was the missing verb beside a
 * status the screen has always shown.
 *
 * 409 IS NOT A FAILURE. The handler answers 409 when the submission is already
 * confirmed, which means somebody confirmed between the screen loading and the
 * tap. The caller's intent is satisfied, so it is reported as "already
 * confirmed" rather than as an error — but never as "sent", because nothing
 * was sent.
 */
export async function resendFormConfirmation(
  formId: string,
  submissionId: string,
): Promise<{ sent: boolean; alreadyConfirmed: boolean }> {
  const res = await rawRequest<unknown>(
    "POST",
    `/api/v1/forms/${encodeURIComponent(formId)}/submissions/${encodeURIComponent(
      submissionId,
    )}/resend-confirmation`,
    {},
  );
  if (res.error) {
    if (res.error.status === 409) return { sent: false, alreadyConfirmed: true };
    throw new Error(res.error.message || "Couldn't resend the confirmation.");
  }
  return { sent: true, alreadyConfirmed: false };
}

export interface FormEmbedSnippet {
  flavor?: string;
  snippet?: string;
  language?: string;
  instructions?: string;
  public_host?: string;
  /** Canonical hosted-page URL, built server-side from FORMS_PUBLIC_HOST. */
  public_url?: string;
}

/**
 * GET /api/v1/forms/{id}/embed/{flavor} — ADMIN scope.
 *
 * We call this purely for `public_url`. The server comment is explicit that it
 * exists "so native/dashboard clients never have to infer FORMS_PUBLIC_HOST
 * from the API origin" — which is exactly the guess that would produce a
 * View-live-page button that 404s.
 */
export async function getFormEmbed(
  id: string,
  flavor: "script" | "iframe" = "iframe",
): Promise<AIApiResult<FormEmbedSnippet>> {
  return rawRequest<FormEmbedSnippet>(
    "GET",
    `/api/v1/forms/${encodeURIComponent(id)}/embed/${flavor}`,
  );
}

/* ------------------------------------------------------------------ *
 * Display-optimization variants (A/B)
 *
 * GET /api/v1/forms/{id}/variants and .../variants/promotions are
 * `read:reports` — a DIFFERENT scope from the read:campaigns the rest of this
 * module uses (apps/api/internal/form_variants/handlers.go:32-40), so a token
 * that can read the form can legitimately be refused these.
 *
 * The ADMIN verbs (create / update / delete / evaluate) used to stay off
 * mobile by policy; the desktop-parity pass brought them here because pausing
 * a losing arm and asking for an evaluation are decision-shaped taps on data
 * this screen already renders. STATUSES ARE `exploring | promoted | paused`
 * (form_variants.go:27-31) — there is NO "active" (the desktop panel's
 * active↔paused toggle is wrong and 500s on resume); pause is
 * exploring→paused, resume is paused→exploring, and PROMOTED IS TERMINAL.
 * "Promote the winner" is not a client verb at all: POST /variants/evaluate
 * (body ignored) makes the SERVER reweight and, at |z| ≥ 1.96 with ≥200
 * impressions per arm, persist the promotion itself.
 * ------------------------------------------------------------------ */

/**
 * PATCH /api/v1/forms/{id} with `{status}` — the lifecycle verb.
 *
 * ONLINE-ONLY BY POLICY, not by omission: lib/offlineQueueSafety's
 * `isSafeQueueBody` explicitly refuses to queue a forms PATCH whose body
 * carries `status`, because publish/unpublish changes a PUBLIC surface.
 * Callers guard with `isProbablyOnline()` before calling.
 *
 * Legal transitions are draft→published/archived and published→draft/archived
 * (forms.go `AllowedTransition`); ARCHIVED IS TERMINAL, which is why
 * lib/formLifecycle offers no verb on an archived form.
 */
export async function updateFormStatus(
  id: string,
  status: "draft" | "published" | "archived",
): Promise<FormDetail | null> {
  const res = await checkedApiResult(
    rawRequest<FormDetail>(
      "PATCH",
      `/api/v1/forms/${encodeURIComponent(id)}`,
      { status },
    ),
  );
  return res.data ?? null;
}

/**
 * DELETE /api/v1/forms/{id} — ADMIN, and a HARD delete: `DELETE FROM forms`
 * (repo.go:339-342), cascading through the form's submission records. There
 * is no undelete, which is why the caller runs it behind a typed-phrase
 * ConfirmSheet and why it is never queued (DELETEs are refused by the offline
 * queue outright).
 */
export async function deleteForm(id: string): Promise<void> {
  await checkedApiResult(
    rawRequest<{ ok?: boolean }>(
      "DELETE",
      `/api/v1/forms/${encodeURIComponent(id)}`,
    ),
  );
}

/** POST /api/v1/forms — the path constant the offline outbox enqueues. */
export const CREATE_FORM_PATH = "/api/v1/forms";

export interface CreateFormInput {
  name: string;
  slug: string;
  optInMode: "single" | "double";
  successMessage: string;
}

/**
 * The exact body POST /api/v1/forms takes (forms.go `CreateInput`, camelCase;
 * `optInMode` is REQUIRED — the server 422s rather than defaulting it).
 *
 * NO `status` FIELD EXISTS on create: the repo hardcodes `'draft'`
 * (repo.go:207-208), which is also what makes this write QUEUEABLE offline —
 * a form created from a tunnel goes live only after a separate, online-only
 * publish. Kept as a pure builder so the enqueue-time body and the test
 * assert the same object.
 */
export function createFormBody(input: CreateFormInput): {
  name: string;
  slug: string;
  optInMode: "single" | "double";
  successMessage: string;
} {
  return {
    name: input.name.trim(),
    slug: input.slug.trim(),
    optInMode: input.optInMode,
    successMessage: input.successMessage.trim(),
  };
}

/**
 * GET /api/v1/forms/{id}/submissions.csv — ADMIN — as TEXT for the share
 * sheet, the same route discounts takes for redemptions. The server streams
 * every row (keyset pages of 1000, no query params); lib/formSubmissionsExport
 * bounds and re-emits it before it reaches the share sheet.
 */
export async function fetchFormSubmissionsCsv(id: string): Promise<string> {
  // Through `sdkResource`, never `getClient` directly: reaching for the
  // client here would pull react-native into this module's import graph and
  // take every node test of it down (see the sdkResource docstring).
  const res = await checkedApiResult(
    sdkResource<string>((client) =>
      client.request<string>(
        "GET",
        `/api/v1/forms/${encodeURIComponent(id)}/submissions.csv`,
        { asText: true },
      ),
    ),
  );
  return res.data ?? "";
}

export function listFormVariants(
  id: string,
): Promise<AIApiResult<FormVariantWire[]>> {
  return rawRequest<FormVariantWire[]>(
    "GET",
    `/api/v1/forms/${encodeURIComponent(id)}/variants`,
  );
}

export function listFormVariantPromotions(
  id: string,
): Promise<AIApiResult<FormVariantPromotionWire[]>> {
  return rawRequest<FormVariantPromotionWire[]>(
    "GET",
    `/api/v1/forms/${encodeURIComponent(id)}/variants/promotions`,
  );
}

/** POST /forms/{id}/variants — 201 Variant; 409 label_taken. ADMIN. */
export async function createFormVariant(
  formId: string,
  input: { label: string; trafficPct?: number },
): Promise<FormVariantWire | null> {
  const body: { label: string; trafficPct?: number } = {
    label: input.label.trim(),
  };
  if (input.trafficPct !== undefined) body.trafficPct = input.trafficPct;
  const res = await checkedApiResult(
    rawRequest<FormVariantWire>(
      "POST",
      `/api/v1/forms/${encodeURIComponent(formId)}/variants`,
      body,
    ),
  );
  return res.data ?? null;
}

/**
 * PATCH /forms/{id}/variants/{variantId} — sparse: only the keys present are
 * applied. `status` must respect exploring↔paused (promoted is terminal).
 */
export async function updateFormVariant(
  formId: string,
  variantId: string,
  patch: {
    label?: string;
    trafficPct?: number;
    status?: "exploring" | "paused";
  },
): Promise<FormVariantWire | null> {
  const res = await checkedApiResult(
    rawRequest<FormVariantWire>(
      "PATCH",
      `/api/v1/forms/${encodeURIComponent(formId)}/variants/${encodeURIComponent(variantId)}`,
      patch,
    ),
  );
  return res.data ?? null;
}

/** DELETE /forms/{id}/variants/{variantId} — 200 {ok}. ADMIN, online-only. */
export async function deleteFormVariant(
  formId: string,
  variantId: string,
): Promise<void> {
  await checkedApiResult(
    rawRequest<{ ok?: boolean }>(
      "DELETE",
      `/api/v1/forms/${encodeURIComponent(formId)}/variants/${encodeURIComponent(variantId)}`,
    ),
  );
}

/** What POST /variants/evaluate answers: the server's own decision record. */
export interface FormVariantEvaluation {
  decision?: {
    weights?: Record<string, number>;
    promoted_variant_id?: string;
    promotedVariantId?: string;
  } | null;
  samples?: unknown[];
}

/**
 * POST /forms/{id}/variants/evaluate — the "is there a winner yet?" verb.
 * The body is ignored server-side; the SERVER decides whether to promote
 * (|z| ≥ 1.96, ≥200 impressions/arm) and persists both the reweight and any
 * promotion before answering.
 */
export async function evaluateFormVariants(
  formId: string,
): Promise<FormVariantEvaluation | null> {
  const res = await checkedApiResult(
    rawRequest<FormVariantEvaluation>(
      "POST",
      `/api/v1/forms/${encodeURIComponent(formId)}/variants/evaluate`,
      {},
    ),
  );
  return res.data ?? null;
}
