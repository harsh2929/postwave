// SPDX-License-Identifier: AGPL-3.0-only
import { api } from "./api";

export interface ChatIntegration {
  id: string;
  tenant_id: string;
  channel_hint?: string;
  events: string[];
  enabled: boolean;
  last_delivery_status?: "success" | "failed";
  last_delivery_at?: string;
  last_delivery_error?: string;
  created_at: string;
  updated_at: string;
}

export interface ChatIntegrationCreateInput {
  url: string;
  events: string[];
  channel_hint?: string;
}

// INTG-033 Slice B: one logged delivery attempt.
export interface ChatDelivery {
  id: string;
  provider: string;
  integration_id: string;
  event_type: string;
  status: "success" | "failed";
  error?: string;
  created_at: string;
}

// Slack / Discord / Teams share the same shape — they're three flavours
// of "incoming-webhook URL + event list". The only difference is the
// expected URL pattern. The admin UI doesn't need to know that.
function makeChatIntegrationApi(provider: "slack" | "discord" | "teams") {
  const base = `/api/v1/integrations/${encodeURIComponent(provider)}`;
  return {
    list: (options?: { signal?: AbortSignal }) =>
      api.get<ChatIntegration[]>(base, {
        ...options,
        requireOnline: true,
        maxAttempts: 1,
      }),
    create: (input: ChatIntegrationCreateInput) =>
      api.post<ChatIntegration>(base, input),
    update: (id: string, patch: Partial<ChatIntegration> & { url?: string }) =>
      api.patch<ChatIntegration>(`${base}/${encodeURIComponent(id)}`, patch),
    delete: (id: string) =>
      api.delete<{ ok: boolean }>(`${base}/${encodeURIComponent(id)}`),
    // INTG-033: deliver a synthetic test notification to the webhook.
    test: (id: string) =>
      api.post<{ ok: boolean; error?: string }>(
        `${base}/${encodeURIComponent(id)}/test`,
      ),
    // INTG-033 Slice B: recent delivery history for one integration.
    deliveries: (id: string) =>
      api
        .get<{
          items: ChatDelivery[];
        }>(`${base}/${encodeURIComponent(id)}/deliveries`)
        .then((r) => (Array.isArray(r.items) ? r.items : [])),
  };
}

export const slackIntegrationsApi = makeChatIntegrationApi("slack");
export const discordIntegrationsApi = makeChatIntegrationApi("discord");
export const teamsIntegrationsApi = makeChatIntegrationApi("teams");

// ---------------------------------------------------------------------------
// Slack *workspace* (OAuth bot) connection — distinct from the webhook-URL
// chat integrations above. Backend: apps/api/internal/slackint/{oauth,handlers}.go.
//   GET    /api/v1/integrations/slack/availability  → install prerequisites
//   GET    /api/v1/integrations/slack-workspace      → current connection
//   DELETE /api/v1/integrations/slack-workspace      → revoke
//   GET    /api/v1/slack/oauth/start                 → 302 to Slack (browser nav)
// The OAuth start route is a session-cookie 302 redirect, so the UI must
// navigate the browser to it (window.location) rather than fetch it.
// ---------------------------------------------------------------------------

/** Path the browser navigates to in order to begin the Slack OAuth install. */
export const SLACK_OAUTH_START_PATH = "/api/v1/slack/oauth/start";

export interface SlackAvailability {
  requires_session: boolean;
  /** false when this deployment has no SLACK_CLIENT_ID — install will 503. */
  configured: boolean;
}

export interface SlackWorkspaceStatus {
  connected: boolean;
  id?: string;
  slack_team_id?: string;
  slack_team_name?: string;
  default_channel_id?: string;
  default_channel_name?: string;
  created_at?: string;
  updated_at?: string;
}

export const slackWorkspaceApi = {
  availability: () =>
    api.get<SlackAvailability>("/api/v1/integrations/slack/availability"),
  status: () =>
    api.get<SlackWorkspaceStatus>("/api/v1/integrations/slack-workspace"),
  disconnect: () =>
    api.delete<{ ok: boolean; deleted: boolean }>(
      "/api/v1/integrations/slack-workspace",
    ),
};

export const ALL_EVENT_TYPES = [
  "subscriber.created",
  "subscriber.updated",
  "subscriber.unsubscribed",
  "subscriber.bounced",
  "subscriber.complained",
  "campaign.sent",
  "campaign.opens.digest",
  "campaign.clicks.digest",
  "form.submitted",
  "form.confirmed",
  "automation.completed",
  "automation.failed",
  "migration.completed",
  "migration.failed",
  "sequence.generated",
] as const;
