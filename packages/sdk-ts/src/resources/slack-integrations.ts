// SPDX-License-Identifier: MIT
import { Resource } from "./_base.js";

/**
 * Slack incoming-webhook integrations.
 *
 * The URL is envelope-encrypted server-side; reads only return the
 * channel hint + delivery status. Pass it once on `create()`; if you
 * need to rotate it, `update({ url })`.
 */
export interface SlackIntegration {
  id: string;
  tenant_id: string;
  /** Optional operator-visible label (e.g. "#marketing-alerts"). */
  channel_hint?: string;
  events: string[];
  enabled: boolean;
  last_delivery_status?: "success" | "failed";
  last_delivery_at?: string;
  last_delivery_error?: string;
  created_at: string;
  updated_at: string;
}

export interface CreateSlackIntegrationInput {
  /**
   * Slack incoming-webhook URL (https://hooks.slack.com/services/T.../B.../xxx).
   * Stored envelope-encrypted; never returned by reads.
   */
  url: string;
  channel_hint?: string;
  events: string[];
}

export interface UpdateSlackIntegrationInput {
  url?: string;
  channel_hint?: string;
  events?: string[];
  enabled?: boolean;
}

export class SlackIntegrationsResource extends Resource {
  list(): Promise<SlackIntegration[]> {
    return this.client.request("GET", "/api/v1/integrations/slack");
  }

  create(input: CreateSlackIntegrationInput): Promise<SlackIntegration> {
    return this.client.request("POST", "/api/v1/integrations/slack", { body: input });
  }

  update(id: string, input: UpdateSlackIntegrationInput): Promise<SlackIntegration> {
    return this.client.request(
      "PATCH",
      `/api/v1/integrations/slack/${encodeURIComponent(id)}`,
      { body: input },
    );
  }

  delete(id: string): Promise<{ ok: boolean }> {
    return this.client.request(
      "DELETE",
      `/api/v1/integrations/slack/${encodeURIComponent(id)}`,
    );
  }
}
