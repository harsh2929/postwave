// SPDX-License-Identifier: AGPL-3.0-only

import { api } from "@/lib/api";

export interface FromNamePerformance {
  from_name: string;
  campaigns_using: number;
  total_recipients: number;
  opens: number;
  clicks: number;
  complaints: number;
  open_rate: number;
  click_rate: number;
  complaint_rate: number;
  /** 0..1; the server derives this from campaign and recipient evidence. */
  confidence: number;
  rank: number;
}

export interface FromNamePickerResponse {
  window_days: number;
  min_campaigns: number;
  from_names: FromNamePerformance[];
  count: number;
}

const MAX_ROWS = 1_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function safeCount(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid from-name picker ${field}`);
  }
  return value;
}

function unitInterval(value: unknown, field: string): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  ) {
    throw new Error(`Invalid from-name picker ${field}`);
  }
  return value;
}

function parseRow(value: unknown): FromNamePerformance {
  if (!isRecord(value)) throw new Error("Invalid from-name picker row");
  const name =
    typeof value.from_name === "string" ? value.from_name.trim() : "";
  if (!name || name.length > 320) {
    throw new Error("Invalid from-name picker from_name");
  }
  const rank = safeCount(value.rank, "rank");
  if (rank < 1) throw new Error("Invalid from-name picker rank");
  return {
    from_name: name,
    campaigns_using: safeCount(value.campaigns_using, "campaigns_using"),
    total_recipients: safeCount(value.total_recipients, "total_recipients"),
    opens: safeCount(value.opens, "opens"),
    clicks: safeCount(value.clicks, "clicks"),
    complaints: safeCount(value.complaints, "complaints"),
    open_rate: unitInterval(value.open_rate, "open_rate"),
    click_rate: unitInterval(value.click_rate, "click_rate"),
    complaint_rate: unitInterval(value.complaint_rate, "complaint_rate"),
    confidence: unitInterval(value.confidence, "confidence"),
    rank,
  };
}

/** Fail closed on malformed analytics instead of presenting invented zeroes. */
export function parseFromNamePickerResponse(
  value: unknown,
): FromNamePickerResponse {
  if (!isRecord(value) || !Array.isArray(value.from_names)) {
    throw new Error("Invalid from-name picker response");
  }
  if (value.from_names.length > MAX_ROWS) {
    throw new Error("From-name picker response exceeds the supported limit");
  }
  const rows = value.from_names.map(parseRow);
  const count = safeCount(value.count, "count");
  if (count !== rows.length) {
    throw new Error("Invalid from-name picker count");
  }
  const windowDays = safeCount(value.window_days, "window_days");
  const minCampaigns = safeCount(value.min_campaigns, "min_campaigns");
  if (windowDays < 7 || windowDays > 730) {
    throw new Error("Invalid from-name picker window_days");
  }
  if (minCampaigns < 1 || minCampaigns > 100) {
    throw new Error("Invalid from-name picker min_campaigns");
  }
  const ranks = new Set(rows.map((row) => row.rank));
  const names = new Set(rows.map((row) => row.from_name));
  if (
    ranks.size !== rows.length ||
    rows.some((row) => row.rank > rows.length)
  ) {
    throw new Error("Invalid from-name picker ranks");
  }
  if (names.size !== rows.length) {
    throw new Error("Invalid from-name picker row identity");
  }
  rows.sort((left, right) => left.rank - right.rank);
  return {
    window_days: windowDays,
    min_campaigns: minCampaigns,
    from_names: rows,
    count,
  };
}

export async function getFromNameSuggestions(
  options: {
    days?: number;
    minCampaigns?: number;
    signal?: AbortSignal;
  } = {},
): Promise<FromNamePickerResponse> {
  const params = new URLSearchParams();
  if (options.days !== undefined) {
    if (
      !Number.isSafeInteger(options.days) ||
      options.days < 7 ||
      options.days > 730
    ) {
      throw new Error("From-name history must be between 7 and 730 days");
    }
    params.set("days", String(options.days));
  }
  if (options.minCampaigns !== undefined) {
    if (
      !Number.isSafeInteger(options.minCampaigns) ||
      options.minCampaigns < 1 ||
      options.minCampaigns > 100
    ) {
      throw new Error("From-name campaign floor must be between 1 and 100");
    }
    params.set("min_campaigns", String(options.minCampaigns));
  }
  const query = params.toString();
  const response = await api.get<unknown>(
    `/api/v1/from-name-picker${query ? `?${query}` : ""}`,
    { signal: options.signal },
  );
  return parseFromNamePickerResponse(response);
}
