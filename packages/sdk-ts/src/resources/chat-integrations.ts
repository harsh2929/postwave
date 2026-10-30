// SPDX-License-Identifier: MIT
import { Resource } from "./_base.js";
import type { PostwaveClient } from "../client.js";

export type ChatIntegrationProvider = "slack" | "discord" | "teams";

export interface ChatIntegration {
  id: string;
  tenant_id: string;
  channel_hint?: string;
  events: string[];
  enabled: boolean;
  last_delivery_status?: "success" | "failed" | string;
  last_delivery_at?: string | null;
  last_delivery_error?: string;
  created_at: string;
  updated_at: string;
}

export interface ChatIntegrationCreateInput {
  url: string;
  channel_hint?: string;
  events: string[];
}

export interface ChatIntegrationUpdateInput {
  url?: string;
  channel_hint?: string;
  events?: string[];
  enabled?: boolean;
}

export class ChatIntegrationChannelResource extends Resource {
  readonly provider: ChatIntegrationProvider;
  private readonly basePath: string;

  constructor(client: PostwaveClient, provider: ChatIntegrationProvider) {
    super(client);
    this.provider = provider;
    this.basePath = `/api/v1/integrations/${provider}`;
  }

  list(): Promise<ChatIntegration[]> {
    return this.client.request("GET", this.basePath);
  }

  create(input: ChatIntegrationCreateInput): Promise<ChatIntegration> {
    return this.client.request("POST", this.basePath, { body: input });
  }

  update(id: string, input: ChatIntegrationUpdateInput): Promise<ChatIntegration> {
    return this.client.request(
      "PATCH",
      `${this.basePath}/${encodeURIComponent(id)}`,
      { body: input },
    );
  }

  delete(id: string): Promise<{ ok: boolean }> {
    return this.client.request(
      "DELETE",
      `${this.basePath}/${encodeURIComponent(id)}`,
    );
  }
}

export class ChatIntegrationsResource {
  readonly slack: ChatIntegrationChannelResource;
  readonly discord: ChatIntegrationChannelResource;
  readonly teams: ChatIntegrationChannelResource;

  constructor(client: PostwaveClient) {
    this.slack = new ChatIntegrationChannelResource(client, "slack");
    this.discord = new ChatIntegrationChannelResource(client, "discord");
    this.teams = new ChatIntegrationChannelResource(client, "teams");
  }

  forProvider(provider: ChatIntegrationProvider): ChatIntegrationChannelResource {
    switch (provider) {
      case "slack":
        return this.slack;
      case "discord":
        return this.discord;
      case "teams":
        return this.teams;
    }
  }
}
