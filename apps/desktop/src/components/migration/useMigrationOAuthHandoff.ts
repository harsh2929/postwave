import { type Dispatch, type RefObject, type SetStateAction } from "react";

import { type MigrationSource } from "../../lib/api-client";
import { getDashboardUrl } from "../../lib/dashboard-url";
import { migrationOAuthDelegationURL } from "../../lib/migration-oauth-handoff";
import { tauriApi } from "../../lib/tauri";

interface MigrationOAuthHandoffBindings {
  oauthHandoffGenerationRef: RefObject<number>;
  oauthPollRef: RefObject<number | null>;
  stopOAuthHandoff: (updateState?: boolean) => void;
  setBusy: Dispatch<SetStateAction<boolean>>;
  setOAuthWaiting: Dispatch<SetStateAction<boolean>>;
  setStepError: Dispatch<SetStateAction<string | null>>;
}

export function useMigrationOAuthHandoff({
  oauthHandoffGenerationRef,
  oauthPollRef,
  stopOAuthHandoff,
  setBusy,
  setOAuthWaiting,
  setStepError,
}: MigrationOAuthHandoffBindings): (source: MigrationSource) => Promise<void> {
  return async (apiSource: MigrationSource): Promise<void> => {
    stopOAuthHandoff();
    const generation = oauthHandoffGenerationRef.current;
    setBusy(true);
    setStepError(null);
    const dashboard = migrationOAuthDelegationURL(getDashboardUrl(), apiSource);
    try {
      await tauriApi.openUrl(dashboard);
    } catch {
      if (oauthHandoffGenerationRef.current !== generation) return;
      setBusy(false);
      setStepError(
        "The secure browser authorization page could not be opened. No provider credential was received by the desktop client; retry when ready.",
      );
      return;
    }
    if (oauthHandoffGenerationRef.current !== generation) return;
    setBusy(false);
    setOAuthWaiting(true);
    // Keep the standard cancellation owner wired so closing/restarting the
    // wizard invalidates this local attempt. No interval is created and no
    // tenant-wide job is ever inferred or claimed.
    oauthPollRef.current = null;
  };
}
