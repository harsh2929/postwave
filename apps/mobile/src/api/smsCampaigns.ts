/**
 * api/smsCampaigns.ts — read SMS campaigns and change their state.
 *
 * VERB#4. Routes (apps/api/internal/sms/handlers.go:119-129, :150):
 *
 *   GET  /api/v1/sms/campaigns              viewer  (reviewed)
 *   POST /api/v1/sms/campaigns/{id}/pause   editor  (reviewed)
 *   POST /api/v1/sms/campaigns/{id}/resume  editor  (reviewed)
 *   POST /api/v1/sms/campaigns/{id}/cancel  editor  (reviewed)
 *   POST /api/v1/sms/campaigns/{id}/retry-failed  editor (reviewed)
 *
 * `retry-failed` is mounted by MountIdempotentRoutes, so it REQUIRES an
 * Idempotency-Key — and it is the one verb here that spends money per call, which
 * is exactly why the server insists. A retry replayed by a flaky connection would
 * bill twice. `newOfflineOperationId()` supplies a stable key per user intent.
 */
import { rawRequest } from "@/api/request";
import type { SmsCampaignVerb } from "@/lib/smsCampaignControls";

const BASE = "/api/v1/sms/campaigns";
export const SMS_BROADCAST_DISPATCH_RELEASE_HELD_CODE =
  "sms_broadcast_dispatch_release_held" as const;

export interface SmsCampaignRow {
  id: string;
  name: string;
  status: string;
  scheduledAt: string;
  sentAt: string;
  /** Recipients still queued, when the payload reports it. */
  pendingRecipients: number | null;
  failedRecipients: number | null;
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null;
}

function rows(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) return payload as Record<string, unknown>[];
  if (payload && typeof payload === "object") {
    for (const key of ["items", "campaigns"]) {
      const inner = (payload as Record<string, unknown>)[key];
      if (Array.isArray(inner)) return inner as Record<string, unknown>[];
    }
  }
  return [];
}

export function parseSmsCampaigns(payload: unknown): SmsCampaignRow[] {
  const out: SmsCampaignRow[] = [];
  for (const raw of rows(payload)) {
    const id = str(raw.id);
    // A row with no id cannot be acted on; rendering it would be a card whose
    // every control throws.
    if (!id) continue;
    const stats =
      raw.stats && typeof raw.stats === "object"
        ? (raw.stats as Record<string, unknown>)
        : {};
    out.push({
      id,
      name: str(raw.name) || "Untitled SMS campaign",
      status: str(raw.status),
      scheduledAt: str(raw.scheduled_at),
      sentAt: str(raw.sent_at),
      pendingRecipients: count(stats.queued ?? stats.pending),
      failedRecipients: count(stats.failed),
    });
  }
  return out;
}

export async function fetchSmsCampaigns(): Promise<SmsCampaignRow[]> {
  const res = await rawRequest<unknown>("GET", BASE);
  if (res.error) throw Object.assign(new Error(res.error.message), res.error);
  return parseSmsCampaigns(res.data);
}

export async function runSmsCampaignVerb(input: {
  id: string;
  verb: SmsCampaignVerb;
}): Promise<void> {
  const id = input.id.trim();
  if (!id) throw new Error("sms campaign id is required");
  if (input.verb === "resume" || input.verb === "retry-failed") {
    throw Object.assign(
      new Error(
        "SMS broadcast dispatch is release-held; no campaign request was sent.",
      ),
      {
        code: SMS_BROADCAST_DISPATCH_RELEASE_HELD_CODE,
        status: 503,
      },
    );
  }
  const path = `${BASE}/${encodeURIComponent(id)}/${input.verb}`;
  const res = await rawRequest<unknown>("POST", path, {});
  if (res.error) throw Object.assign(new Error(res.error.message), res.error);
}
