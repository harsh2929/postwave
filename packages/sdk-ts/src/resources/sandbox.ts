// SPDX-License-Identifier: MIT
import { Resource } from "./_base.js";

export interface SandboxEvent {
  ts: string;
  event_type: string;
  recipient_email: string;
  metadata?: Record<string, unknown>;
}

export interface SandboxStatus {
  campaign_id: string;
  state: "scheduled" | "running" | "completed";
  scheduled_remaining: number;
  events: SandboxEvent[];
}

export class SandboxResource extends Resource {
  status(campaignId: string): Promise<SandboxStatus> {
    return this.client.request(
      "GET",
      `/api/v1/sandbox/campaigns/${encodeURIComponent(campaignId)}/status`,
    );
  }
}
