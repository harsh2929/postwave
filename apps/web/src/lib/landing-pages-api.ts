// SPDX-License-Identifier: AGPL-3.0-only
import { api } from "./api";

// A queued/retried write could replay after the fresh authority check that
// immediately precedes each landing-page mutation. Keep these admin-only
// operations online and single-attempt; the shared transport still attaches
// an idempotency key to the one request.
const ONLINE_ADMIN_WRITE = { requireOnline: true, maxAttempts: 1 } as const;

export type LandingPageStatus = "draft" | "published" | "archived";

export interface LandingPage {
  id: string;
  tenant_id: string;
  slug: string;
  name: string;
  status: LandingPageStatus;
  domain?: string;
  template: string;
  blocks: Array<Record<string, unknown>>;
  seo: Record<string, unknown>;
  tracking: Record<string, unknown>;
  metrics: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  // LAND-038 scheduling (ISO timestamps, nullable).
  publish_at?: string | null;
  unpublish_at?: string | null;
}

export interface LandingPageCreateInput {
  slug: string;
  name: string;
  domain?: string;
  template?: string;
  blocks?: Array<Record<string, unknown>>;
  seo?: Record<string, unknown>;
  tracking?: Record<string, unknown>;
  publish_at?: string | null;
  unpublish_at?: string | null;
}

// Mirrors apps/api/internal/landingpages UpdateInput. Only the fields present
// on the wire are patched; note the backend treats a present `blocks`/`seo`/
// `tracking` value as a FULL REPLACE, so callers must send COMPLETE content.
export interface LandingPageUpdateInput {
  name?: string;
  slug?: string;
  status?: LandingPageStatus;
  domain?: string;
  template?: string;
  blocks?: Array<Record<string, unknown>>;
  seo?: Record<string, unknown>;
  tracking?: Record<string, unknown>;
  // LAND-038 tri-state schedule: omit = unchanged; null = clear; ISO = set.
  publish_at?: string | null;
  unpublish_at?: string | null;
}

/** One lead captured on a landing page (LAND-022). */
export interface LandingLead {
  email: string;
  at: string;
  metadata?: Record<string, unknown>;
}

/** One point-in-time snapshot of a landing page's content (LAND-039). */
export interface LandingPageVersion {
  version_no: number;
  name: string;
  status: LandingPageStatus;
  slug?: string;
  created_at: string;
}

/** One A/B variant of a landing page with per-variant metrics (LAND-037). */
export interface LandingPageVariant {
  id: string;
  page_id: string;
  name: string;
  weight: number;
  blocks: Array<Record<string, unknown>>;
  is_control: boolean;
  created_at: string;
  updated_at: string;
  views: number;
  conversions: number;
  conversion_rate: number;
}

export interface LandingPageVariantInput {
  name?: string;
  weight?: number;
  blocks?: Array<Record<string, unknown>>;
  is_control?: boolean;
}

function landingPageVersionSegment(versionNo: number): string {
  if (!Number.isSafeInteger(versionNo) || versionNo < 1) {
    throw new Error("Landing-page version must be a positive integer.");
  }
  return encodeURIComponent(String(versionNo));
}

export const landingPagesApi = {
  list: () => api.get<LandingPage[]>("/api/v1/landing-pages"),
  get: (id: string) =>
    api.get<LandingPage>(`/api/v1/landing-pages/${encodeURIComponent(id)}`),
  create: (input: LandingPageCreateInput) =>
    api.post<LandingPage>("/api/v1/landing-pages", input, ONLINE_ADMIN_WRITE),
  update: (id: string, patch: LandingPageUpdateInput) =>
    api.patch<LandingPage>(
      `/api/v1/landing-pages/${encodeURIComponent(id)}`,
      patch,
      ONLINE_ADMIN_WRITE,
    ),
  archive: (id: string) =>
    api.delete<{ ok: boolean }>(
      `/api/v1/landing-pages/${encodeURIComponent(id)}`,
      ONLINE_ADMIN_WRITE,
    ),
  listLeads: (id: string) =>
    api
      .get<{
        items: LandingLead[];
      }>(`/api/v1/landing-pages/${encodeURIComponent(id)}/leads`)
      .then((r) => (Array.isArray(r.items) ? r.items : [])),
  // LAND-039: version history + restore.
  listVersions: (id: string) =>
    api
      .get<{
        items: LandingPageVersion[];
      }>(`/api/v1/landing-pages/${encodeURIComponent(id)}/versions`)
      .then((r) => (Array.isArray(r.items) ? r.items : [])),
  restoreVersion: (id: string, versionNo: number) =>
    api.post<LandingPage>(
      `/api/v1/landing-pages/${encodeURIComponent(id)}/versions/${landingPageVersionSegment(versionNo)}/restore`,
      {},
      ONLINE_ADMIN_WRITE,
    ),
  // LAND-037: A/B variants with traffic split + per-variant metrics.
  listVariants: (id: string) =>
    api
      .get<{
        items: LandingPageVariant[];
      }>(`/api/v1/landing-pages/${encodeURIComponent(id)}/variants`)
      .then((r) => (Array.isArray(r.items) ? r.items : [])),
  createVariant: (id: string, input: LandingPageVariantInput) =>
    api.post<LandingPageVariant>(
      `/api/v1/landing-pages/${encodeURIComponent(id)}/variants`,
      input,
      ONLINE_ADMIN_WRITE,
    ),
  updateVariant: (
    id: string,
    variantId: string,
    patch: LandingPageVariantInput,
  ) =>
    api.patch<LandingPageVariant>(
      `/api/v1/landing-pages/${encodeURIComponent(id)}/variants/${encodeURIComponent(variantId)}`,
      patch,
      ONLINE_ADMIN_WRITE,
    ),
  deleteVariant: (id: string, variantId: string) =>
    api.delete<{ ok: boolean }>(
      `/api/v1/landing-pages/${encodeURIComponent(id)}/variants/${encodeURIComponent(variantId)}`,
      ONLINE_ADMIN_WRITE,
    ),
};

/** Same-origin CSV export URL for a landing page's leads (LAND-022). */
export function landingLeadsCsvUrl(id: string): string {
  return `/api/v1/landing-pages/${encodeURIComponent(id)}/leads.csv`;
}
