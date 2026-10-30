// SPDX-License-Identifier: MIT
import { Resource } from "./_base.js";

export type CostGroupBy = "api_key_id" | "kind" | "day" | "actor_label";

export interface CostBucket {
  group: Record<string, string>;
  total_cents: number;
  count: number;
}

export interface CostAggregateInput {
  since: string;
  group_by: CostGroupBy;
}

export interface CostAggregateResponse {
  since: string;
  group_by: CostGroupBy;
  buckets: CostBucket[];
}

export class CostResource extends Resource {
  aggregate(input: CostAggregateInput): Promise<CostAggregateResponse> {
    return this.client.request("GET", "/api/v1/cost/aggregate", {
      query: { since: input.since, group_by: input.group_by },
    });
  }
}
