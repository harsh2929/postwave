// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useMemo } from "react";
import dynamic from "next/dynamic";
import { useQuery } from "@tanstack/react-query";
import { Newspaper } from "lucide-react";

import { PageShell } from "@/components/dashboard/page-shell";
import {
  archiveHasNoAddress,
  formatMoney,
  getArchiveSettings,
} from "@/lib/archive-admin-api";
import { effectiveAuthRole, whoami } from "@/lib/auth-api";
import { base, STALE } from "@/lib/query-keys";
import {
  ArchiveOperationsPanel,
  ArchiveShareLinks,
} from "./archive-operations-panel";
import {
  EngagementEmpty,
  EngagementIdentityGate,
  EngagementLoading,
  EngagementPageHeader,
  EngagementQueryError,
  EngagementSurface,
} from "../_engagement/engagement-ui";

// The custom-domain workflow sits in the last row of the page and is only
// shown to admins; splitting it keeps the route under the dashboard bundle
// budget without changing what admins see once it has loaded.
const ArchiveDomainSection = dynamic(
  () =>
    import("./archive-domain-section").then(
      (module) => module.ArchiveDomainSection,
    ),
  {
    loading: () => (
      <EngagementLoading label="Loading custom domain settings" rows={4} />
    ),
  },
);

export default function ArchiveSettingsPage() {
  const meQuery = useQuery({
    queryKey: ["whoami"],
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const effectiveRole = meQuery.data ? effectiveAuthRole(meQuery.data) : null;
  const canLoadAdminSettings = Boolean(
    meQuery.data &&
    !meQuery.data.viewer_mode &&
    effectiveRole !== null &&
    ["owner", "admin"].includes(effectiveRole),
  );
  const keyBase = useMemo(
    () =>
      [
        ...base(
          "archive-admin",
          meQuery.data?.tenant_id ?? "pending",
          effectiveRole,
        ),
        meQuery.data?.user_id ?? "pending-user",
        Boolean(meQuery.data?.viewer_mode),
      ] as const,
    [
      effectiveRole,
      meQuery.data?.tenant_id,
      meQuery.data?.user_id,
      meQuery.data?.viewer_mode,
    ],
  );

  const settings = useQuery({
    queryKey: [...keyBase, "settings"],
    queryFn: ({ signal }) => getArchiveSettings(signal),
    staleTime: STALE.reference,
    enabled: canLoadAdminSettings,
  });

  const archive = settings.data;

  return (
    <PageShell className="max-w-6xl">
      <EngagementPageHeader
        eyebrow="Reader experience"
        title="Archive settings"
        description="Inspect published issues and performance safely, use the admin emergency-removal path, and review public archive configuration."
        icon={<Newspaper aria-hidden />}
      />

      <EngagementIdentityGate
        pending={meQuery.isPending}
        error={meQuery.isError || !meQuery.data}
        retrying={meQuery.isFetching}
        onRetry={() => void meQuery.refetch()}
      >
        {meQuery.data ? (
          <ArchiveOperationsPanel me={meQuery.data} queryBase={keyBase} />
        ) : null}

        {canLoadAdminSettings ? (
          <>
            <div className="grid gap-6 lg:grid-cols-2">
              <EngagementSurface
                id="ar-identity"
                title="Public identity"
                description="What readers see and where the archive can be reached."
              >
                {settings.isPending ? (
                  <EngagementLoading label="Loading archive identity" />
                ) : settings.isError || !archive ? (
                  <EngagementQueryError
                    title="Archive settings could not be loaded"
                    description="The archive address, public identity, tips, and campaign defaults are unavailable."
                    retrying={settings.isFetching}
                    onRetry={() => void settings.refetch()}
                  />
                ) : archiveHasNoAddress(archive) ? (
                  <EngagementEmpty
                    title="No archive address yet"
                    description="Neither an archive slug nor a custom domain is set. The configuration exists, but readers cannot reach it yet."
                  />
                ) : (
                  <dl className="grid gap-3 sm:grid-cols-2">
                    <div className="min-w-0 rounded-lg border bg-background/60 p-3 sm:col-span-2">
                      <dt className="text-xs text-muted-foreground">
                        Archive title
                      </dt>
                      <dd className="mt-1 break-words text-base font-medium">
                        {archive.archive_title || "No title set"}
                      </dd>
                      {archive.archive_tagline ? (
                        <dd className="mt-1 break-words text-sm text-muted-foreground">
                          {archive.archive_tagline}
                        </dd>
                      ) : null}
                    </div>
                    <div className="min-w-0 rounded-lg border bg-background/60 p-3">
                      <dt className="text-xs text-muted-foreground">
                        Archive slug
                      </dt>
                      <dd className="mt-1 break-all font-mono text-sm">
                        {archive.tenant_archive_slug || "Not set"}
                      </dd>
                    </div>
                    <div className="min-w-0 rounded-lg border bg-background/60 p-3">
                      <dt className="text-xs text-muted-foreground">
                        Custom domain
                      </dt>
                      <dd className="mt-1 break-all font-mono text-sm">
                        {archive.archive_domain || "Not set"}
                      </dd>
                    </div>
                  </dl>
                )}
                {settings.isSuccess && archive ? (
                  <ArchiveShareLinks settings={archive} />
                ) : null}
              </EngagementSurface>

              <EngagementSurface
                id="ar-tips"
                title="Reader tipping"
                description="Amounts arrive from the API in cents and are formatted as reader-facing currency here."
              >
                {settings.isPending ? (
                  <EngagementLoading label="Loading reader tipping settings" />
                ) : settings.isError || !archive ? (
                  <EngagementQueryError
                    title="Reader tipping settings could not be loaded"
                    description="Tip availability and prices are unknown; no reader-facing amount is being inferred."
                    retrying={settings.isFetching}
                    onRetry={() => void settings.refetch()}
                  />
                ) : (
                  <>
                    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-background/60 p-3">
                      <div>
                        <p className="text-sm font-medium">
                          Tipping is {archive.tips_enabled ? "on" : "off"}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          Minimum{" "}
                          {formatMoney(
                            archive.tips_min_amount,
                            archive.tips_currency,
                          )}
                        </p>
                      </div>
                      <span className="rounded-full border px-2.5 py-1 text-xs uppercase text-muted-foreground">
                        {archive.tips_currency}
                      </span>
                    </div>
                    {archive.tips_suggested_amounts.length === 0 ? (
                      <div className="mt-3">
                        <EngagementEmpty
                          title="No suggested amounts"
                          description="Readers may still be able to enter an amount when tipping is enabled, subject to the minimum."
                        />
                      </div>
                    ) : (
                      <ul
                        className="mt-3 flex flex-wrap gap-2"
                        aria-label="Suggested tip amounts"
                      >
                        {archive.tips_suggested_amounts.map((amount, index) => (
                          <li
                            key={`${amount}:${index}`}
                            className="rounded-full border bg-background/60 px-3 py-1.5 text-sm font-medium tabular-nums"
                          >
                            {formatMoney(amount, archive.tips_currency)}
                          </li>
                        ))}
                      </ul>
                    )}
                    {archive.tips_message ? (
                      <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                        Reader message: {archive.tips_message}
                      </p>
                    ) : null}
                  </>
                )}
              </EngagementSurface>
            </div>

            <div className="grid gap-6 lg:grid-cols-2">
              <EngagementSurface
                id="ar-defaults"
                title="Campaign defaults"
                description="Defaults for newly created campaigns; they do not rewrite campaigns that already exist."
              >
                {settings.isPending ? (
                  <EngagementLoading label="Loading archive campaign defaults" />
                ) : settings.isError || !archive ? (
                  <EngagementQueryError
                    title="Campaign defaults could not be loaded"
                    description="New-campaign archive behavior is unknown until the settings request succeeds."
                    retrying={settings.isFetching}
                    onRetry={() => void settings.refetch()}
                  />
                ) : (
                  <ul className="divide-y rounded-lg border">
                    {[
                      [
                        "Archive bar on new campaigns",
                        archive.archive_bar_default_enabled,
                      ],
                      [
                        "View-in-browser link on new campaigns",
                        archive.view_in_browser_default_enabled,
                      ],
                    ].map(([label, enabled]) => (
                      <li
                        key={String(label)}
                        className="flex items-center justify-between gap-3 p-3 text-sm"
                      >
                        <span className="min-w-0 break-words">{label}</span>
                        <span className="shrink-0 rounded-full border px-2 py-0.5 text-xs text-muted-foreground">
                          {enabled ? "On" : "Off"}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </EngagementSurface>

              <EngagementSurface
                id="ar-domain"
                title="Custom domain"
                description="Save a vanity host, publish its CNAME, and verify it. DNS verification and certificate issuance are separate gates and remain separate here."
              >
                {meQuery.data ? (
                  <ArchiveDomainSection me={meQuery.data} queryBase={keyBase} />
                ) : null}
              </EngagementSurface>
            </div>
          </>
        ) : (
          <EngagementSurface
            id="ar-admin-settings-access"
            title="Archive configuration"
            description="Public identity, tipping, defaults, and custom-domain settings are restricted to workspace admins and owners."
          >
            <EngagementEmpty
              title="Read-only archive access"
              description="You can inspect authenticated issue and performance data above. Switch out of viewer mode or ask a workspace admin to review archive configuration."
            />
          </EngagementSurface>
        )}
      </EngagementIdentityGate>
    </PageShell>
  );
}
