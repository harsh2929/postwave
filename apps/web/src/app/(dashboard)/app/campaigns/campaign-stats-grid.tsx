// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import type { CampaignStatusFilter } from "./campaign-list-helpers";

export function CampaignStatsGrid({
  drafts,
  scheduled,
  sent,
  activeFilter,
  onFilter,
}: {
  drafts: number;
  scheduled: number;
  sent: number;
  activeFilter: CampaignStatusFilter;
  onFilter: (status: CampaignStatusFilter) => void;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <Stat
        label="Drafts"
        value={drafts}
        active={activeFilter === "draft"}
        onClick={() => onFilter("draft")}
      />
      <Stat
        label="Scheduled"
        value={scheduled}
        active={activeFilter === "scheduled"}
        onClick={() => onFilter("scheduled")}
      />
      <Stat
        label="Sent"
        value={sent}
        active={activeFilter === "sent"}
        onClick={() => onFilter("sent")}
      />
    </div>
  );
}

function Stat({
  label,
  value,
  active,
  onClick,
}: {
  label: string;
  value: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-md border px-4 py-3 text-left transition-colors ${
        active
          ? "border-primary/60 bg-primary/5 ring-1 ring-primary/30"
          : "bg-card hover:border-ring/40"
      }`}
    >
      <div className="text-xs font-medium uppercase text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">
        {value.toLocaleString()}
      </div>
    </button>
  );
}
