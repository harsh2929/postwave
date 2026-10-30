import type { ReactElement } from "react";

import type { Campaign } from "../../lib/api-client";

export type CampaignFilter = "all" | "draft" | "scheduled" | "sent";
export type CampaignBodyTab = "edit" | "preview";
export type CampaignSortKey = "name" | "status" | "sent" | "open" | "click";
export type CampaignViewMode = "list" | "calendar";

export interface CampaignDraft {
  body: string;
  fromEmail: string;
  name: string;
  previewText: string;
  subject: string;
}

export interface CreateCampaignVars {
  body?: string;
  from_email: string;
  name: string;
  preview_text?: string;
  subject: string;
}

export const CAMPAIGN_PAGE_SIZE = 25;
export const CAMPAIGN_LIST_COLUMNS = "32px 1.5fr 100px 110px 80px 80px 1fr";

export function formatCampaignPercent(value: number | undefined): string {
  if (value == null) return "—";
  const percent = value > 1 ? value : value * 100;
  return `${percent.toFixed(1)}%`;
}

export function campaignStatusBadge(status: string | undefined): ReactElement {
  const normalized = (status ?? "draft").toLowerCase();
  if (normalized === "sent" || normalized === "running") {
    return <span className="badge success">Sent</span>;
  }
  if (normalized === "scheduled") {
    return <span className="badge warning">Scheduled</span>;
  }
  if (normalized === "draft") return <span className="badge">Draft</span>;
  if (normalized === "failed") {
    return <span className="badge danger">Failed</span>;
  }
  return <span className="badge">{status ?? "—"}</span>;
}

export function campaignStatusTone(status: string | undefined): string {
  const normalized = (status ?? "draft").toLowerCase();
  if (normalized === "sent" || normalized === "running")
    return "var(--pw-accent)";
  if (normalized === "scheduled") return "var(--pw-warning)";
  if (normalized === "failed") return "var(--pw-danger)";
  return "var(--pw-border)";
}

export function abResultsModalKey(campaign: Campaign | null): string {
  if (campaign == null || campaign.id == null) return "closed";
  return String(campaign.id);
}

export function campaignRowId(campaign: Campaign): string {
  return String(campaign.id ?? "");
}

export function isCampaignAbTest(campaign: Campaign): boolean {
  const record = campaign as unknown as {
    delivery_settings?: { ab_test?: { is_parent?: boolean } };
    is_ab_test?: boolean;
  };
  return Boolean(
    record.delivery_settings?.ab_test?.is_parent || record.is_ab_test,
  );
}

export function escapeCampaignCsvCell(value: unknown): string {
  const text = value == null ? "" : String(value);
  // Spreadsheet applications may execute tenant-controlled text as a formula
  // even when the marker is preceded by whitespace or invisible formatting
  // characters. Prefix only strings so genuine negative numeric metrics keep
  // their numeric CSV representation.
  const neutralized =
    typeof value === "string" &&
    /^[\p{White_Space}\u200B\u200C\u200D\u2060\uFEFF]*[=+\-@]/u.test(value)
      ? "'" + value
      : text;
  return /[",\r\n\t]/.test(neutralized)
    ? '"' + neutralized.replace(/"/g, '""') + '"'
    : neutralized;
}
