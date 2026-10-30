// SPDX-License-Identifier: AGPL-3.0-only
//
// Typed wrappers around the forms HTTP endpoints exposed by apps/api.
// Mirrors the migration-api.ts pattern: real fetch by default; mocks are
// opt-in via NEXT_PUBLIC_USE_MOCKS=1.

import { api, fetchTextAuthed } from "./api";
import { isMockModeEnabled } from "./mock-mode";
import type {
  CreateFormInput,
  CreateFormVariantInput,
  Form,
  FormAnalytics,
  FormListItem,
  FormSubmission,
  FormVariant,
  FormVariantPromotion,
  ListRef,
  UpdateFormInput,
  UpdateFormVariantInput,
} from "./forms-types";

const USE_MOCKS = isMockModeEnabled();
const loadMocks = () => import("./forms-mocks");
const formEtags = new Map<string, string>();
// How many saves of each form have been accepted in this page. Responses land
// in arrival order, not in the order the server produced them: a GET the
// server answered just before a save committed can arrive after that save's
// response, and its older token would make the next save's If-Match — the
// Publish after a Save — fail with 412. A read may record its token only if
// no save was accepted while it was in flight.
const formWriteEpochs = new Map<string, number>();

function formWriteEpoch(id: string): number {
  return formWriteEpochs.get(id) ?? 0;
}

function rememberFormEtag(id: string, response: Response): void {
  // See rememberSegmentEtag / captureCampaignETag: onResponse fires before the
  // `res.ok` check and a 412 carries no ETag, so a set-only capture pins the
  // rejected token in the map and every subsequent save re-earns the same 412.
  if (response.status === 412) {
    formEtags.delete(id);
    return;
  }
  const etag = response.headers.get("etag");
  if (etag) formEtags.set(id, etag);
}

async function withMockFallback<T>(
  realCall: () => Promise<T>,
  fallback: () => T | Promise<T>,
): Promise<T> {
  if (USE_MOCKS) return await fallback();
  return realCall();
}

export function listForms(): Promise<FormListItem[]> {
  return withMockFallback(
    () => api.get<FormListItem[]>("/api/v1/forms"),
    async () => (await loadMocks()).mockListForms(),
  );
}

export function getForm(id: string, signal?: AbortSignal): Promise<Form> {
  return withMockFallback(
    () => {
      const writeEpoch = formWriteEpoch(id);
      return api.get<Form>(`/api/v1/forms/${encodeURIComponent(id)}`, {
        signal,
        onResponse: (response) => {
          if (formWriteEpoch(id) !== writeEpoch) return;
          rememberFormEtag(id, response);
        },
      });
    },
    async () => (await loadMocks()).mockGetForm(id),
  );
}

export interface FormMutationOptions {
  /** Fail instead of entering the offline outbox. Required for dependent writes. */
  requireOnline?: boolean;
}

export function createForm(
  input: CreateFormInput,
  options: FormMutationOptions = {},
): Promise<Form> {
  return withMockFallback(
    async () => {
      let responseEtag = "";
      const form = await api.post<Form>("/api/v1/forms", input, {
        requireOnline: options.requireOnline,
        maxAttempts: options.requireOnline ? 1 : undefined,
        onResponse: (response) => {
          responseEtag = response.headers.get("etag") ?? "";
        },
      });
      if (responseEtag) formEtags.set(form.id, responseEtag);
      return form;
    },
    async () => (await loadMocks()).mockCreateForm(input),
  );
}

export function updateForm(
  id: string,
  patch: UpdateFormInput,
  options: FormMutationOptions = {},
): Promise<Form> {
  return withMockFallback(
    () =>
      api.patch<Form>(`/api/v1/forms/${encodeURIComponent(id)}`, patch, {
        headers: formEtags.has(id)
          ? { "If-Match": formEtags.get(id)! }
          : undefined,
        requireOnline: options.requireOnline,
        maxAttempts: options.requireOnline ? 1 : undefined,
        onResponse: (response) => {
          rememberFormEtag(id, response);
          if (response.ok) formWriteEpochs.set(id, formWriteEpoch(id) + 1);
        },
      }),
    async () => (await loadMocks()).mockUpdateForm(id, patch),
  );
}

export function deleteForm(
  id: string,
  options: FormMutationOptions = {},
): Promise<{ ok: true }> {
  return withMockFallback(
    () =>
      api.delete<{ ok: true }>(`/api/v1/forms/${encodeURIComponent(id)}`, {
        requireOnline: options.requireOnline,
        maxAttempts: options.requireOnline ? 1 : undefined,
      }),
    async () => {
      (await loadMocks()).mockDeleteForm(id);
      return { ok: true as const };
    },
  );
}

