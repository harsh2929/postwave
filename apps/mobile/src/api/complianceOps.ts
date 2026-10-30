/**
 * api/complianceOps.ts — the DSAR queue and the maintenance schedule.
 *
 *   GET /api/v1/sar/requests          (admin) — subject-access requests
 *   GET /api/v1/maintenance-windows   (admin) — scheduled downtime
 *
 * READS ONLY, ON PURPOSE.
 *
 * `POST /api/v1/sar/requests` runs the bundle build synchronously and
 * `GET /{id}.zip` hands back one person's personal data. Neither belongs on a
 * phone: the first is a long synchronous job started from the least reliable
 * network an operator has, and the second is a data-egress action landing in a
 * shared Downloads folder on a device that may be somebody's personal handset,
 * with no chain of custody. Those stay at a desk.
 *
 * The maintenance writes (create / patch / delete) are absent for a duller
 * reason: scheduling downtime is planning work, and nobody does it from a
 * phone. Only "is a window open right now" travels.
 */
import { rawRequest, type AIApiError } from "./request";

import type {
  MaintenanceWindowLike,
  SarRequestLike,
} from "@/lib/complianceOps";

class ComplianceOpsError extends Error {
  readonly status: number;
  constructor(error: AIApiError, fallback: string) {
    super(error.message || fallback);
    this.name = "ComplianceOpsError";
    this.status = error.status;
  }
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function unwrapList(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    const r = data as Record<string, unknown>;
    for (const key of ["items", "requests", "windows", "data"]) {
      if (Array.isArray(r[key])) return r[key] as unknown[];
    }
  }
  return [];
}

function normalizeSar(raw: unknown): SarRequestLike | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.id);
  if (!id) return null;
  return {
    id,
    kind: str(r.kind),
    // A missing status must not read as fulfilled. Empty falls through
    // `sarIsOpen`'s terminal checks and stays OPEN, which is the safe side of
    // a statutory clock.
    status: str(r.status),
    requested_at: str(r.requested_at),
    ...(typeof r.ready_at === "string" && r.ready_at
      ? { ready_at: r.ready_at }
      : {}),
    ...(str(r.error) ? { error: str(r.error) } : {}),
  };
}

/** The subject-access queue. Admin-only; a viewer's query never runs. */
export async function listSarRequests(): Promise<SarRequestLike[]> {
  const res = await rawRequest<unknown>("GET", "/api/v1/sar/requests");
  if (res.error) {
    throw new ComplianceOpsError(res.error, "Couldn't load subject requests.");
  }
  const out: SarRequestLike[] = [];
  for (const entry of unwrapList(res.data)) {
    const row = normalizeSar(entry);
    if (row) out.push(row);
  }
  return out;
}

function normalizeWindow(raw: unknown): MaintenanceWindowLike | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.id);
  if (!id) return null;
  return {
    id,
    title: str(r.title) || "Maintenance",
    components: Array.isArray(r.components)
      ? r.components.filter((c): c is string => typeof c === "string")
      : [],
    starts_at: str(r.starts_at),
    ends_at: str(r.ends_at),
    status: str(r.status),
  };
}

/** Scheduled downtime. Half of the answer to "why is nothing sending?". */
export async function listMaintenanceWindows(): Promise<MaintenanceWindowLike[]> {
  const res = await rawRequest<unknown>("GET", "/api/v1/maintenance-windows");
  if (res.error) {
    throw new ComplianceOpsError(
      res.error,
      "Couldn't load maintenance windows.",
    );
  }
  const out: MaintenanceWindowLike[] = [];
  for (const entry of unwrapList(res.data)) {
    const row = normalizeWindow(entry);
    if (row) out.push(row);
  }
  return out;
}
