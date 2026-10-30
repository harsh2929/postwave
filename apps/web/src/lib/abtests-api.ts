// SPDX-License-Identifier: AGPL-3.0-only
//
// Typed wrappers around the campaign A/B endpoints exposed by apps/api.
// Mirrors forms-api.ts: real fetch by default; mocks are opt-in via
// NEXT_PUBLIC_USE_MOCKS=1.

import { api } from "./api";
import { isMockModeEnabled } from "./mock-mode";
import type {
  ABSettings,
  ABView,
  SetABSettingsInput,
  Variant,
} from "./abtests-types";

const USE_MOCKS = isMockModeEnabled();
const loadMocks = () => import("./abtests-mocks");

async function withMockFallback<T>(
  realCall: () => Promise<T>,
  fallback: () => T | Promise<T>,
): Promise<T> {
  if (USE_MOCKS) return await fallback();
  return realCall();
}

export function listVariants(campaignID: string): Promise<Variant[]> {
  return withMockFallback(
    () =>
      api.get<Variant[]>(
        `/api/v1/campaigns/${encodeURIComponent(campaignID)}/variants`,
      ),
    async () => (await loadMocks()).mockListVariants(campaignID),
  );
}

export async function createVariants(
  campaignID: string,
  variants: Variant[],
): Promise<Variant[]> {
  const normalized = normalizeVariantWeights(variants);
  return withMockFallback(
    async () => {
      const compiled = await Promise.all(normalized.map(compileVariantMJML));
      return api.post<Variant[]>(
        `/api/v1/campaigns/${encodeURIComponent(campaignID)}/variants`,
        // GET returns IDs, ownership and timestamps that the strict write
        // contract rejects. Project editable fields for every save, including
        // saves made from the server's response to an earlier edit.
        compiled.map((variant) => ({
          variant_label: variant.variant_label,
          subject: variant.subject,
          from_name: variant.from_name,
          from_email: variant.from_email,
          body_mjml: variant.body_mjml,
          body_html: variant.body_html,
          weight: variant.weight,
        })),
      );
    },
    async () => (await loadMocks()).mockCreateVariants(campaignID, normalized),
  );
}

export function normalizeVariantWeights(variants: Variant[]): Variant[] {
  if (variants.length === 0) return [];
  const weights = variants.map((variant) =>
    Number.isFinite(variant.weight) ? Math.max(0, variant.weight) : 0,
  );
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const raw = weights.map((weight) =>
    total > 0 ? (weight * 100) / total : 100 / variants.length,
  );
  const floors = raw.map(Math.floor);
  let remaining = 100 - floors.reduce((sum, weight) => sum + weight, 0);
  const order = raw
    .map((weight, index) => ({ index, fraction: weight - floors[index] }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  for (const entry of order) {
    if (remaining <= 0) break;
    floors[entry.index] += 1;
    remaining -= 1;
  }
  return variants.map((variant, index) => ({
    ...variant,
    weight: floors[index],
  }));
}

/** Compile an MJML source string to HTML via the app's /api/mjml route.
 *  Shared so the variant editor can preview compiled output (CAMP-046). */
export async function compileMjmlToHtml(source: string): Promise<string> {
  const trimmed = source.trim();
  if (!trimmed) return "";
  const response = await fetch("/api/mjml", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mjml: trimmed }),
  });
  const payload = (await response.json().catch(() => ({}))) as {
    html?: string;
    error?: string;
  };
  if (!response.ok || !payload.html) {
    throw new Error(payload.error || "MJML compile failed");
  }
  return payload.html;
}

async function compileVariantMJML(variant: Variant): Promise<Variant> {
  const source = variant.body_mjml?.trim();
  if (!source) return variant;
  const html = await compileMjmlToHtml(source);
  return { ...variant, body_html: html };
}

export function getAB(campaignID: string): Promise<ABView> {
  return withMockFallback(
    () =>
      api.get<ABView>(`/api/v1/campaigns/${encodeURIComponent(campaignID)}/ab`),
    async () => (await loadMocks()).mockGetAB(campaignID),
  );
}

export function setABSettings(
  campaignID: string,
  input: SetABSettingsInput,
): Promise<ABSettings> {
  return withMockFallback(
    () =>
      api.post<ABSettings>(
        `/api/v1/campaigns/${encodeURIComponent(campaignID)}/ab/settings`,
        input,
      ),
    async () => (await loadMocks()).mockSetSettings(campaignID, input),
  );
}

export function evaluateAB(campaignID: string): Promise<ABView> {
  return withMockFallback(
    () =>
      api.post<ABView>(
        `/api/v1/campaigns/${encodeURIComponent(campaignID)}/ab/evaluate`,
      ),
    async () => (await loadMocks()).mockEvaluate(campaignID),
  );
}
