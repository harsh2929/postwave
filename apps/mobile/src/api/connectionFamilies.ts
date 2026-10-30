/**
 * api/connectionFamilies.ts — the provider families that share a lifecycle.
 *
 * INTEG#3 (reverse-ETL write-back) and INTEG#5 (Klaviyo-native marketing provider
 * rows) both had ZERO mobile references. Reads are ScopeReadReports and every
 * mutation is ScopeAdmin in both (integration_writeback/handlers.go:61-68,
 * marketing_integrations/handlers.go:104-113) — read from the handlers, because
 * both families' manifest rows are `fail_closed_default` and therefore unreviewed.
 *
 * P2.39 adds the five non-CRM native families the phone never read —
 * analytics / lead / review / loyalty / subscription. Each mounts the same
 * shape: GET list + GET /{id}/runs behind `read` (ScopeReadReports), and
 * sync · backfill · pause · DELETE behind `admin` (analytics_integrations/
 * handlers.go:190-199, lead :132-140, review :249-258, loyalty :208-217,
 * subscription :94-103). None of them has a resume route, so their verb set is
 * marketing's, and connectionVerbs must keep refusing to invent one.
 */
import { rawRequest } from "@/api/request";
import {
  parseConnectionRows,
  type ConnectionRow,
  type ConnectionVerb,
} from "@/lib/connectionLifecycle";

export type ConnectionFamily =
  | "writeback"
  | "marketing"
  | "analytics"
  | "lead"
  | "review"
  | "loyalty"
  | "subscription";

interface FamilySpec {
  base: string;
  verbs: ConnectionVerb[];
  label: string;
}

export const CONNECTION_FAMILIES: Readonly<Record<ConnectionFamily, FamilySpec>> =
  {
    writeback: {
      base: "/api/v1/integration-writeback/targets",
      verbs: ["run", "pause", "resume", "disconnect"],
      label: "Write-back targets",
    },
    marketing: {
      base: "/api/v1/marketing-integrations",
      // No resume route exists here; see connectionVerbs, which must not invent one.
      verbs: ["sync", "backfill", "pause", "disconnect"],
      label: "Marketing providers",
    },
    // The five below share marketing's contract exactly: no resume route.
    analytics: {
      base: "/api/v1/analytics-integrations",
      verbs: ["sync", "backfill", "pause", "disconnect"],
      label: "Analytics destinations",
    },
    lead: {
      base: "/api/v1/lead-integrations",
      verbs: ["sync", "backfill", "pause", "disconnect"],
      label: "Lead sources",
    },
    review: {
      base: "/api/v1/review-integrations",
      verbs: ["sync", "backfill", "pause", "disconnect"],
      label: "Review providers",
    },
    loyalty: {
      base: "/api/v1/loyalty-integrations",
      verbs: ["sync", "backfill", "pause", "disconnect"],
      label: "Loyalty providers",
    },
    subscription: {
      base: "/api/v1/subscription-integrations",
      verbs: ["sync", "backfill", "pause", "disconnect"],
      label: "Subscription providers",
    },
  };

export async function fetchConnections(
  family: ConnectionFamily,
): Promise<ConnectionRow[]> {
  const res = await rawRequest<unknown>("GET", CONNECTION_FAMILIES[family].base);
  if (res.error) throw Object.assign(new Error(res.error.message), res.error);
  return parseConnectionRows(res.data);
}

export async function runConnectionVerb(input: {
  family: ConnectionFamily;
  id: string;
  verb: ConnectionVerb;
}): Promise<void> {
  const id = input.id.trim();
  // An empty id would address the COLLECTION rather than a row — DELETE on the
  // base path, or a POST that chi resolves elsewhere.
  if (!id) throw new Error("connection id is required");
  const base = `${CONNECTION_FAMILIES[input.family].base}/${encodeURIComponent(id)}`;
  const res =
    input.verb === "disconnect"
      ? await rawRequest<unknown>("DELETE", base)
      : await rawRequest<unknown>("POST", `${base}/${input.verb}`, {});
  if (res.error) throw Object.assign(new Error(res.error.message), res.error);
}
