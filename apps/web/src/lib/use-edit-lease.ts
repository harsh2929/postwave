"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { api, ApiError } from "@/lib/api";

/**
 * Hold the single-writer editing lease while a campaign editor is open.
 *
 * The server rule (migration 1877) has been enforced on eight write paths and
 * held by nobody: `campaign_edit_leases` was never written in production, so
 * every check passed trivially. A mechanism nothing invokes protects nothing —
 * which is the failure this whole ledger keeps catching, and which the lease
 * work itself committed twice before this.
 *
 * WHAT THIS DOES NOT DO: block the UI. A lease is advisory. If someone else
 * holds it the editor stays readable and the fields stay visible — what changes
 * is that the person is TOLD, immediately, rather than after writing a change
 * the server will refuse. Hiding the content would be a worse product for a
 * guarantee the lease does not make.
 */

/** Matches the server's `DefaultEditLeaseTTL` (2 minutes). */
const LEASE_TTL_MS = 2 * 60_000;

/**
 * Renew at a third of the TTL.
 *
 * Not half: a single missed request — a sleeping laptop, one dropped packet, a
 * slow round trip — would then lapse the lease mid-edit and hand the campaign
 * to someone else while the first person is still typing. Three attempts inside
 * the window means two have to fail before that happens.
 */
const RENEW_EVERY_MS = LEASE_TTL_MS / 3;

export interface EditLeaseHolder {
  label?: string;
  since?: string;
  expires_at?: string;
}

export interface EditLeaseState {
  /** True while this tab holds the lease. */
  held: boolean;
  /** Set when SOMEONE ELSE holds it. */
  blockedBy: EditLeaseHolder | null;
  /** True until the first acquire attempt settles. */
  checking: boolean;
}

interface LeaseErrorBody {
  error?: { code?: string; holder?: EditLeaseHolder };
}

export function useEditLease(campaignId: string | undefined): EditLeaseState {
  const [state, setState] = useState<EditLeaseState>({
    held: false,
    blockedBy: null,
    checking: true,
  });
  // Tracks whether this mount is still current, so a response arriving after
  // the editor closed cannot resurrect its state or re-arm the timer.
  const liveRef = useRef(true);

  const acquire = useCallback(async (id: string) => {
    try {
      await api.post(`/api/v1/campaigns/${encodeURIComponent(id)}/edit-lease`);
      if (liveRef.current) setState({ held: true, blockedBy: null, checking: false });
    } catch (err) {
      if (!liveRef.current) return;
      // 409 means someone else is editing — a fact about the workspace, not a
      // failure. Anything else (offline, 500) leaves the editor usable: the
      // server still enforces the rule, and refusing to let someone type
      // because a lease call failed would be a worse outcome than the collision
      // it is guarding against.
      const body = (err as ApiError)?.body as LeaseErrorBody | undefined;
      if ((err as ApiError)?.status === 409) {
        setState({
          held: false,
          blockedBy: body?.error?.holder ?? {},
          checking: false,
        });
        return;
      }
      setState({ held: false, blockedBy: null, checking: false });
    }
  }, []);

  useEffect(() => {
    if (!campaignId) return;
    liveRef.current = true;
    void acquire(campaignId);
    const timer = window.setInterval(() => void acquire(campaignId), RENEW_EVERY_MS);

    return () => {
      liveRef.current = false;
      window.clearInterval(timer);
      // Release on the way out so the next editor does not wait out the TTL.
      // Best-effort and deliberately unawaited: a navigation must not be held
      // up by it, and the TTL is the backstop if it never lands.
      void api
        .delete(`/api/v1/campaigns/${encodeURIComponent(campaignId)}/edit-lease`)
        .catch(() => undefined);
    };
  }, [campaignId, acquire]);

  return state;
}
