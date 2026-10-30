/**
 * useSmsReplyHolds — the inbox's view of the single encrypted reply-intent
 * slot, plus which VISIBLE conversation carries it.
 *
 * Not react-query: the source is SecureStore, not the network, and the value
 * must never be shared across identities through a cache. The hook re-reads
 * on focus/identity change and hashes only the phones the inbox is already
 * displaying (the store exposes hashes, never a phone — see
 * `inspectSmsReplyIntentForIdentity`).
 */
import { useEffect, useState } from "react";

import type { SmsInboxAccess } from "@/hooks/useSmsInbox";
import {
  inspectSmsReplyIntentForIdentity,
  smsReplyThreadHash,
  type SmsInboxHoldSummary,
} from "@/lib/smsReplyIntentStore";

const MAX_MATCH_CANDIDATES = 200;

export function useSmsReplyHolds(
  access: SmsInboxAccess,
  visiblePhones: readonly string[],
): { summary: SmsInboxHoldSummary; matchedPhone: string | null } {
  const [summary, setSummary] = useState<SmsInboxHoldSummary>({
    status: "none",
  });
  const [matchedPhone, setMatchedPhone] = useState<string | null>(null);
  const fingerprint = access.identity?.fingerprint ?? null;
  // A string dependency, so a re-render with an equal page set re-hashes
  // nothing.
  const phoneKey = visiblePhones.slice(0, MAX_MATCH_CANDIDATES).join(",");

  useEffect(() => {
    let active = true;
    if (!access.roleAllowed || !fingerprint) {
      setSummary({ status: "none" });
      setMatchedPhone(null);
      return () => {
        active = false;
      };
    }
    void (async () => {
      const next = await inspectSmsReplyIntentForIdentity(fingerprint);
      if (!active) return;
      setSummary(next);
      if (next.status !== "held") {
        setMatchedPhone(null);
        return;
      }
      const phones = phoneKey === "" ? [] : phoneKey.split(",");
      for (const phone of phones) {
        let hash: string;
        try {
          hash = await smsReplyThreadHash(phone);
        } catch {
          break;
        }
        if (!active) return;
        if (hash === next.threadHash) {
          setMatchedPhone(phone);
          return;
        }
      }
      if (active) setMatchedPhone(null);
    })();
    return () => {
      active = false;
    };
  }, [access.roleAllowed, fingerprint, phoneKey]);

  return { summary, matchedPhone };
}
