// SPDX-License-Identifier: AGPL-3.0-only
//
// Read-only client for the tenant data-residency surface. Backend
// handler: apps/api/internal/regions/handler.go (Get). Mutation is
// intentionally absent — changing data_region requires a tenant
// migration job, not an API write.

import { api } from "@/lib/api";

export type Region =
  | "us-east-1"
  | "us-west-2"
  | "eu-central-1"
  | "eu-west-1"
  | "ap-southeast-1"
  | "ap-northeast-1";

export interface TenantRegion {
  data_region: Region;
  deployment_region: Region;
  matches: boolean;
}

export const REGION_LABELS: Record<Region, string> = {
  "us-east-1": "US East (N. Virginia)",
  "us-west-2": "US West (Oregon)",
  "eu-central-1": "EU Central (Frankfurt)",
  "eu-west-1": "EU West (Ireland)",
  "ap-southeast-1": "Asia Pacific (Singapore)",
  "ap-northeast-1": "Asia Pacific (Tokyo)",
};

export function getTenantRegion(): Promise<TenantRegion> {
  return api.get<TenantRegion>("/api/v1/tenant/region");
}
