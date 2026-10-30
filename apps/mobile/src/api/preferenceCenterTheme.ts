/**
 * api/preferenceCenterTheme.ts — GET/PATCH the hosted preference-centre theme.
 *
 *   GET   /api/v1/privacy/portal/preference-center
 *   PATCH /api/v1/privacy/portal/preference-center
 *
 * Both are `session_minimum_role: admin` in apps/api/internal/routeauth/
 * manifest.json, mounted at apps/api/internal/privacy_portal/handlers.go:75-77.
 * PUT is the same handler as PATCH; we send PATCH, exactly as desktop's
 * api-client does, because the handler treats it as a full replace either way.
 *
 * ONLINE-ONLY, never the offline outbox. This writes the chrome of a page real
 * subscribers load. A queued theme replayed hours later would repaint that page
 * out of the operator's sight, and — because the PATCH is a full replace — would
 * also overwrite anything saved from another client in between.
 */
import {
  parsePreferenceCenterTheme,
  preferenceThemePayload,
  type PreferenceCenterTheme,
} from "@/lib/preferenceCenterTheme";

import { rawRequest, type AIApiResult } from "./request";

const PATH = "/api/v1/privacy/portal/preference-center";

export async function getPreferenceCenterTheme(): Promise<
  AIApiResult<PreferenceCenterTheme>
> {
  const res = await rawRequest<unknown>("GET", PATH);
  if (res.error) return { data: null, error: res.error };
  return { data: parsePreferenceCenterTheme(res.data), error: null };
}

/**
 * Save the whole theme. The response body IS the acknowledged row, so the
 * caller can adopt it as the new baseline without a second GET — which matters
 * here because the server normalises what it stored (an empty colour comes back
 * as the default, a trimmed URL comes back trimmed).
 */
export async function savePreferenceCenterTheme(
  theme: PreferenceCenterTheme,
): Promise<AIApiResult<PreferenceCenterTheme>> {
  const res = await rawRequest<unknown>(
    "PATCH",
    PATH,
    preferenceThemePayload(theme),
  );
  if (res.error) return { data: null, error: res.error };
  return { data: parsePreferenceCenterTheme(res.data), error: null };
}
