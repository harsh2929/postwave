// SPDX-License-Identifier: MIT
import { Resource } from "./_base.js";

export interface TrackInput {
  subscriber_id?: string;
  email?: string;
  event_name: string;
  properties?: Record<string, unknown>;
  occurred_at?: string;
}

export interface TrackResponse {
  id: number;
  subscriber_id: string;
}

export interface ProductEvent {
  id: number;
  tenantId: string;
  subscriberId: string;
  eventName: string;
  properties: Record<string, unknown>;
  occurredAt: string;
  receivedAt: string;
}

export interface ProductEventListPage {
  items: ProductEvent[];
}

export class TrackResource extends Resource {
  /** Record a product event for a subscriber. Pass either subscriber_id or email. */
  track(input: TrackInput): Promise<TrackResponse> {
    return this.client.request("POST", "/api/v1/track", { body: input });
  }

  listEvents(params: { subscriber_id: string; limit?: number }): Promise<ProductEventListPage> {
    return this.client.request("GET", "/api/v1/track/events", {
      query: { subscriber_id: params.subscriber_id, limit: params.limit },
    });
  }
}
