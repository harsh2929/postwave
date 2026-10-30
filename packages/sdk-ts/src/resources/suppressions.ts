// SPDX-License-Identifier: MIT

import { Resource } from "./_base.js";

export interface Suppression {
  id: string;
  email: string;
  reason?: string;
  created_at: string;
}

export interface SuppressionBulkResult {
  imported: number;
  skipped: number;
  errors: string[];
}

export class SuppressionsResource extends Resource {
  add(input: { email: string; reason?: string }): Promise<Suppression> {
    return this.client.request("POST", "/api/v1/suppressions", { body: input });
  }

  bulkImport(input: {
    emails: string[];
    reason?: string;
  }): Promise<SuppressionBulkResult> {
    return this.client.request("POST", "/api/v1/suppressions/bulk", {
      body: input,
    });
  }
}
