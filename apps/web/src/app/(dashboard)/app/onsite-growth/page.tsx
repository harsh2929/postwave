// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * Onsite growth — popup capabilities, and product recommendations.
 *
 * Three paths desktop reached and web did not.
 *
 * THE FIRST MIXED CATALOGUE IN THIS SWEEP, AND THAT CHANGES THE RENDERING.
 * Every other provider list was uniformly `partial`, so a single banner told
 * the whole truth. Here it is 15 supported, 11 partial and 2 unavailable — a
 * blanket "none of this is ready" would be plainly false, and a blanket
 * silence would be worse. Each capability group therefore carries its own
 * counts, and each option its own status, so somebody can choose the triggers
 * and targeting rules that actually work.
 */

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { PageShell } from "@/components/dashboard/page-shell";
import { ContentQueryError } from "../_content-automation/content-query-error";
import { whoami } from "@/lib/auth-api";
import { formatWireTimestamp } from "@/lib/go-zero-time";
import {
  getNbpSettings,
  getOnsiteGrowthCatalog,
  notSupported,
  type CapabilityOption,
} from "@/lib/onsite-growth-api";
import { base, qk, STALE } from "@/lib/query-keys";

function CapabilityGroup({
  title,
  options,
}: {
  title: string;
  options: CapabilityOption[];
}) {
  if (options.length === 0) return null;
  const caveats = notSupported(options);
  return (
    <div className="mt-4">
      <p className="text-xs uppercase text-muted-foreground">
        {title}
        {caveats.length > 0 ? (
          <span className="ml-2 normal-case">
            ({options.length - caveats.length} of {options.length} fully
            supported)
          </span>
        ) : null}
      </p>
      <ul className="mt-1 divide-y rounded-lg border">
        {options.map((o) => (
          <li
            key={o.key}
            className="flex items-start justify-between gap-3 p-2 text-sm"
          >
            <span className="min-w-0 break-words">{o.label}</span>
            <span className="shrink-0 text-muted-foreground">
              {o.runtime_status}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function OnsiteGrowthPage() {
  const meQuery = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const canLoad = Boolean(
    meQuery.isSuccess && meQuery.data?.tenant_id && meQuery.data?.user_id,
  );
  const keyBase = useMemo(
    () =>
      base(
        "onsite-growth",
        meQuery.data?.tenant_id ?? "anon",
        meQuery.data?.role ?? null,
      ),
    [meQuery.data?.role, meQuery.data?.tenant_id],
  );

  const catalog = useQuery({
    queryKey: [...keyBase, "catalog"],
    queryFn: getOnsiteGrowthCatalog,
    enabled: canLoad,
    staleTime: STALE.reference,
  });
  const nbp = useQuery({
    queryKey: [...keyBase, "nbp"],
    queryFn: getNbpSettings,
    enabled: canLoad,
    staleTime: STALE.reference,
  });

  const c = catalog.data;
  const n = nbp.data;
  const capabilityCount = c
    ? [
        c.trigger_types,
        c.targeting_groups,
        c.frequency_modes,
        c.experiment_modes,
        c.winner_metrics,
        c.spin_reward_types,
      ].reduce((total, options) => total + options.length, 0)
    : 0;

  if (!canLoad) {
    return (
      <PageShell className="max-w-5xl">
        <h1 className="font-display text-2xl font-semibold tracking-tight">
          Onsite growth
        </h1>
        {meQuery.isPending ? (
          <p role="status">Loading workspace identity…</p>
        ) : (
          <ContentQueryError
            message="Workspace identity could not be loaded. No private data was requested."
            onRetry={() => meQuery.refetch()}
            retrying={meQuery.isFetching}
          />
        )}
      </PageShell>
    );
  }

  return (
    <PageShell className="max-w-5xl">
      <header>
        <h1 className="font-display text-2xl font-semibold tracking-tight">
          Onsite growth
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          What your popups and forms can do, and how product recommendations are
          computed.
        </p>
      </header>

      <section aria-labelledby="og-caps">
        <h2 id="og-caps" className="text-base font-medium">
          Capabilities
        </h2>
        {catalog.isLoading ? (
          <p role="status" className="mt-1 text-sm text-muted-foreground">
            Loading…
          </p>
        ) : catalog.isError ? (
          <ContentQueryError
            message="Could not load the capability catalogue."
            onRetry={() => catalog.refetch()}
            retrying={catalog.isFetching}
          />
        ) : c ? (
          capabilityCount === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">
              No onsite capabilities are offered by this build.
            </p>
          ) : (
            <>
              <CapabilityGroup title="Triggers" options={c.trigger_types} />
              <CapabilityGroup title="Targeting" options={c.targeting_groups} />
              <CapabilityGroup title="Frequency" options={c.frequency_modes} />
              <CapabilityGroup
                title="Experiments"
                options={c.experiment_modes}
              />
              <CapabilityGroup
                title="Winner metric"
                options={c.winner_metrics}
              />
              <CapabilityGroup
                title="Spin rewards"
                options={c.spin_reward_types}
              />
            </>
          )
        ) : null}
      </section>

      <section
        aria-labelledby="og-nbp"
        className="rounded-lg border p-4 sm:p-6"
      >
        <h2 id="og-nbp" className="text-base font-medium">
          Product recommendations
        </h2>
        {nbp.isLoading ? (
          <p role="status" className="mt-2 text-sm text-muted-foreground">
            Loading…
          </p>
        ) : nbp.isError ? (
          <ContentQueryError
            message="Could not load recommendation settings."
            onRetry={() => nbp.refetch()}
            retrying={nbp.isFetching}
          />
        ) : n ? (
          <>
            <p className="mt-2 text-sm">
              Recommendations are <strong>{n.enabled ? "on" : "off"}</strong>
              {n.enabled ? "" : " — nothing is being computed."}
            </p>
            <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                ["Strategy", n.refresher_strategy || "unset"],
                ["Per user", String(n.top_n_per_user)],
                ["Refresh", `${n.refresh_interval_hours}h`],
                ["Model", `v${n.model_version}`],
              ].map(([label, value]) => (
                <div key={label}>
                  <dt className="text-xs uppercase text-muted-foreground">
                    {label}
                  </dt>
                  <dd className="text-sm">{value}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-3 text-xs text-muted-foreground">
              {/* Go zero time again — third endpoint pair this sweep. */}
              Last updated: {formatWireTimestamp(n.updated_at, "never")}
            </p>
          </>
        ) : null}
      </section>
    </PageShell>
  );
}
