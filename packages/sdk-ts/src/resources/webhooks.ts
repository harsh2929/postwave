// SPDX-License-Identifier: MIT
import { Resource } from "./_base.js";
import type {
  WebhookEventType,
  WebhookSubscription,
  WebhookSubscriptionInput,
  WebhookSubscriptionUpdate,
} from "../types.js";
import { verifySignature as _verifySignature } from "../webhook.js";

export interface WebhookListPage {
  webhooks: WebhookSubscription[];
  next_cursor?: string | null;
}

export interface WebhookCreateResponse {
  webhook: WebhookSubscription;
  /** HMAC signing secret. Returned exactly once at create/rotation time. */
  signing_secret?: string;
  /** Asymmetric private key. Returned exactly once at create/rotation time. */
  private_key_pem?: string;
  public_key_pem?: string;
}

export interface WebhookDelivery {
  id: string;
  webhook_id: string;
  event_type: WebhookEventType | "webhook.test";
  attempt_count: number;
  next_attempt_at?: string | null;
  status: "pending" | "delivered" | "failed" | "exhausted";
  last_status_code?: number | null;
  last_response_body_truncated?: string;
  last_error?: string;
  created_at: string;
  delivered_at?: string | null;
}

export interface WebhookDeliveryPage {
  deliveries: WebhookDelivery[];
  next_cursor?: string | null;
}

export interface WebhookTestResult {
  webhook_id: string;
  status_code: number;
  signed: boolean;
  signature?: string;
  key_ids?: string;
  response?: string;
  error?: string;
  filtered?: boolean;
  redaction_applied?: boolean;
}

export interface WebhookReplayResponse {
  delivery_id: string;
  replayed_from: string;
  status: "pending";
  replayed_at: string;
}

export class WebhooksResource extends Resource {
  /** Canonical outbound-webhooks collection. */
  list(params: { query?: string; limit?: number; cursor?: string } = {}): Promise<WebhookListPage> {
    return this.client.request("GET", "/api/v1/outbound-webhooks", { query: params });
  }

  /**
   * Create an outbound destination. Persist the one-shot signing material in
   * the response before discarding it. Receiver-auth credential values are
   * write-only and are never returned by later reads.
   */
  create(input: WebhookSubscriptionInput): Promise<WebhookCreateResponse> {
    return this.client.request("POST", "/api/v1/outbound-webhooks", { body: input });
  }

  update(id: string, patch: WebhookSubscriptionUpdate): Promise<WebhookSubscription> {
    return this.client.request("PATCH", `/api/v1/outbound-webhooks/${encodeURIComponent(id)}`, {
      body: patch,
    });
  }

  delete(id: string, options: { soft?: boolean } = {}): Promise<{ ok?: boolean } | void> {
    return this.client.request("DELETE", `/api/v1/outbound-webhooks/${encodeURIComponent(id)}`, {
      query: options.soft ? { soft: 1 } : undefined,
    });
  }

  /** Sends the canonical `webhook.test` envelope. */
  test(id: string): Promise<WebhookTestResult> {
    return this.client.request("POST", `/api/v1/outbound-webhooks/${encodeURIComponent(id)}/test`);
  }

  deliveriesList(
    id: string,
    params: { limit?: number; cursor?: string } = {},
  ): Promise<WebhookDeliveryPage> {
    return this.client.request(
      "GET",
      `/api/v1/outbound-webhooks/${encodeURIComponent(id)}/deliveries`,
      { query: params },
    );
  }

  async deliveries(id: string): Promise<WebhookDelivery[]> {
    return (await this.deliveriesList(id)).deliveries;
  }

  /**
   * Creates a new pending child delivery and leaves the original immutable.
   * Reuse idempotencyKey when retrying this logical replay across processes.
   */
  replay(deliveryId: string, idempotencyKey?: string): Promise<WebhookReplayResponse> {
    return this.client.request(
      "POST",
      `/api/v1/outbound-webhooks/deliveries/${encodeURIComponent(deliveryId)}/replay`,
      { ...(idempotencyKey ? { idempotencyKey } : {}) },
    );
  }

  rotateSecret(id: string, graceMinutes = 1440): Promise<WebhookCreateResponse> {
    return this.client.request(
      "POST",
      `/api/v1/outbound-webhooks/${encodeURIComponent(id)}/rotate-secret`,
      { query: { grace_minutes: graceMinutes } },
    );
  }

  verifySignature(
    rawBody: string | Uint8Array,
    header: string | null | undefined,
    secret: string,
    options?: { now?: Date | number; toleranceSeconds?: number },
  ): Promise<boolean> {
    return _verifySignature(rawBody, header, secret, options);
  }
}
