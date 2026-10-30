/**
 * api/crmIntegrations.ts — the CRM connection lifecycle.
 *
 * Routes (apps/api/internal/crm_integrations/handlers.go:111-119), all
 * `session_minimum_role: admin`, `review_status: reviewed`:
 *
 *   GET    /api/v1/crm/integrations            list
 *   GET    /api/v1/crm/integrations/{id}/runs  why the last sync failed
 *   POST   /api/v1/crm/integrations/{id}/sync
 *   POST   /api/v1/crm/integrations/{id}/backfill
 *   POST   /api/v1/crm/integrations/{id}/pause
 *   POST   /api/v1/crm/integrations/{id}/resume
 *   DELETE /api/v1/crm/integrations/{id}
 *
 * Mobile had none of them (INTEG#2): the phone could see a CRM integration was
 * unhealthy and could do nothing whatever about it.
 *
 * Paths are built with encodeURIComponent and REFUSE an empty id. A blank id would
 * produce `/api/v1/crm/integrations//sync`, which chi resolves to a different route
 * — the same footgun the archive hooks documented after hitting it.
 */
import { rawRequest } from "@/api/request";
import type { CrmIntegrationRow, CrmVerb } from "@/lib/crmLifecycle";

const BASE = "/api/v1/crm/integrations";

function integrationPath(id: string, suffix = ""): string {
  const trimmed = id.trim();
  if (!trimmed) {
    throw new Error("crm integration id is required");
  }
  return `${BASE}/${encodeURIComponent(trimmed)}${suffix}`;
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Unwrap `{items:[...]}` or a bare array, both of which this API has used. */
function items(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) return payload as Record<string, unknown>[];
  if (payload && typeof payload === "object") {
    const inner = (payload as { items?: unknown }).items;
    if (Array.isArray(inner)) return inner as Record<string, unknown>[];
  }
  return [];
}

export function parseCrmIntegrations(payload: unknown): CrmIntegrationRow[] {
  const out: CrmIntegrationRow[] = [];
  for (const raw of items(payload)) {
    const id = str(raw.id);
    // A row with no id cannot be acted on, and rendering it would produce a card
    // whose every button throws. Drop it rather than show a decorative one.
    if (!id) continue;
    out.push({
      id,
      provider: str(raw.provider),
      name: str(raw.name) || str(raw.provider) || "CRM connection",
      status: str(raw.status),
      lastSyncAt: str(raw.last_sync_at),
      errorMessage: str(raw.error_message),
    });
  }
  return out;
}

export async function fetchCrmIntegrations(): Promise<CrmIntegrationRow[]> {
  const res = await rawRequest<unknown>("GET", BASE);
  if (res.error) throw Object.assign(new Error(res.error.message), res.error);
  return parseCrmIntegrations(res.data);
}

const VERB_PATHS: Readonly<Record<Exclude<CrmVerb, "disconnect">, string>> = {
  sync: "/sync",
  backfill: "/backfill",
  pause: "/pause",
  resume: "/resume",
};

/** Run one lifecycle verb against one connection. */
export async function runCrmVerb(input: {
  id: string;
  verb: CrmVerb;
}): Promise<void> {
  const res =
    input.verb === "disconnect"
      ? await rawRequest<unknown>("DELETE", integrationPath(input.id))
      : await rawRequest<unknown>(
          "POST",
          integrationPath(input.id, VERB_PATHS[input.verb]),
          {},
        );
  if (res.error) throw Object.assign(new Error(res.error.message), res.error);
}
