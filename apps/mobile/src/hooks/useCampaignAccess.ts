/**
 * hooks/useCampaignAccess.ts — the one place a campaign screen asks
 * "may this person do this, right now?".
 *
 * Folds connectivity, session freshness and the workspace role into a single
 * decision (see src/lib/campaignAccess.ts for the rules and their tests).
 * Before this, every campaign action was gated on connectivity alone, so a
 * read-only viewer saw Send now and Delete at full strength and learned
 * otherwise from a 403.
 */
import { useMemo } from "react";

import { useIsOnline } from "@/hooks/useIsOnline";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { campaignAccess, type CampaignAccess } from "@/lib/campaignAccess";

export function useCampaignAccess(options: {
  /** False when a CachedSessionNotice is being rendered for this surface. */
  sessionUsable: boolean;
}): CampaignAccess {
  const online = useIsOnline();
  const gate = useOnlineQueryGate();
  const role = gate.effectiveRole;
  const sessionUsable = options.sessionUsable;
  return useMemo(
    () => campaignAccess({ online, sessionUsable, effectiveRole: role }),
    [online, sessionUsable, role],
  );
}
