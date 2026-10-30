// SPDX-License-Identifier: MIT
import { Resource } from "./_base.js";

export interface Topic {
  id: string;
  tenantId: string;
  slug: string;
  name: string;
  description?: string;
  defaultOptIn: boolean;
  displayOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTopicInput {
  slug: string;
  name: string;
  description?: string;
  defaultOptIn: boolean;
  displayOrder: number;
}

export interface UpdateTopicInput {
  slug?: string;
  name?: string;
  description?: string;
  defaultOptIn?: boolean;
  displayOrder?: number;
}

export interface SubscriberTopicView {
  topic: Topic;
  optedIn: boolean;
}

export interface TopicOptIn {
  topicId: string;
  optedIn: boolean;
}

export interface PreferenceLookupResponse {
  email: string;
  expiresAt: string;
  topics: SubscriberTopicView[];
}

export class PreferencesResource extends Resource {
  listTopics(): Promise<Topic[]> {
    return this.client.request("GET", "/api/v1/topics");
  }

  createTopic(input: CreateTopicInput): Promise<Topic> {
    return this.client.request("POST", "/api/v1/topics", { body: input });
  }

  updateTopic(id: string, patch: UpdateTopicInput): Promise<Topic> {
    return this.client.request("PATCH", `/api/v1/topics/${encodeURIComponent(id)}`, { body: patch });
  }

  deleteTopic(id: string): Promise<{ ok: boolean }> {
    return this.client.request("DELETE", `/api/v1/topics/${encodeURIComponent(id)}`);
  }

  listSubscriberTopics(email: string): Promise<SubscriberTopicView[]> {
    return this.client.request(
      "GET",
      `/api/v1/subscribers/${encodeURIComponent(email)}/topics`,
    );
  }

  setSubscriberTopics(email: string, topics: TopicOptIn[]): Promise<{ ok: boolean }> {
    return this.client.request(
      "PUT",
      `/api/v1/subscribers/${encodeURIComponent(email)}/topics`,
      { body: { topics } },
    );
  }

  /** Public token-gated lookup used by the hosted preference page. */
  publicLookup(token: string): Promise<PreferenceLookupResponse> {
    return this.client.request(
      "GET",
      `/api/public/preferences/${encodeURIComponent(token)}`,
    );
  }

  /** Public token-gated update used by the hosted preference page. */
  publicUpdate(token: string, topics: TopicOptIn[]): Promise<{ ok: boolean }> {
    return this.client.request(
      "POST",
      `/api/public/preferences/${encodeURIComponent(token)}`,
      { body: { topics } },
    );
  }
}
