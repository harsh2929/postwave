// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldCheck } from "lucide-react";

import { PageShell } from "@/components/dashboard/page-shell";
import { effectiveAuthRole, whoami } from "@/lib/auth-api";
import { formatWireTimestamp } from "@/lib/go-zero-time";
import { base, qk, STALE } from "@/lib/query-keys";
import {
  firewallSelfArming,
  getFirewallSettings,
  getFirewallStats,
  listMaintenanceWindows,
  listPresetSegments,
  undecidedSignups,
} from "@/lib/signup-protection-api";
import {
  EngagementEmpty,
  EngagementIdentityGate,
  EngagementLoading,
  EngagementMetric,
  EngagementPageHeader,
  EngagementQueryError,
  EngagementSurface,
} from "../_engagement/engagement-ui";
import { FirewallControlPanel } from "./firewall-control-panel";

export default function SignupProtectionPage() {
  const queryClient = useQueryClient();
  const meQuery = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const canLoad = meQuery.isSuccess && Boolean(meQuery.data);
  const role = meQuery.data ? effectiveAuthRole(meQuery.data) : null;
  const keyBase = useMemo(
    () => [
      ...base("signup-protection", meQuery.data?.tenant_id ?? "pending", role),
      meQuery.data?.user_id ?? "unverified",
      meQuery.data?.viewer_mode ? "viewer" : "member",
    ],
    [meQuery.data?.tenant_id, meQuery.data?.user_id, meQuery.data?.viewer_mode, role],
  );

  const firewall = useQuery({
    queryKey: [...keyBase, "firewall"],
    queryFn: ({ signal }) => getFirewallStats(signal),
    staleTime: STALE.dashboard,
    enabled: canLoad,
  });
  const presets = useQuery({
    queryKey: [...keyBase, "presets"],
    queryFn: listPresetSegments,
    staleTime: STALE.reference,
    enabled: canLoad,
  });
  const windows = useQuery({
    queryKey: [...keyBase, "maintenance"],
    queryFn: listMaintenanceWindows,
    staleTime: STALE.list,
    enabled: canLoad,
  });
  const posture = useQuery({
    queryKey: [...keyBase, "firewall-settings"],
    queryFn: ({ signal }) =>
      getFirewallSettings({
        tenantId: meQuery.data?.tenant_id,
        signal,
      }),
    staleTime: STALE.reference,
    enabled: canLoad,
  });

  const stats = firewall.data;
  const presetRows = Array.isArray(presets.data) ? presets.data : [];
  const windowRows = Array.isArray(windows.data) ? windows.data : [];

  return (
    <PageShell className="max-w-6xl">
      <EngagementPageHeader
        eyebrow="Audience safety"
        title="Signup protection"
        description="See what the signup firewall observed and decided, when it will tighten automatically, which protected segments exist, and any planned service windows."
        icon={<ShieldCheck aria-hidden />}
      />

      <EngagementIdentityGate
        pending={meQuery.isPending}
        error={meQuery.isError || !meQuery.data}
        retrying={meQuery.isFetching}
        onRetry={() => void meQuery.refetch()}
      >
        <div className="grid gap-6 lg:grid-cols-2">
          <EngagementSurface
            id="sp-firewall-stats"
            title="Firewall decisions"
            description="Observed is everything seen. Accepted and rejected are decisions; anything left over is shown as not ruled on."
          >
            {firewall.isPending ? (
              <EngagementLoading
                label="Loading signup firewall statistics"
                rows={4}
              />
            ) : firewall.isError || !stats ? (
              <EngagementQueryError
                title="Firewall statistics could not be loaded"
                description="A failed request is not represented as zero observed, accepted, or rejected signups."
                retrying={firewall.isFetching}
                onRetry={() => void firewall.refetch()}
              />
            ) : (
              <div className="space-y-4">
                {(
                  [
                    ["Last 24 hours", stats.last_24h],
                    ["Last 7 days", stats.last_7d],
                  ] as const
                ).map(([label, window]) => (
                  <div key={label}>
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      {label}
                    </h3>
                    <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-2 xl:grid-cols-4">
                      <EngagementMetric
                        label="Observed"
                        value={window.observed.toLocaleString()}
                      />
                      <EngagementMetric
                        label="Accepted"
                        value={window.accepted.toLocaleString()}
                        tone="positive"
                      />
                      <EngagementMetric
                        label="Rejected"
                        value={window.rejected.toLocaleString()}
                        tone={window.rejected > 0 ? "danger" : "default"}
                      />
                      <EngagementMetric
                        label="Not ruled on"
                        value={undecidedSignups(window).toLocaleString()}
                        tone={
                          undecidedSignups(window) > 0 ? "warning" : "default"
                        }
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </EngagementSurface>

          <EngagementSurface
            id="sp-firewall-posture"
            title="Firewall posture"
            description="Current strictness and the automatic conditions that can change it."
          >
            {posture.isPending ? (
              <EngagementLoading label="Loading signup firewall posture" />
            ) : posture.isError || !posture.data ? (
              <EngagementQueryError
                title="Firewall posture could not be loaded"
                description="Attack-mode and fingerprint requirements are unknown until this request succeeds."
                retrying={posture.isFetching}
                onRetry={() => void posture.refetch()}
              />
            ) : (
              <>
                <div className="grid gap-3 sm:grid-cols-2">
                  <EngagementMetric
                    label="Attack mode"
                    value={
                      posture.data.attack_mode_enabled
                        ? "Engaged"
                        : firewallSelfArming(posture.data)
                          ? "Armed automatically"
                          : "Off"
                    }
                    tone={
                      posture.data.attack_mode_enabled ? "warning" : "default"
                    }
                  />
                  <EngagementMetric
                    label="Device fingerprint"
                    value={
                      posture.data.fingerprint_required
                        ? "Required"
                        : "Optional"
                    }
                  />
                </div>
                {/*
                  attack_mode_threshold is a 0-100 risk score compared against a
                  single signup's score once attack mode is engaged; it takes no
                  part in arming. Auto-arming is decided only by surge_min_per_hour
                  and surge_multiplier against the 7-day hourly baseline. Describing
                  the threshold as a volume trigger tells an operator the firewall
                  is about to tighten when it never will.
                */}
                {firewallSelfArming(posture.data) ? (
                  <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
                    Attack mode is not currently engaged, but it turns on when
                    signup volume exceeds{" "}
                    {posture.data.surge_multiplier.toLocaleString()}× the normal
                    rate, once at least{" "}
                    {posture.data.surge_min_per_hour.toLocaleString()} signups
                    arrive in an hour. Once engaged, a signup scoring{" "}
                    {posture.data.attack_mode_threshold.toLocaleString()} or
                    higher out of 100 for risk is rejected.
                  </p>
                ) : posture.data.attack_mode_enabled ? (
                  <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
                    Attack mode is engaged. A signup scoring{" "}
                    {posture.data.attack_mode_threshold.toLocaleString()} or
                    higher out of 100 for risk is rejected, which can also
                    reject some legitimate signups.
                  </p>
                ) : (
                  <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
                    Attack mode is off and will not arm itself. Checks will not
                    tighten automatically during a surge.
                  </p>
                )}
              </>
            )}
          </EngagementSurface>
        </div>

        {posture.data && meQuery.data ? (
          <FirewallControlPanel
            identity={meQuery.data}
            settings={posture.data}
            onSettingsUpdated={(next) => {
              queryClient.setQueryData([...keyBase, "firewall-settings"], next);
            }}
            onRefresh={() => {
              void Promise.all([posture.refetch(), firewall.refetch()]);
            }}
          />
        ) : null}

        <div className="grid gap-6 lg:grid-cols-2">
          <EngagementSurface
            id="sp-presets"
            title="Protected preset segments"
            description="Ready-made audience cuts exposed by the server. An uncomputed count stays unknown instead of becoming zero."
          >
            {presets.isPending ? (
              <EngagementLoading label="Loading protected preset segments" />
            ) : presets.isError ? (
              <EngagementQueryError
                title="Preset segments could not be loaded"
                description="A failed catalog is not shown as a build with no protected segments."
                retrying={presets.isFetching}
                onRetry={() => void presets.refetch()}
              />
            ) : presetRows.length === 0 ? (
              <EngagementEmpty
                title="No preset segments offered"
                description="This build returned no ready-made signup-protection segments."
              />
            ) : (
              <ul
                className="divide-y rounded-lg border"
                aria-label="Signup protection preset segments"
              >
                {presetRows.map((preset, index) => (
                  <li key={preset.key || index} className="p-3">
                    <div className="flex min-w-0 items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="break-words text-sm font-medium">
                          {preset.label || `Unnamed segment ${index + 1}`}
                        </p>
                        {preset.description ? (
                          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                            {preset.description}
                          </p>
                        ) : null}
                      </div>
                      <span className="shrink-0 text-sm tabular-nums text-muted-foreground">
                        {typeof preset.count === "number"
                          ? preset.count.toLocaleString()
                          : "Not computed"}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </EngagementSurface>

          <EngagementSurface
            id="sp-maint"
            title="Maintenance windows"
            description="Planned periods that may affect signup processing or protection signals."
          >
            {windows.isPending ? (
              <EngagementLoading label="Loading signup maintenance windows" />
            ) : windows.isError ? (
              <EngagementQueryError
                title="Maintenance windows could not be loaded"
                description="The schedule is unavailable; no-maintenance is not being assumed."
                retrying={windows.isFetching}
                onRetry={() => void windows.refetch()}
              />
            ) : windowRows.length === 0 ? (
              <EngagementEmpty
                title="No maintenance scheduled"
                description="The schedule request completed successfully and returned no planned windows."
              />
            ) : (
              <ol
                className="space-y-3"
                aria-label="Signup protection maintenance windows"
              >
                {windowRows.map((window, index) => (
                  <li
                    key={String(window.id ?? index)}
                    className="rounded-lg border bg-background/60 p-3"
                  >
                    <p className="text-sm font-medium">
                      {formatWireTimestamp(
                        window.starts_at,
                        "Start not scheduled",
                      )}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Until{" "}
                      {formatWireTimestamp(window.ends_at, "further notice")}
                    </p>
                    {window.reason ? (
                      <p className="mt-2 break-words text-xs leading-relaxed text-muted-foreground">
                        {window.reason}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ol>
            )}
          </EngagementSurface>
        </div>
      </EngagementIdentityGate>
    </PageShell>
  );
}
