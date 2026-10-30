// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * Campaign picker for the mailbox-provider breakdown (parity row
 * deliverability-67). Desktop: components/deliverability/CampaignSelect.tsx,
 * which feeds IspBreakdownCard's switch between the tenant window
 * (GET /isp-breakdown) and one campaign (GET /isp-breakdown/by-campaign/{id}).
 *
 * "" means the tenant-wide window. The option list is one bounded page of
 * campaigns; when it is full, or when the list cannot be read at all, a
 * campaign can still be named by its exact id — validated as a UUID first,
 * because the server casts the segment and a malformed id is an internal
 * error there rather than a clean refusal.
 */

import { useId, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { listCampaigns } from "@/lib/campaigns-api";
import { CAMPAIGN_ID_PATTERN } from "@/lib/lifecycle-api";
import { qk, STALE, type RoleKey } from "@/lib/query-keys";

/** One page of choices; the hint below the picker says when it is full. */
export const ISP_CAMPAIGN_OPTION_LIMIT = 100;

export function IspCampaignSelect({
  tenantId,
  role,
  value,
  onChange,
  disabled = false,
}: {
  tenantId: string;
  role: RoleKey;
  value: string;
  onChange: (campaignId: string) => void;
  disabled?: boolean;
}) {
  const selectId = useId();
  const directId = useId();
  const [directOpen, setDirectOpen] = useState(false);
  const [directValue, setDirectValue] = useState("");
  const [directError, setDirectError] = useState(false);

  const campaigns = useQuery({
    queryKey: qk.campaigns(tenantId, role, {
      purpose: "isp-breakdown-picker",
      limit: ISP_CAMPAIGN_OPTION_LIMIT,
    }),
    queryFn: () => listCampaigns({ limit: ISP_CAMPAIGN_OPTION_LIMIT }),
    staleTime: STALE.list,
  });
  const options = Array.isArray(campaigns.data) ? campaigns.data : null;
  const listed = (options ?? []).some((campaign) => campaign.id === value);

  const submitDirect = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalized = directValue.trim();
    if (!CAMPAIGN_ID_PATTERN.test(normalized)) {
      setDirectError(true);
      return;
    }
    setDirectError(false);
    setDirectOpen(false);
    onChange(normalized);
  };

  return (
    <div className="mb-4 space-y-2">
      <Label htmlFor={selectId}>Scope</Label>
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-[14rem] flex-1">
          <Select
            id={selectId}
            value={value}
            disabled={disabled}
            onChange={(event) => onChange(event.currentTarget.value)}
          >
            <option value="">All campaigns · tenant window</option>
            {value && !listed ? (
              <option value={value}>Campaign {value} · direct ID</option>
            ) : null}
            {(options ?? []).map((campaign) => (
              <option key={campaign.id} value={campaign.id}>
                {campaign.name || campaign.subject || campaign.id} ·{" "}
                {campaign.status}
              </option>
            ))}
          </Select>
        </div>
        {campaigns.isError ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void campaigns.refetch()}
            disabled={campaigns.isFetching}
          >
            {campaigns.isFetching ? "Retrying…" : "Retry campaigns"}
          </Button>
        ) : null}
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-expanded={directOpen}
          onClick={() => {
            setDirectOpen((open) => !open);
            setDirectError(false);
          }}
          disabled={disabled}
        >
          Use campaign ID
        </Button>
      </div>

      {campaigns.isPending ? (
        <p className="text-xs text-muted-foreground">Loading campaigns…</p>
      ) : campaigns.isError ? (
        <p role="alert" className="text-xs text-destructive">
          Campaign choices could not be loaded. Retry, or use a known campaign
          ID.
        </p>
      ) : options && options.length >= ISP_CAMPAIGN_OPTION_LIMIT ? (
        <p className="text-xs text-muted-foreground">
          Only the first {ISP_CAMPAIGN_OPTION_LIMIT} campaigns are listed. Use
          a campaign ID for any other.
        </p>
      ) : options && options.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No campaigns yet — the tenant window is the only scope.
        </p>
      ) : null}

      {directOpen ? (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={submitDirect}
          noValidate
        >
          <div className="min-w-[14rem] flex-1">
            <Label htmlFor={directId}>Campaign ID</Label>
            <Input
              id={directId}
              className="mt-1"
              value={directValue}
              maxLength={64}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={directError || undefined}
              aria-describedby={directError ? `${directId}-error` : undefined}
              placeholder="Paste an exact campaign ID"
              onChange={(event) => {
                setDirectValue(event.currentTarget.value);
                setDirectError(false);
              }}
            />
          </div>
          <Button type="submit" size="sm" disabled={disabled}>
            Use ID
          </Button>
          {directError ? (
            <p
              id={`${directId}-error`}
              role="alert"
              className="basis-full text-xs text-destructive"
            >
              A campaign ID is a UUID, like
              0f4c9a2e-1111-4111-8111-aaaaaaaaaaaa.
            </p>
          ) : null}
        </form>
      ) : null}
    </div>
  );
}
