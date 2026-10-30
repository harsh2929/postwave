/**
 * useSubscriberRecordHistory / useSubscriberConsentReceipts — the two
 * "what happened to this RECORD" reads behind the profile.
 *
 *   GET /api/v1/subscribers/{id}/attribute-history?limit=
 *       RequireScope(ScopeReadSubscribers) → read-only scope, ANY role.
 *   GET /api/v1/consent/receipts/by-email/{email}
 *       RequireScope(ScopeAdmin) → owner|admin ONLY on a session.
 *
 * The two gates are deliberately separate; see the lib's doc.
 *
 * Both are LAZY: `enabled` also requires the caller's `open` flag, so a
 * profile that nobody expanded costs no requests. The consent lookup in
 * particular reads a compliance ledger, and firing it on every profile open
 * would put a PII read in the audit log for every casual glance.
 */
import { useQuery } from "@tanstack/react-query";

import { getClient } from "@/api/sdkClient";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import {
  parsePortableReceipt,
  type PortableConsentReceipt,
} from "@/lib/portableConsentReceipt";
import {
  parseConsentReceipts,
  parseRecordHistory,
} from "@/lib/subscriberRecordHistory";

const HISTORY_PAGE_SIZE = 25;

export function useSubscriberRecordHistory(
  subscriberId: string | undefined,
  open: boolean,
) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: ["sub-attr-history", gate.tenantId, subscriberId],
    enabled: open && gate.enabled && Boolean(gate.tenantId && subscriberId),
    queryFn: async () => {
      const { client } = getClient();
      const res = await client.request<unknown>(
        "GET",
        `/api/v1/subscribers/${encodeURIComponent(subscriberId!)}/attribute-history`,
        { query: { limit: HISTORY_PAGE_SIZE } },
      );
      return parseRecordHistory(res);
    },
  });
}

export function useSubscriberConsentReceipts(
  email: string | undefined,
  open: boolean,
) {
  const gate = useOnlineQueryGate();
  const address = (email ?? "").trim().toLowerCase();
  return useQuery({
    queryKey: ["sub-consent-receipts", gate.tenantId, address],
    enabled: open && gate.enabled && Boolean(gate.tenantId && address),
    queryFn: async () => {
      const { client } = getClient();
      const res = await client.request<unknown>(
        "GET",
        `/api/v1/consent/receipts/by-email/${encodeURIComponent(address)}`,
      );
      return parseConsentReceipts(res, gate.tenantId!, address);
    },
  });
}

/**
 * The PORTABLE consent receipt for one subscriber — the document a person
 * exercising a subject-access right is actually handed.
 *
 *   GET /api/v1/subscribers/{id}/consent-receipt.json
 *       RequireScope(ScopeAdmin) → owner|admin ONLY on a session
 *       (consent_receipt_export.go:75; ScopeAdmin is absent from
 *       `readOnlyScopes`, apikeys/middleware.go:331-336).
 *
 * Lazy for a stronger reason than its two siblings above: this response
 * carries the subject's email AND their full consent history in one body, and
 * the handler is the export path — so firing it on profile open would perform
 * a full PII export every time somebody glanced at a profile. It runs only
 * when an owner/admin explicitly asks for the document.
 *
 * `parsePortableReceipt` returns null for a payload that carries neither a
 * subject nor a receipt id, and that null is passed through rather than
 * smoothed into an empty receipt: a compliance document that renders blank as
 * if it were real is the single worst outcome this surface could produce.
 */
export function usePortableConsentReceipt(
  subscriberId: string | undefined,
  open: boolean,
) {
  const gate = useOnlineQueryGate();
  return useQuery<PortableConsentReceipt | null>({
    queryKey: ["sub-portable-receipt", gate.tenantId, subscriberId],
    enabled: open && gate.enabled && Boolean(gate.tenantId && subscriberId),
    // A consent vector does not move while a support call is in progress, and
    // a repeat fetch is a repeat PII export. One read per profile visit.
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { client } = getClient();
      const res = await client.request<unknown>(
        "GET",
        `/api/v1/subscribers/${encodeURIComponent(subscriberId!)}/consent-receipt.json`,
      );
      return parsePortableReceipt(res);
    },
  });
}
