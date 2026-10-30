// SPDX-License-Identifier: MIT
import { Resource } from "./_base.js";

export interface InboundWebhookEndpoint {
  id: string;
  tenantId: string;
  slug: string;
  name: string;
  enabled: boolean;
  transform_jq?: string;
  createdAt: string;
}

export interface InboundWebhookCreateResponse {
  endpoint: InboundWebhookEndpoint;
  /** Plaintext signing secret. Returned exactly once. */
  secret: string;
}

export interface InboundWebhookListPage {
  items: InboundWebhookEndpoint[];
  next_cursor?: string | null;
}

export interface InboundWebhookEvent {
  id: number;
  endpoint_id: string;
  /** Diagnostic allow-list only; credential values are redacted before storage. */
  headers: Record<string, string>;
  body: string;
  signature_valid: boolean;
  received_at: string;
}

export interface InboundWebhookEventPage {
  items: InboundWebhookEvent[];
  next_cursor?: string | null;
}

export type InboundWebhookMatchOperator = "equals" | "contains" | "exists" | "regex";
export type InboundWebhookActionType =
  | "add_to_sequence"
  | "add_tag"
  | "remove_tag"
  | "start_automation";

export interface InboundWebhookTrigger {
  id: string;
  tenant_id: string;
  webhook_id: string;
  name: string;
  active: boolean;
  match_jsonpath: string;
  match_operator: InboundWebhookMatchOperator;
  match_value?: string;
  email_jsonpath: string;
  action_type: InboundWebhookActionType;
  action_target_id: string;
  fired_count: number;
  last_fired_at?: string;
  created_at: string;
  updated_at: string;
}

export interface InboundWebhookTriggerInput {
  name: string;
  active?: boolean;
  match_jsonpath: string;
  match_operator: InboundWebhookMatchOperator;
  match_value?: string;
  email_jsonpath: string;
  action_type: InboundWebhookActionType;
  action_target_id: string;
}

export interface InboundWebhookReplayResponse {
  ok: true;
  queued: true;
  replay_id: string;
  matches: Array<{
    trigger_id: string;
    name: string;
    subscriber_email: string;
    action_type: InboundWebhookActionType;
    action_target_id: string;
    queued?: boolean;
    executed: boolean;
    error?: string;
  }>;
}

export class InboundWebhooksResource extends Resource {
  list(params: { query?: string; limit?: number; cursor?: string } = {}): Promise<InboundWebhookListPage> {
    return this.client.request("GET", "/api/v1/inbound-webhooks", { query: params });
  }

  create(
    input: { name?: string; transform_jq?: string } = {},
  ): Promise<InboundWebhookCreateResponse> {
    return this.client.request("POST", "/api/v1/inbound-webhooks", { body: input });
  }

  get(id: string): Promise<InboundWebhookEndpoint> {
    return this.client.request("GET", `/api/v1/inbound-webhooks/${encodeURIComponent(id)}`);
  }

  update(
    id: string,
    patch: { name?: string; enabled?: boolean; transform_jq?: string },
  ): Promise<InboundWebhookEndpoint> {
    return this.client.request("PATCH", `/api/v1/inbound-webhooks/${encodeURIComponent(id)}`, {
      body: patch,
    });
  }

  rotate(id: string): Promise<InboundWebhookCreateResponse> {
    return this.client.request(
      "POST",
      `/api/v1/inbound-webhooks/${encodeURIComponent(id)}/rotate`,
    );
  }

  delete(id: string): Promise<{ ok: true } | void> {
    return this.client.request("DELETE", `/api/v1/inbound-webhooks/${encodeURIComponent(id)}`);
  }

  events(
    id: string,
    params: { limit?: number; cursor?: string } = {},
  ): Promise<InboundWebhookEventPage> {
    return this.client.request(
      "GET",
      `/api/v1/inbound-webhooks/${encodeURIComponent(id)}/events`,
      { query: params },
    );
  }

  replay(
    id: string,
    eventId: number | string,
    idempotencyKey?: string,
  ): Promise<InboundWebhookReplayResponse> {
    return this.client.request(
      "POST",
      `/api/v1/inbound-webhooks/${encodeURIComponent(id)}/events/${encodeURIComponent(String(eventId))}/replay`,
      { ...(idempotencyKey ? { idempotencyKey } : {}) },
    );
  }

  triggers(id: string): Promise<{ items: InboundWebhookTrigger[] }> {
    return this.client.request(
      "GET",
      `/api/v1/inbound-webhooks/${encodeURIComponent(id)}/triggers`,
    );
  }

  createTrigger(id: string, input: InboundWebhookTriggerInput): Promise<InboundWebhookTrigger> {
    return this.client.request(
      "POST",
      `/api/v1/inbound-webhooks/${encodeURIComponent(id)}/triggers`,
      { body: input },
    );
  }

  updateTrigger(
    id: string,
    triggerId: string,
    patch: Partial<InboundWebhookTriggerInput>,
  ): Promise<InboundWebhookTrigger> {
    return this.client.request(
      "PATCH",
      `/api/v1/inbound-webhooks/${encodeURIComponent(id)}/triggers/${encodeURIComponent(triggerId)}`,
      { body: patch },
    );
  }

  deleteTrigger(id: string, triggerId: string): Promise<{ ok: true } | void> {
    return this.client.request(
      "DELETE",
      `/api/v1/inbound-webhooks/${encodeURIComponent(id)}/triggers/${encodeURIComponent(triggerId)}`,
    );
  }

  previewTransform(transformJq: string, body: unknown): Promise<{ body: unknown }> {
    return this.client.request("POST", "/api/v1/inbound-webhooks/transform/preview", {
      body: { transform_jq: transformJq, body },
    });
  }
}
