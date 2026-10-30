/**
 * api/workspaceSetup.ts — the two desktop Settings sections mobile never had
 * (SHELL#24): the Slack WORKSPACE connection (the approval bot, distinct from
 * the Slack incoming-webhook integrations the Integrations tab lists) and the
 * sample-data seeder.
 *
 * AUTHORIZATION, read off the handlers rather than the manifest:
 *
 *   GET/DELETE /api/v1/integrations/slack-workspace
 *     apps/api/internal/server/collaboration_integrations.go:42-43 mounts both
 *     under apikeys.RequireScope(apikeys.ScopeAdmin). On the session path that
 *     middleware (apikeys/middleware.go:211) resolves ScopeAdmin through
 *     requireAdminRoleForScopes → sessionRoleAllowsScopes, i.e. owner|admin.
 *     Handlers: slackint/handlers.go:209 and :228.
 *
 *   GET /api/v1/integrations/slack/availability
 *     collaboration_integrations.go:45 — mounted WITHOUT the admin wrapper, so
 *     any authenticated tenant principal may read it. Returns
 *     {requires_session, configured}; `configured:false` means the deployment
 *     has no SLACK_CLIENT_ID and no connect flow can work anywhere.
 *
 *   GET /api/v1/onboarding/sample-data      main.go:4398 — no scope wrapper,
 *                                           read-only, any tenant principal.
 *   POST/DELETE /api/v1/onboarding/sample-data
 *                                           main.go:4399-4402, both wrapped in
 *                                           RequireScope(ScopeAdmin) → owner|admin.
 *
 * WHAT IS NOT HERE, AND WHY. There is no `connectSlackWorkspace()`. The connect
 * flow is GET /api/v1/slack/oauth/start, which (a) is itself admin-scoped and
 * answers with a 302 the caller must follow in a REAL BROWSER, and (b) ends at
 * a callback whose success redirect is a deployment-level env value that
 * `safeOAuthSuccessRedirect` (slackint/oauth.go:299) restricts to https — a
 * `moosewave://` return is rejected outright, so `openAuthSessionAsync` would
 * never regain control and the sheet would never close itself. Mobile's own
 * credentials do not help either: the client authenticates with an apiKey
 * header or `credentials: "include"` cookies on RN's fetch
 * (src/api/sdkClient.ts:206-216), and neither reaches the system browser's
 * cookie store. The API's own comment on AvailabilityHandler says the same
 * thing and describes desktop's answer — send the operator to the dashboard in
 * a browser. That is what the UI does instead of offering a dead button.
 */
import { rawRequest, type AIApiResult } from "./request";

/** Mirrors slackint.WorkspaceConnectionStatus (slackint.go:134). */
export interface SlackWorkspaceConnection {
  connected: boolean;
  id?: string;
  slack_team_id?: string;
  slack_team_name?: string;
  default_channel_id?: string;
  default_channel_name?: string;
  created_at?: string;
  updated_at?: string;
}

/** Mirrors the AvailabilityHandler body (slackint/oauth.go:205). */
export interface SlackAvailability {
  requires_session: boolean;
  configured: boolean;
}

/** Mirrors onboarding.Counts (sample_data.go:61). */
export interface SampleDataCounts {
  subscribers: number;
  lists: number;
  segments: number;
  campaigns: number;
  sequences: number;
}

/** Mirrors onboarding.StatusResult (sample_data.go:270). */
export interface SampleDataStatus {
  seeded: boolean;
  seeded_at?: string;
  counts?: SampleDataCounts;
}

/** Mirrors onboarding.SeedResult / RemoveResult (sample_data.go:70, :78). */
export interface SampleDataMutation {
  seeded?: boolean;
  removed?: boolean;
  counts?: SampleDataCounts;
  note?: string;
}

export function getSlackWorkspaceConnection(): Promise<
  AIApiResult<SlackWorkspaceConnection>
> {
  return rawRequest<SlackWorkspaceConnection>(
    "GET",
    "/api/v1/integrations/slack-workspace",
  );
}

export function disconnectSlackWorkspace(): Promise<
  AIApiResult<{ ok: boolean; deleted: boolean }>
> {
  return rawRequest<{ ok: boolean; deleted: boolean }>(
    "DELETE",
    "/api/v1/integrations/slack-workspace",
  );
}

export function getSlackAvailability(): Promise<AIApiResult<SlackAvailability>> {
  return rawRequest<SlackAvailability>(
    "GET",
    "/api/v1/integrations/slack/availability",
  );
}

export function getSampleDataStatus(): Promise<AIApiResult<SampleDataStatus>> {
  return rawRequest<SampleDataStatus>("GET", "/api/v1/onboarding/sample-data");
}

export function seedSampleData(): Promise<AIApiResult<SampleDataMutation>> {
  return rawRequest<SampleDataMutation>("POST", "/api/v1/onboarding/sample-data");
}

export function removeSampleData(): Promise<AIApiResult<SampleDataMutation>> {
  return rawRequest<SampleDataMutation>(
    "DELETE",
    "/api/v1/onboarding/sample-data",
  );
}
