// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { asString } from "./campaign-detail-helpers";

const TRACKING_TOGGLES = [
  ["open_tracking", "Open tracking", true],
  ["click_tracking", "Click tracking", true],
  ["google_analytics", "Google Analytics UTM tags", false],
] as const;

const TRACKING_TEXT_FIELDS = [
  ["utm_source", "UTM source", "utm-source"],
  ["utm_medium", "UTM medium", "utm-medium"],
  ["utm_campaign", "UTM campaign", "utm-campaign"],
] as const;

export function CampaignTrackingSection({
  onChange,
  tracking,
}: {
  onChange: (key: string, value: unknown) => void;
  tracking: Record<string, unknown>;
}) {
  return (
    <section className="rounded-md border bg-card p-4">
      <h2 className="text-base font-semibold">Tracking</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Open and click choices are enforced when the message is sent. UTM values
        are added to absolute web links when Google Analytics tags are enabled.
      </p>
      <div className="mt-4 grid gap-4 md:grid-cols-2">
        {TRACKING_TOGGLES.map(([key, label, defaultValue]) => (
          <label
            key={key}
            className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm"
          >
            <Checkbox
              checked={
                key === "google_analytics"
                  ? tracking[key] === true
                  : tracking[key] !== false && defaultValue
              }
              onChange={(event) => onChange(key, event.target.checked)}
            />
            {label}
          </label>
        ))}
        {TRACKING_TEXT_FIELDS.map(([key, label, id]) => (
          <div key={key} className="grid gap-2">
            <Label htmlFor={id}>{label}</Label>
            <Input
              id={id}
              value={asString(tracking[key])}
              onChange={(event) => onChange(key, event.target.value)}
            />
          </div>
        ))}
      </div>
    </section>
  );
}
