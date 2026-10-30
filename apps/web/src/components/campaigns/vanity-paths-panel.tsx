// SPDX-License-Identifier: AGPL-3.0-only
//
// F04 — campaign codes and direct navigation, on the campaign page.
//
// The routes, the attribution columns (migration 1947) and the redemption
// linkage have existed with nothing rendering them.
//
// The reason this feature exists is measurement honesty. A click and a request
// to a public short address can both be machine-generated. The short address
// supplies campaign-level provenance without pretending to prove who used it.
//
// And the reason readershipCaveat() is rendered unconditionally, at the top,
// is that the signal still does not prove readership — codes get forwarded and
// read aloud. A surface that shows arrivals without saying that is exactly the
// overstatement F04 was written to avoid.

"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  campaignEvidenceOutcomeLabel,
  createVanityPath,
  listCampaignDirectAttributionEvidence,
  listVanityPaths,
  normalizeSlug,
  outcomeVisibilityCaveat,
  readershipCaveat,
  validateDestination,
} from "@/lib/vanity-paths";
import { base, STALE } from "@/lib/query-keys";
import type { MeResponse } from "@/lib/auth-api";
import {
  canWriteCampaigns,
  confirmFreshCampaignWriteAuthority,
} from "@/lib/campaign-write-authority";