/** Delete a single submission — e.g. spam (FORM-030). */
export function deleteSubmission(
  formId: string,
  submissionId: string,
  options: FormMutationOptions = {},
): Promise<{ ok: true }> {
  return api.delete<{ ok: true }>(
    `/api/v1/forms/${encodeURIComponent(formId)}/submissions/${encodeURIComponent(submissionId)}`,
    {
      requireOnline: options.requireOnline,
      maxAttempts: options.requireOnline ? 1 : undefined,
    },
  );
}

/** Re-send the double opt-in confirmation email for a pending submission
 * (FORM-030). Rejects (409) if the submission is already confirmed. */
export function resendConfirmation(
  formId: string,
  submissionId: string,
  options: FormMutationOptions = {},
): Promise<{ ok: true; resent_to?: string }> {
  return api.post<{ ok: true; resent_to?: string }>(
    `/api/v1/forms/${encodeURIComponent(formId)}/submissions/${encodeURIComponent(submissionId)}/resend-confirmation`,
    undefined,
    {
      requireOnline: options.requireOnline,
      maxAttempts: options.requireOnline ? 1 : undefined,
    },
  );
}

export interface FormSubmissionsPage {
  items: FormSubmission[];
  nextCursor: string;
}

export function listSubmissions(
  formId: string,
  options: { cursor?: string; limit?: number } = {},
): Promise<FormSubmissionsPage> {
  return withMockFallback(
    async () => {
      const query = new URLSearchParams({
        limit: String(options.limit ?? 100),
      });
      if (options.cursor) query.set("cursor", options.cursor);
      let nextCursor = "";
      const items = await api.get<FormSubmission[]>(
        `/api/v1/forms/${encodeURIComponent(formId)}/submissions?${query.toString()}`,
        {
          onResponse: (response) => {
            nextCursor = response.headers.get("X-Next-Cursor") ?? "";
          },
        },
      );
      return { items, nextCursor };
    },
    async () => ({
      items: (await loadMocks()).mockListSubmissions(formId),
      nextCursor: "",
    }),
  );
}

export interface AllSubmissions {
  items: FormSubmission[];
  /** True when the cap was hit and more rows exist server-side. */
  truncated: boolean;
}

/**
 * Walk the keyset cursor to collect every submission (up to `cap` rows), so the
 * page can show true grand totals and filter/search across the whole set
 * (FORM-007). The backend default page size is 1000, so most forms come back in
 * a single request; larger sets page until the cap.
 */
export async function listAllSubmissions(
  formId: string,
  cap = 20_000,
): Promise<AllSubmissions> {
  const items: FormSubmission[] = [];
  let cursor = "";
  const pageSize = 1000;
  for (let guard = 0; guard < 100; guard++) {
    const page = await listSubmissions(formId, { cursor, limit: pageSize });
    items.push(...page.items);
    if (items.length >= cap)
      return { items: items.slice(0, cap), truncated: true };
    if (!page.nextCursor || page.items.length === 0) break;
    cursor = page.nextCursor;
  }
  return { items, truncated: false };
}

/** Returns the public download URL for the CSV export. */
export function submissionsCsvUrl(formId: string): string {
  return `/api/v1/forms/${encodeURIComponent(formId)}/submissions.csv`;
}

/**
 * Fetch the submissions CSV through the authed API client (attaches the
 * tenant/credential headers a bare `<a download>` cannot) so a 401/500 throws
 * an ApiError the caller can surface instead of silently downloading an empty
 * file. FORM-041.
 */
export function fetchSubmissionsCsv(formId: string): Promise<string> {
  return withMockFallback(
    () => fetchTextAuthed(submissionsCsvUrl(formId)),
    () => "id,email,status\n",
  );
}

/** Placeholder hosted origin used during SSR / before the client resolves. */
export const DEFAULT_FORMS_ORIGIN = "https://forms.moosewave.com";

/**
 * The explicitly-configured hosted origin, or "" when unset. Pure and
 * deterministic (no `window` read), so it is safe to call during render on both
 * server and client without a hydration mismatch (FORM-001).
 */
export function configuredFormsOrigin(): string {
  return (
    process.env.NEXT_PUBLIC_FORMS_ORIGIN ||
    process.env.NEXT_PUBLIC_APP_URL ||
    ""
  ).replace(/\/+$/, "");
}

