/**
 * lib/integration-catalogue-api.ts — loyalty and lead-source connectors.
 *
 * FIVE provider catalogues were reached by desktop and by no web file:
 * loyalty (9), lead sources (48), reviews (9), customer support (26) and
 * subscription/shipping (18) — 110 connectors in total.
 *
 * SAME FINDING AS THE ANALYTICS CATALOGUE, MUCH LARGER SAMPLE. Of the 110,
 * exactly ONE is not `partial` — a single `delegated` lead provider, which is
 * a different state rather than a lesser one: the work happens elsewhere
 * rather than being unfinished here.
 *
 * 110 recognisable brand names rendered without status reads as 110 shipped
 * integrations. The status travels with each row.
 *
 * ONE CATALOGUE HAS A DIFFERENT SHAPE. The support catalogue is release-held:
 * its documented response (OpenAPI `SupportProviderSpec`, additionalProperties
 * false) is exactly `{key, name, runtime_status: "held", hold_code}` — no
 * `provider`, no `category`, no `auth_mode`. It is decoded with the same exact
 * decoder the support connect dialog and desktop use, then mapped onto this
 * row shape, so a catalogue row never claims fields the server did not send.
 */
import { api } from "@/lib/api";
import { listSupportProviders as listHeldSupportProviders } from "@/lib/support-integrations-api";

export interface CatalogueProvider {
  provider: string;
  name: string;
  /** Absent for the release-held support catalogue. */
  category?: string;
  /** "partial" | "delegated" | "supported" | "held" */
  runtime_status?: string;
  auth_mode?: string;
  docs_url?: string;
}

function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

type CataloguePath =
  | "/api/v1/loyalty-integrations/providers"
  | "/api/v1/lead-integrations/providers"
  | "/api/v1/review-integrations/providers"
  | "/api/v1/subscription-integrations/providers";

async function providers(path: CataloguePath): Promise<CatalogueProvider[]> {
  const res = await api.get<{ items?: unknown }>(path);
  return asArray<CatalogueProvider>(res?.items);
}

export function listLoyaltyProviders(): Promise<CatalogueProvider[]> {
  return providers("/api/v1/loyalty-integrations/providers");
}

export function listLeadProviders(): Promise<CatalogueProvider[]> {
  return providers("/api/v1/lead-integrations/providers");
}

export function listReviewProviders(): Promise<CatalogueProvider[]> {
  return providers("/api/v1/review-integrations/providers");
}

/**
 * The release-held support catalogue. A response that is not the documented
 * held projection rejects (the section renders its error state) instead of
 * being rendered as a partial list.
 */
export async function listSupportProviders(): Promise<CatalogueProvider[]> {
  const items = await listHeldSupportProviders();
  return items.map((item) => ({
    provider: item.key,
    name: item.name,
    runtime_status: item.runtime_status,
  }));
}

export function listSubscriptionProviders(): Promise<CatalogueProvider[]> {
  return providers("/api/v1/subscription-integrations/providers");
}

/** Counts by runtime status, so a page can state the position once. */
export function statusCounts(
  rows: readonly CatalogueProvider[],
): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) {
    const k = r.runtime_status ?? "unknown";
    out.set(k, (out.get(k) ?? 0) + 1);
  }
  return out;
}

/** A one-line summary like "9 partial" or "47 partial, 1 delegated". */
export function summariseStatuses(rows: readonly CatalogueProvider[]): string {
  return [...statusCounts(rows).entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([status, n]) => `${n} ${status}`)
    .join(", ");
}
