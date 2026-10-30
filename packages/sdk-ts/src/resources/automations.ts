// SPDX-License-Identifier: MIT
import { Resource } from "./_base.js";
import type { AutomationExecution, AutomationTriggerInput } from "../types.js";

export interface AutomationNode {
  id: string;
  type: string;
  config?: Record<string, unknown>;
}

export interface AutomationEdge {
  from: string;
  to: string;
  branch?: string;
}

export interface AutomationTriggerSpec {
  type: string;
  config?: Record<string, unknown>;
}

export interface Automation {
  id: string;
  name: string;
  status: "draft" | "active" | "paused";
  triggers: AutomationTriggerSpec[];
  nodes: AutomationNode[];
  edges: AutomationEdge[];
  created_at?: string;
  updated_at?: string;
}

export interface CreateAutomationInput {
  name: string;
  triggers: AutomationTriggerSpec[];
  nodes: AutomationNode[];
  edges: AutomationEdge[];
}

export interface UpdateAutomationInput {
  name?: string;
  status?: "draft" | "active" | "paused";
  triggers?: AutomationTriggerSpec[];
  nodes?: AutomationNode[];
  edges?: AutomationEdge[];
}

export interface AutomationListPage {
  items: Automation[];
  next_cursor?: string | null;
}

export interface BehavioralTriggerInput {
  trigger_type:
    | "campaign_opened"
    | "campaign_not_opened"
    | "link_clicked"
    | "no_link_clicked"
    | "page_visited"
    | "no_activity";
  campaign_id?: string;
  url_pattern?: string;
  within_days?: number;
  after_days?: number;
}

export interface BehavioralTrigger extends BehavioralTriggerInput {
  id: string;
  automation_id: string;
  created_at: string;
}

export class AutomationsResource extends Resource {
  trigger(input: AutomationTriggerInput): Promise<{ status: "queued" }> {
    return this.client.request("POST", "/api/v1/automations/trigger", { body: input });
  }

  listExecutions(automationId: string): Promise<{ executions: AutomationExecution[] }> {
    return this.client.request(
      "GET",
      `/api/v1/automations/${encodeURIComponent(automationId)}/executions`,
    );
  }

  pause(automationId: string): Promise<{ id: string; status: "paused" }> {
    return this.client.request(
      "POST",
      `/api/v1/automations/${encodeURIComponent(automationId)}/pause`,
    );
  }

  resume(automationId: string): Promise<{ id: string; status: "active" }> {
    return this.client.request(
      "POST",
      `/api/v1/automations/${encodeURIComponent(automationId)}/resume`,
    );
  }

  create(input: CreateAutomationInput): Promise<Automation> {
    return this.client.request("POST", "/api/v1/automations", { body: input });
  }

  list(params: { status?: string; cursor?: string } = {}): Promise<AutomationListPage> {
    return this.client.request("GET", "/api/v1/automations", {
      query: { status: params.status, cursor: params.cursor },
    });
  }

  update(id: string, patch: UpdateAutomationInput): Promise<Automation> {
    return this.client.request(
      "PATCH",
      `/api/v1/automations/${encodeURIComponent(id)}`,
      { body: patch },
    );
  }

  createBehavioralTrigger(
    automationId: string,
    input: BehavioralTriggerInput,
  ): Promise<BehavioralTrigger> {
    return this.client.request(
      "POST",
      `/api/v1/automations/${encodeURIComponent(automationId)}/behavioral-triggers`,
      { body: input },
    );
  }
}
