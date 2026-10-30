// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * Social capture — and an honest word about what is actually live.
 *
 * Seven `/api/v1/social-capture/*` paths were reached by desktop and by nothing
 * on web.
 *
 * EVERY NETWORK REPORTS `runtime_status: "foundation"`. Confirmed against the
 * running server for all four. Foundation means the plumbing is built and the
 * network is not live. Listing them as connectable would invite an operator to
 * configure something that cannot run and then wait for leads that will never
 * arrive — a failure they would attribute to their own setup. So the page says
 * it in words, once, at the top, and still shows what exists.
 */

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { PageShell } from "@/components/dashboard/page-shell";
import { ContentQueryError } from "../_content-automation/content-query-error";
import { whoami } from "@/lib/auth-api";
import {
  allNetworksAreFoundation,
  getSocialCaptureCatalog,
  listAutoReplies,
  listSocialCaptureLeads,
  listTapToText,
} from "@/lib/social-capture-api";
import { base, qk, STALE } from "@/lib/query-keys";

export default function SocialCapturePage() {
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
        "social-capture",
        meQuery.data?.tenant_id ?? "anon",
        meQuery.data?.role ?? null,
      ),
    [meQuery.data?.role, meQuery.data?.tenant_id],
  );

  const catalog = useQuery({
    queryKey: [...keyBase, "catalog"],
    queryFn: getSocialCaptureCatalog,
    enabled: canLoad,
    staleTime: STALE.reference,
  });
  const taps = useQuery({
    queryKey: [...keyBase, "tap-to-text"],
    queryFn: listTapToText,
    enabled: canLoad,
    staleTime: STALE.list,
  });
  const replies = useQuery({
    queryKey: [...keyBase, "auto-replies"],
    queryFn: listAutoReplies,
    enabled: canLoad,
    staleTime: STALE.list,
  });

  const networks = Array.isArray(catalog.data?.networks)
    ? catalog.data.networks
    : [];
  const foundationOnly = allNetworksAreFoundation(networks);
  const tapRows = Array.isArray(taps.data) ? taps.data : [];
  const replyRows = Array.isArray(replies.data) ? replies.data : [];

  const leads = useQuery({
    queryKey: [...keyBase, "leads"],
    queryFn: listSocialCaptureLeads,
    enabled: canLoad,
    staleTime: STALE.list,
  });
  const leadRows = Array.isArray(leads.data) ? leads.data : [];

  if (!canLoad) {
    return (
      <PageShell className="max-w-5xl">
        <h1 className="font-display text-2xl font-semibold tracking-tight">
          Social capture
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
          Social capture
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Turn comments, DMs and keyword replies into subscribers.
        </p>
      </header>

      {foundationOnly ? (
        <section className="rounded-lg border p-4 sm:p-6" aria-live="polite">
          <h2 className="text-base font-medium">Not live yet</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Every network here reports <code>foundation</code> status: the
            plumbing is built, the connections are not running. Configuring one
            now would leave you waiting for leads that cannot arrive. This page
            shows what exists so you can see the shape of it.
          </p>
        </section>
      ) : null}

      <section aria-labelledby="sc-networks">
        <h2 id="sc-networks" className="text-base font-medium">
          Networks
        </h2>
        {catalog.isLoading ? (
          <p role="status" className="mt-1 text-sm text-muted-foreground">
            Loading…
          </p>
        ) : catalog.isError ? (
          <ContentQueryError
            message="Could not load the network catalog."
            onRetry={() => catalog.refetch()}
            retrying={catalog.isFetching}
          />
        ) : networks.length === 0 ? (
          <p className="mt-1 text-sm text-muted-foreground">
            No networks offered by this build.
          </p>
        ) : (
          <ul className="mt-2 divide-y rounded-lg border">
            {networks.map((n) => (
              <li
                key={n.key}
                className="flex items-start justify-between gap-3 p-3 text-sm"
              >
                <span className="min-w-0 break-words">{n.label}</span>
                <span className="shrink-0 text-muted-foreground">
                  {n.runtime_status}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="sc-taps">
        <h2 id="sc-taps" className="text-base font-medium">
          Tap-to-text rules
        </h2>
        {taps.isLoading ? (
          <p role="status" className="mt-1 text-sm text-muted-foreground">
            Loading…
          </p>
        ) : taps.isError ? (
          <ContentQueryError
            message="Could not load tap-to-text rules."
            onRetry={() => taps.refetch()}
            retrying={taps.isFetching}
          />
        ) : (
          <p className="mt-1 text-sm text-muted-foreground">
            {tapRows.length === 0
              ? "No tap-to-text rules yet."
              : `${tapRows.length} rule(s).`}
          </p>
        )}
        {!taps.isLoading && !taps.isError && tapRows.length > 0 ? (
          <ul className="mt-2 divide-y rounded-lg border bg-card">
            {tapRows.map((rule, index) => (
              <li
                key={rule.id || `tap:${index}`}
                className="flex flex-col gap-1 p-3 text-sm sm:flex-row sm:items-start sm:justify-between sm:gap-4"
              >
                <div className="min-w-0">
                  <p className="break-words font-medium">
                    {rule.name || rule.keyword || `Tap-to-text ${index + 1}`}
                  </p>
                  <p className="mt-0.5 break-words text-xs text-muted-foreground">
                    {rule.keyword ? `Keyword: ${rule.keyword}` : "No keyword"}
                    {rule.destination_phone
                      ? ` · ${rule.destination_phone}`
                      : ""}
                  </p>
                </div>
                <span className="shrink-0 text-xs capitalize text-muted-foreground">
                  {rule.status || "status unavailable"}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section aria-labelledby="sc-replies">
        <h2 id="sc-replies" className="text-base font-medium">
          Auto-replies
        </h2>
        {replies.isLoading ? (
          <p role="status" className="mt-1 text-sm text-muted-foreground">
            Loading…
          </p>
        ) : replies.isError ? (
          <ContentQueryError
            message="Could not load auto-replies."
            onRetry={() => replies.refetch()}
            retrying={replies.isFetching}
          />
        ) : (
          <p className="mt-1 text-sm text-muted-foreground">
            {replyRows.length === 0
              ? "No auto-replies configured."
              : `${replyRows.length} configured.`}
          </p>
        )}
        {!replies.isLoading && !replies.isError && replyRows.length > 0 ? (
          <ul className="mt-2 divide-y rounded-lg border bg-card">
            {replyRows.map((rule, index) => (
              <li
                key={rule.id || `reply:${index}`}
                className="flex flex-col gap-1 p-3 text-sm sm:flex-row sm:items-start sm:justify-between sm:gap-4"
              >
                <div className="min-w-0">
                  <p className="break-words font-medium">
                    {rule.name || `Auto-reply ${index + 1}`}
                  </p>
                  <p className="mt-0.5 break-words text-xs text-muted-foreground">
                    {rule.network || "Any network"}
                    {rule.trigger_phrases?.length
                      ? ` · ${rule.trigger_phrases.length} trigger phrase${rule.trigger_phrases.length === 1 ? "" : "s"}`
                      : " · no trigger phrases"}
                  </p>
                </div>
                <span className="shrink-0 text-xs capitalize text-muted-foreground">
                  {rule.status || "status unavailable"}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section
        aria-labelledby="sc-leads"
        className="rounded-lg border p-4 sm:p-6"
      >
        <h2 id="sc-leads" className="text-base font-medium">
          Captured leads
        </h2>
        {leads.isLoading ? (
          <p role="status" className="mt-1 text-sm text-muted-foreground">
            Loading…
          </p>
        ) : leads.isError ? (
          <ContentQueryError
            message="Could not load captured leads."
            onRetry={() => leads.refetch()}
            retrying={leads.isFetching}
          />
        ) : (
          <p className="mt-1 text-sm text-muted-foreground">
            {leadRows.length === 0
              ? "No leads captured from social replies yet."
              : `${leadRows.length} lead(s).`}
          </p>
        )}
        {!leads.isLoading && !leads.isError && leadRows.length > 0 ? (
          <ul className="mt-2 divide-y rounded-lg border bg-card">
            {leadRows.map((lead, index) => (
              <li
                key={lead.id ?? `lead:${index}`}
                className="flex flex-col gap-1 p-3 text-sm sm:flex-row sm:items-start sm:justify-between sm:gap-4"
              >
                <div className="min-w-0">
                  <p className="break-all font-medium">
                    {lead.subscriber_email ||
                      lead.phone_e164 ||
                      lead.external_user_id ||
                      `Captured lead ${index + 1}`}
                  </p>
                  <p className="mt-0.5 break-words text-xs capitalize text-muted-foreground">
                    {lead.network || "Network unavailable"}
                  </p>
                </div>
                <span className="shrink-0 text-xs capitalize text-muted-foreground">
                  {lead.status || "status unavailable"}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </PageShell>
  );
}
