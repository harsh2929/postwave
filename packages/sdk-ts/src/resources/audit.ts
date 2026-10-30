// SPDX-License-Identifier: MIT
import { Resource } from "./_base.js";

export interface AuditEntry {
  id: string;
  tenant_id: string;
  actor_type: string;
  actor_label: string;
  action: string;
  resource_type: string;
  resource_id?: string;
  metadata?: Record<string, unknown>;
  at: string;
}

export interface AuditQueryParams {
  actor_type?: string;
  actor_label?: string;
  action?: string;
  resource_type?: string;
  since?: string;
  cursor?: string;
}

export interface AuditQueryResponse {
  items: AuditEntry[];
  next_cursor?: string | null;
}

export class AuditResource extends Resource {
  query(params: AuditQueryParams = {}): Promise<AuditQueryResponse> {
    return this.client.request("GET", "/api/v1/audit", {
      query: params as Record<string, string | undefined>,
    });
  }
}
