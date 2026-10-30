// SPDX-License-Identifier: MIT
import { Resource } from "./_base.js";

export interface DmarcReport {
  id: string;
  orgName: string;
  reportId: string;
  domain: string;
  policyP: "" | "none" | "quarantine" | "reject" | "unknown";
  policyPct: number | null;
  dateBegin: string;
  dateEnd: string;
  passCount: number;
  failCount: number;
  receivedAt: string;
}

export interface DmarcReportListMeta {
  generatedAt: string;
  limit: number;
  returned: number;
  totalReports: number;
  hasMore: boolean;
  availableDomains: string[];
  domainInventoryTruncated: boolean;
  scope: {
    domain?: string;
    from?: string;
    to?: string;
  };
}

export interface DmarcReportListPage {
  items: DmarcReport[];
  meta: DmarcReportListMeta;
}

export class DmarcResource extends Resource {
  list(
    params: {
      domain?: string;
      from?: string;
      to?: string;
      limit?: number;
    } = {},
  ): Promise<DmarcReportListPage> {
    return this.client.request("GET", "/api/v1/deliverability/dmarc-reports", {
      query: {
        domain: params.domain,
        from: params.from,
        to: params.to,
        limit: params.limit,
      },
    });
  }
}
