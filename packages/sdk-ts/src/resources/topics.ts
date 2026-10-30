// SPDX-License-Identifier: MIT
import { Resource } from "./_base.js";

export interface Topic {
  id: string;
  tenantId: string;
  slug: string;
  name: string;
  description?: string;
  defaultOptIn: boolean;
  displayOrder?: number;
  createdAt: string;
  updatedAt: string;
}

export interface TopicCreateInput {
  slug: string;
  name: string;
  description?: string;
  default_opt_in?: boolean;
  display_order?: number;
}

/**
 * Topic preference management. Mirrors the per-topic opt-in surface used by
 * the hosted preference page, but exposed as agent-callable primitives so an
 * MCP client can manage topics + per-subscriber subscriptions directly.
 */
export class TopicsResource extends Resource {
  list(): Promise<Topic[]> {
    return this.client.request("GET", "/api/v1/topics");
  }

  create(input: TopicCreateInput): Promise<Topic> {
    return this.client.request("POST", "/api/v1/topics", { body: input });
  }

  delete(id: string): Promise<{ ok: boolean }> {
    return this.client.request(
      "DELETE",
      `/api/v1/topics/${encodeURIComponent(id)}`,
    );
  }

  subscribe(subscriberEmail: string, topicId: string): Promise<{ ok: boolean }> {
    return this.client.request(
      "POST",
      `/api/v1/subscribers/${encodeURIComponent(subscriberEmail)}/topics/${encodeURIComponent(topicId)}/subscribe`,
    );
  }

  unsubscribe(subscriberEmail: string, topicId: string): Promise<{ ok: boolean }> {
    return this.client.request(
      "POST",
      `/api/v1/subscribers/${encodeURIComponent(subscriberEmail)}/topics/${encodeURIComponent(topicId)}/unsubscribe`,
    );
  }
}
