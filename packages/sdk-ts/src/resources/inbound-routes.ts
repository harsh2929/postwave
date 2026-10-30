// SPDX-License-Identifier: MIT
import { Resource } from "./_base.js";

export interface InboundRouteAction {
  kind: "tag" | "automation_trigger" | "webhook" | "forward" | "store_only";
  tag?: string;
  event_type?: string;
  url?: string;
  to?: string;
  extra?: Record<string, unknown>;
}

export interface InboundRoute {
  id: string;
  name: string;
  priority: number;
  stop_on_match: boolean;
  enabled: boolean;
  match_recipient: string;
  match_subject_prefix?: string;
  match_from_domain?: string;
  actions: InboundRouteAction[];
  last_matched_at?: string | null;
  match_count: number;
}

export interface InboundRouteInput {
  name: string;
  priority?: number;
  stop_on_match?: boolean;
  enabled?: boolean;
  match_recipient: string;
  match_subject_prefix?: string;
  match_from_domain?: string;
  actions: InboundRouteAction[];
}

/**
 * Inbound routes — Mailgun-Routes-killer CRUD. Match rules walk in
 * ascending priority; the first stop_on_match=true rule short-
 * circuits. match_recipient supports a tiny shell-glob ("support@*",
 * "*@acme.com", "*").
 */
export class InboundRoutesResource extends Resource {
  list(): Promise<{ routes: InboundRoute[] }> {
    return this.client.request("GET", "/api/v1/inbound-routes");
  }

  create(input: InboundRouteInput): Promise<InboundRoute> {
    return this.client.request("POST", "/api/v1/inbound-routes", {
      body: input,
    });
  }

  patch(id: string, patch: Partial<InboundRouteInput>): Promise<InboundRoute> {
    return this.client.request(
      "PATCH",
      `/api/v1/inbound-routes/${encodeURIComponent(id)}`,
      { body: patch },
    );
  }

  delete(id: string): Promise<{ deleted: boolean }> {
    return this.client.request(
      "DELETE",
      `/api/v1/inbound-routes/${encodeURIComponent(id)}`,
    );
  }
}
