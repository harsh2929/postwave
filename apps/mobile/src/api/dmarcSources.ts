/**
 * api/dmarcSources.ts — the per-source DMARC drill-down.
 *
 *   GET /api/v1/deliverability/dmarc-sources?ip=&days=&domain=   (viewer)
 *
 * The insights card names the top failing source IPs; this is the read that
 * lets an operator OPEN one and judge whether it is a forwarder, a legitimate
 * ESP, or spoofing — the summary aggregate plus the newest per-report slices.
 * Response keys are camelCase (the dmarc service's convention), unlike the
 * snake_case core API.
 */
import { rawRequest, type AIApiError } from "./request";

import { itemsOf, numberOr, str, WireShapeError } from "@/lib/deliverabilityContracts";

class DmarcSourceError extends Error {
  readonly status: number;

  constructor(error: AIApiError, fallback: string) {
    super(error.message || fallback);
    this.name = "DmarcSourceError";
    this.status = error.status;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface DmarcSourceSummary {
  messages: number;
  dkimPass: number;
  spfPass: number;
  alignedPct: number;
  primaryDisposition: string;
}

export interface DmarcSourceReportSlice {
  reportId: string;
  orgName: string;
  dateBegin: string;
  dateEnd: string;
  messages: number;
  alignedPct: number;
  primaryDisposition: string;
}

export interface DmarcSourceDetail {
  sourceIp: string;
  periodDays: number;
  domain: string;
  hasMore: boolean;
  summary: DmarcSourceSummary;
  perReport: DmarcSourceReportSlice[];
}

export async function fetchDmarcSourceDetail(input: {
  ip: string;
  days: number;
  domain?: string;
}): Promise<DmarcSourceDetail> {
  const params = new URLSearchParams();
  params.set("ip", input.ip);
  params.set("days", String(input.days));
  if (input.domain) params.set("domain", input.domain);
  const res = await rawRequest<unknown>(
    "GET",
    `/api/v1/deliverability/dmarc-sources?${params.toString()}`,
  );
  if (res.error) {
    throw new DmarcSourceError(res.error, "Couldn't load the source detail.");
  }
  if (!isRecord(res.data)) throw new WireShapeError("DMARC source detail");
  const summaryRecord = isRecord(res.data.summary) ? res.data.summary : {};
  const perReport: DmarcSourceReportSlice[] = [];
  for (const row of itemsOf(res.data.perReport ?? [], "DMARC source reports")) {
    if (!isRecord(row)) continue;
    perReport.push({
      reportId: str(row.reportId),
      orgName: str(row.orgName),
      dateBegin: str(row.dateBegin),
      dateEnd: str(row.dateEnd),
      messages: Math.max(0, numberOr(row.messages, 0)),
      alignedPct: numberOr(row.alignedPct, 0),
      primaryDisposition: str(row.primaryDisposition, "none"),
    });
  }
  return {
    sourceIp: str(res.data.sourceIp, input.ip),
    periodDays: Math.max(0, numberOr(res.data.periodDays, input.days)),
    domain: str(res.data.domain),
    hasMore: res.data.hasMore === true,
    summary: {
      messages: Math.max(0, numberOr(summaryRecord.messages, 0)),
      dkimPass: Math.max(0, numberOr(summaryRecord.dkimPass, 0)),
      spfPass: Math.max(0, numberOr(summaryRecord.spfPass, 0)),
      alignedPct: numberOr(summaryRecord.alignedPct, 0),
      primaryDisposition: str(summaryRecord.primaryDisposition, "none"),
    },
    perReport,
  };
}