/**
 * Deterministic hosted origin for render. Returns the configured origin or the
 * stable default — never `window.location.origin` — so server and first client
 * paint agree. Client components that want the live browser origin should read
 * it after mount via `useFormsOrigin()`.
 */
export function publicFormsOrigin(): string {
  return configuredFormsOrigin() || DEFAULT_FORMS_ORIGIN;
}

export function publicFormUrl(slug: string, origin?: string): string {
  const safeSlug = encodeURIComponent(slug);
  const base = (origin ?? publicFormsOrigin()).replace(/\/+$/, "");
  return `${base}/forms/${safeSlug}`;
}

// --- Analytics (FORM-008) --------------------------------------------------

/** GET /api/v1/forms/{id}/analytics?days= — per-day hosted-form visits. */
export function getFormAnalytics(
  id: string,
  days = 30,
): Promise<FormAnalytics> {
  return withMockFallback(
    async () => {
      const raw = await api.get<{
        form_id: string;
        days: number;
        visits: Array<{ date: string; count: number }>;
        visits_total: number;
      }>(
        `/api/v1/forms/${encodeURIComponent(id)}/analytics?days=${encodeURIComponent(String(days))}`,
      );
      return {
        formId: raw.form_id,
        days: raw.days,
        visits: Array.isArray(raw.visits) ? raw.visits : [],
        visitsTotal: raw.visits_total ?? 0,
      };
    },
    () => ({ formId: id, days, visits: [], visitsTotal: 0 }),
  );
}

// --- A/B variants (FORM-009) -----------------------------------------------

export function listFormVariants(formId: string): Promise<FormVariant[]> {
  return withMockFallback(
    () =>
      api.get<FormVariant[]>(
        `/api/v1/forms/${encodeURIComponent(formId)}/variants`,
      ),
    () => [],
  );
}

export function createFormVariant(
  formId: string,
  input: CreateFormVariantInput,
): Promise<FormVariant> {
  return api.post<FormVariant>(
    `/api/v1/forms/${encodeURIComponent(formId)}/variants`,
    input,
  );
}

export function updateFormVariant(
  formId: string,
  variantId: string,
  input: UpdateFormVariantInput,
): Promise<FormVariant> {
  return api.patch<FormVariant>(
    `/api/v1/forms/${encodeURIComponent(formId)}/variants/${encodeURIComponent(variantId)}`,
    input,
    { requireOnline: true, maxAttempts: 1 },
  );
}

export function deleteFormVariant(
  formId: string,
  variantId: string,
): Promise<{ ok: true }> {
  return api.delete<{ ok: true }>(
    `/api/v1/forms/${encodeURIComponent(formId)}/variants/${encodeURIComponent(variantId)}`,
  );
}

export function listFormVariantPromotions(
  formId: string,
): Promise<FormVariantPromotion[]> {
  return withMockFallback(
    () =>
      api.get<FormVariantPromotion[]>(
        `/api/v1/forms/${encodeURIComponent(formId)}/variants/promotions`,
      ),
    () => [],
  );
}

// --- Lists picker (FORM-033) -----------------------------------------------

/** Loosely-typed Listmonk list-envelope aliases we normalize away. */
interface ListsEnvelope {
  data?: { results?: RawList[]; total?: number } | RawList[] | null;
  items?: RawList[];
  results?: RawList[];
}
interface RawList {
  id: number;
  name: string;
  subscriber_count?: number;
}

/**
 * GET /api/v1/lists — normalized to `ListRef[]`. The gateway proxies Listmonk,
 * which wraps rows in `{data:{results:[…]}}`; we tolerate the same alias ladder
 * the desktop client uses so the target-list picker survives envelope drift.
 */
export function listLists(): Promise<ListRef[]> {
  return withMockFallback(
    async () => {
      const env = await api.get<ListsEnvelope>("/api/v1/lists");
      return normalizeLists(env);
    },
    () => [],
  );
}

export function normalizeLists(
  env: ListsEnvelope | RawList[] | null,
): ListRef[] {
  const rows = extractListRows(env);
  return rows
    .filter((r): r is RawList => !!r && typeof r.id === "number")
    .map((r) => ({
      id: r.id,
      name: r.name || `List ${r.id}`,
      subscriberCount: r.subscriber_count,
    }));
}

function extractListRows(env: ListsEnvelope | RawList[] | null): RawList[] {
  if (!env) return [];
  if (Array.isArray(env)) return env;
  const data = env.data;
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.results)) return data.results;
  if (Array.isArray(env.results)) return env.results;
  if (Array.isArray(env.items)) return env.items;
  return [];
}