export function VanityPathsPanel({
  campaignId,
  tenantId,
  role,
  canConfigure = false,
  identity,
}: {
  campaignId: string;
  tenantId: string;
  role: string | null;
  canConfigure?: boolean;
  identity: MeResponse | null | undefined;
}) {
  const queryClient = useQueryClient();
  const [slug, setSlug] = useState("");
  const [host, setHost] = useState("");
  const [path, setPath] = useState("/");
  const [evidenceOffset, setEvidenceOffset] = useState(0);
  const authorizedToConfigure = canConfigure && canWriteCampaigns(identity);

  const paths = useQuery({
    queryKey: [...base("vanity-paths", tenantId, role), campaignId],
    queryFn: () => listVanityPaths(campaignId),
    staleTime: STALE.dashboard,
    retry: false,
  });
  const evidence = useQuery({
    queryKey: [
      ...base("direct-attribution-evidence", tenantId, role),
      campaignId,
      evidenceOffset,
    ],
    queryFn: () =>
      listCampaignDirectAttributionEvidence(campaignId, evidenceOffset),
    staleTime: STALE.dashboard,
    retry: false,
  });

  const slugResult = normalizeSlug(slug);
  const destinationProblems = validateDestination(host, path);
  const problems = [
    ...(slug.trim() === "" || slugResult.ok ? [] : [slugResult.reason]),
    ...(host.trim() === "" ? [] : destinationProblems),
  ];
  const canSubmit =
    authorizedToConfigure &&
    slugResult.ok &&
    host.trim() !== "" &&
    destinationProblems.length === 0;

  const create = useMutation({
    mutationFn: async () => {
      await confirmFreshCampaignWriteAuthority(identity);
      return createVanityPath(campaignId, {
        slug: slugResult.ok ? slugResult.slug : slug,
        destinationHost: host.trim().toLowerCase(),
        destinationPath: path,
      });
    },
    onSuccess: () => {
      toast.success("Short address published.");
      setSlug("");
      void queryClient.invalidateQueries({
        queryKey: base("vanity-paths", tenantId, role),
      });
    },
    onError: (error: unknown) => {
      toast.error(
        error instanceof Error
          ? error.message
          : "The address could not be published.",
      );
    },
  });

  const items = Array.isArray(paths.data?.items) ? paths.data?.items : [];

  // Nothing published and nothing to publish with: stay out of the way.
  if (
    !authorizedToConfigure &&
    paths.isSuccess &&
    items.length === 0 &&
    evidence.isSuccess &&
    evidence.data.page_info.total === 0
  ) {
    return null;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Short addresses</CardTitle>
        <CardDescription>
          A short address the email can print instead of a tracked link, for
          readers to type themselves. Requests may also come from forwarding,
          crawlers, or prefetchers, so they are not human-attention evidence.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Unconditional and first. The number this panel produces is only
            honest with this sentence next to it. */}
        <p className="rounded-md border border-border bg-muted/30 p-3 text-sm text-muted-foreground">
          {readershipCaveat()}
        </p>
        <p className="rounded-md border border-warning/30 bg-warning-subtle/20 p-3 text-sm text-muted-foreground">
          {outcomeVisibilityCaveat()}
        </p>

        <section
          aria-labelledby="direct-attribution-heading"
          className="space-y-3"
        >
          <h4 id="direct-attribution-heading" className="text-sm font-semibold">
            Audited direct-attribution evidence
          </h4>
          {evidence.isPending ? (
            <Skeleton className="h-24 w-full" aria-busy="true" />
          ) : evidence.isError ? (
            <p role="alert" className="text-sm text-destructive">
              Allocation, visit, redemption, and linked-outcome evidence could
              not be loaded. This is not the same as zero evidence.
            </p>
          ) : (
            <>
              <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-5">
                {[
                  ["Code allocations", evidence.data.summary.code_allocations],
                  ["Code redemptions", evidence.data.summary.code_redemptions],
                  [
                    "No-click observed",
                    evidence.data.summary.no_click_redemptions,
                  ],
                  [
                    "Short-address requests",
                    evidence.data.summary.vanity_visits,
                  ],
                  [
                    "Linked outcomes",
                    evidence.data.summary.code_linked_outcomes +
                      evidence.data.summary.vanity_linked_outcomes,
                  ],
                ].map(([label, value]) => (
                  <div key={String(label)} className="rounded-md border p-2">
                    <dt className="text-xs text-muted-foreground">{label}</dt>
                    <dd className="font-medium tabular-nums">{value}</dd>
                  </div>
                ))}
              </dl>
              {evidence.data.summary.click_evidence_unavailable > 0 ? (
                <p className="text-sm text-warning" role="status">
                  {evidence.data.summary.click_evidence_unavailable} historical
                  redemption
                  {evidence.data.summary.click_evidence_unavailable === 1
                    ? " has"
                    : "s have"}{" "}
                  no retained event-time click observation. It remains unknown.
                </p>
              ) : null}
              {evidence.data.items.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  The authoritative register contains no allocation or
                  short-address receipts for this campaign.
                </p>
              ) : (
                <ul
                  className="space-y-2"
                  aria-label="Direct attribution receipts"
                >
                  {evidence.data.items.map((item) => (
                    <li
                      key={item.kind + ":" + item.evidence_id}
                      className="rounded-md border p-3 text-sm"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-medium">
                          {item.kind === "code_allocation"
                            ? "Code allocation"
                            : "Short-address request"}
                        </span>
                        <Badge variant="outline">{item.status}</Badge>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Receipt {item.evidence_id.slice(0, 8)} ·{" "}
                        {new Date(item.occurred_at).toLocaleString()}
                      </p>
                      {item.kind === "code_allocation" &&
                      item.redemption_id !== null ? (
                        <p className="mt-1 text-xs text-muted-foreground">
                          Click observation:{" "}
                          {item.linked_without_recorded_assignment_click ===
                          null
                            ? "unavailable"
                            : item.linked_without_recorded_assignment_click
                              ? "no preceding assignment click observed"
                              : "preceding assignment click observed"}
                        </p>
                      ) : null}
                      {campaignEvidenceOutcomeLabel(
                        item.conversion_id,
                        item.amount_cents,
                        item.currency,
                      ) !== null ? (
                        <p className="mt-1 text-xs text-muted-foreground">
                          {campaignEvidenceOutcomeLabel(
                            item.conversion_id,
                            item.amount_cents,
                            item.currency,
                          )}
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
              <div className="flex items-center justify-between gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={
                    evidence.data.page_info.offset === 0 || evidence.isFetching
                  }
                  onClick={() =>
                    setEvidenceOffset((current) =>
                      Math.max(0, current - evidence.data.page_info.limit),
                    )
                  }
                >
                  Previous receipts
                </Button>
                <span className="text-xs text-muted-foreground">
                  {evidence.data.page_info.total === 0
                    ? "0 receipts"
                    : evidence.data.page_info.offset +
                      1 +
                      "–" +
                      Math.min(
                        evidence.data.page_info.offset +
                          evidence.data.items.length,
                        evidence.data.page_info.total,
                      ) +
                      " of " +
                      evidence.data.page_info.total}
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={
                    !evidence.data.page_info.has_more || evidence.isFetching
                  }
                  onClick={() =>
                    setEvidenceOffset(
                      evidence.data.page_info.offset +
                        evidence.data.page_info.limit,
                    )
                  }
                >
                  Next receipts
                </Button>
              </div>
            </>
          )}
        </section>

        {paths.isPending ? (
          <Skeleton className="h-16 w-full" aria-busy="true" />
        ) : paths.isError ? (
          <p role="alert" className="text-sm text-destructive">
            Published addresses could not be loaded. This is not the same as
            having none.
          </p>
        ) : items.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No short address published for this campaign yet.
          </p>
        ) : (
          <ul className="space-y-2">
            {items.map((item) => (
              <li
                key={item.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-3"
              >
                <div>
                  <code className="text-sm font-medium">
                    {item.public_path}
                  </code>
                  <p className="text-xs text-muted-foreground">
                    goes to {item.destination_host}
                    {item.destination_path}
                  </p>
                </div>
                <Badge
                  variant={item.status === "active" ? "secondary" : "outline"}
                >
                  {item.status}
                </Badge>
              </li>
            ))}
          </ul>
        )}

        {authorizedToConfigure ? (
          <form
            className="space-y-4 border-t border-border pt-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (canSubmit) create.mutate();
            }}
          >
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-1">
                <Label htmlFor="vanity-slug">Address</Label>
                <div className="flex items-center gap-1">
                  <span className="text-sm text-muted-foreground">/go/</span>
                  <Input
                    id="vanity-slug"
                    value={slug}
                    placeholder="spring"
                    onChange={(e) => setSlug(e.target.value)}
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  Short enough to read aloud and retype without ambiguity.
                </p>
              </div>
              <div className="space-y-1">
                <Label htmlFor="vanity-host">Destination site</Label>
                <Input
                  id="vanity-host"
                  value={host}
                  placeholder="shop.example.com"
                  onChange={(e) => setHost(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="vanity-path">Destination page</Label>
                <Input
                  id="vanity-path"
                  value={path}
                  onChange={(e) => setPath(e.target.value)}
                />
              </div>
            </div>

            {problems.map((problem) => (
              <p
                key={problem}
                role="alert"
                className="text-sm text-destructive"
              >
                {problem}
              </p>
            ))}

            <Button type="submit" disabled={!canSubmit || create.isPending}>
              {create.isPending ? "Publishing…" : "Publish address"}
            </Button>
          </form>
        ) : null}
      </CardContent>
    </Card>
  );
}
