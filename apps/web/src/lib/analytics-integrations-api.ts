/**
 * lib/analytics-integrations-api.ts — analytics and CDP destinations.
 *
 * `/api/v1/analytics-integrations/providers` was reached by desktop and by no
 * web file. It lists 31 destinations (29 analytics, 2 CDP).
 *
 * NONE OF THEM ARE FULLY LIVE. Every one answers `runtime_status: "partial"`,
 * and four carry a `verification_mode` ending in
 * `live_certification_pending` — a stronger statement still: the connector
 * exists, it has not been certified against the real provider.
 *
 * A catalogue that renders 31 logos with "Connect" buttons and no status makes
 * all 31 look production-ready. The status and the certification state are
 * carried through so the UI can say what is actually true.
 */
import { api } from "@/lib/api";

export interface AnalyticsProvider {
  provider: string;
  name: string;
  category: string;
  auth_mode?: string;
  managed?: boolean;
  /** "partial" for every provider at time of writing. */
  runtime_status?: string;
  sync_model?: string;
  /** Ends with `live_certification_pending` when uncertified. */
  verification_mode?: string;
  capabilities?: unknown[];
  docs_url?: string;
}

export async function listAnalyticsProviders(): Promise<AnalyticsProvider[]> {
  const res = await api.get<{ items?: unknown }>(
    "/api/v1/analytics-integrations/providers",
  );
  return Array.isArray(res?.items) ? (res.items as AnalyticsProvider[]) : [];
}

/** True when the connector has not been certified against the live provider. */
export function awaitingLiveCertification(p: AnalyticsProvider): boolean {
  return (p.verification_mode ?? "").endsWith("live_certification_pending");
}

/** True when no provider in the list reports a fully-supported runtime. */
export function allProvidersArePartial(
  providers: readonly AnalyticsProvider[],
): boolean {
  return (
    providers.length > 0 &&
    providers.every((p) => p.runtime_status !== "supported")
  );
}
