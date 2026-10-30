// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Heart } from "lucide-react";

import { PageShell } from "@/components/dashboard/page-shell";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { whoami } from "@/lib/auth-api";
import { base, qk, STALE } from "@/lib/query-keys";
import {
  canAccessRetentionOffers,
  retentionEffectiveRole,
} from "@/lib/retention-offers-access";
import {
  RETENTION_WINBACK_RELEASE_HOLD_CODE,
  RETENTION_WINBACK_RELEASE_VERDICT,
} from "@/lib/retention-winback-release-status";
import {
  RETENTION_HISTORY_PAGE_SIZE,
  buildRetentionOfferRows,
  filterRetentionOfferRows,
  formatAcceptanceRate,
  formatChurnThreshold,
  formatOfferDiscount,
  getRetentionFunnel,
  getWinbackSettings,
  hasRetentionOutcomeConflict,
  listRetentionOffers,
  listRetentionTiers,
  retentionEvidenceLabel,
  retentionTierLabel,
  scoredButInert,
  sortRetentionOfferRows,
  type RetentionDiscountFilter,
  type RetentionEvidenceFilter,
  type RetentionHistorySort,
  type RetentionOfferRow,
  type RetentionStatusFilter,
} from "@/lib/retention-offers-api";
import {
  EngagementEmpty,
  EngagementIdentityGate,
  EngagementLoading,
  EngagementMetric,
  EngagementPageHeader,
  EngagementQueryError,
  EngagementSurface,
} from "../_engagement/engagement-ui";

function offerTimestamp(value: string): string {
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) return "Unavailable";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(millis));
}

export default function RetentionPage() {
  const meQuery = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const effectiveRole = retentionEffectiveRole(meQuery.data);
  const viewerMode = meQuery.data?.viewer_mode === true;
  const tenantId = meQuery.data?.tenant_id ?? null;
  const canLoad = canAccessRetentionOffers(meQuery.data) && tenantId !== null;
  const keyBase = useMemo(
    () =>
      [
        ...base("retention", tenantId ?? "pending", effectiveRole),
        meQuery.data?.user_id ?? "pending",
        viewerMode ? "viewer-mode" : "member-mode",
      ] as const,
    [effectiveRole, meQuery.data?.user_id, tenantId, viewerMode],
  );

  const settings = useQuery({
    queryKey: [...keyBase, "winback-settings"],
    queryFn: getWinbackSettings,
    staleTime: STALE.reference,
    enabled: canLoad,
  });
  const offers = useQuery({
    queryKey: [...keyBase, "offers"],
    queryFn: () => {
      if (tenantId === null) {
        throw new Error("Retention offer query has no active tenant identity");
      }
      return listRetentionOffers(tenantId);
    },
    staleTime: STALE.list,
    enabled: canLoad,
  });
  const funnel = useQuery({
    queryKey: [...keyBase, "funnel"],
    queryFn: getRetentionFunnel,
    staleTime: STALE.list,
    enabled: canLoad,
  });
  // commerce-59: the paid-tier catalogue exists only to LABEL an offer. A
  // failure here must therefore degrade to a tier reference, never block the
  // offer rows or be reported as an offer-loading failure.
  const tiers = useQuery({
    queryKey: [...keyBase, "paywall-tiers"],
    queryFn: listRetentionTiers,
    staleTime: STALE.reference,
    enabled: canLoad,
  });

  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<RetentionStatusFilter>("all");
  const [discount, setDiscount] = useState<RetentionDiscountFilter>("all");
  const [evidence, setEvidence] = useState<RetentionEvidenceFilter>("all");
  const [sort, setSort] = useState<RetentionHistorySort>("newest");
  const [offset, setOffset] = useState(0);
  const [selectedOfferId, setSelectedOfferId] = useState<string | null>(null);

  const config = settings.data;
  const inert = config ? scoredButInert(config) : false;
  const offerRows = useMemo(
    () => (Array.isArray(offers.data?.offers) ? offers.data.offers : []),
    [offers.data?.offers],
  );
  const tiles = useMemo(
    () => (Array.isArray(funnel.data?.tiles) ? funnel.data.tiles : []),
    [funnel.data?.tiles],
  );
  const catalogueRead = !tiers.isError && tiers.data !== undefined;
  const tierNames = useMemo(
    () =>
      new Map(
        (catalogueRead ? (tiers.data ?? []) : []).map((tier) => [
          tier.id,
          tier.name,
        ]),
      ),
    [catalogueRead, tiers.data],
  );

  // Nulls here are load-bearing: they mean "that read did not succeed", which
  // is what keeps a failed funnel from rendering as an offer with no activity.
  const rows = useMemo(
    () =>
      buildRetentionOfferRows(
        offerRows,
        funnel.isError || funnel.data === undefined ? null : tiles,
        catalogueRead ? (tiers.data ?? []) : null,
      ),
    [catalogueRead, funnel.data, funnel.isError, offerRows, tiers.data, tiles],
  );
  const matching = useMemo(
    () =>
      sortRetentionOfferRows(
        filterRetentionOfferRows(rows, {
          query,
          status,
          discount,
          evidence,
        }),
        sort,
      ),
    [discount, evidence, query, rows, sort, status],
  );
  // A refetch can shrink the result set under an offset the user already paged
  // to (offers deactivated, rows filtered out). Slicing by the raw offset then
  // renders nothing AND drops below the pager's render gate, so the controls
  // that would take the user back unmount. Clamp the way landing-pages and
  // submissions do, and read the clamped value everywhere the pager does.
  const clampedOffset = Math.min(
    offset,
    Math.max(
      0,
      (Math.ceil(matching.length / RETENTION_HISTORY_PAGE_SIZE) - 1) *
        RETENTION_HISTORY_PAGE_SIZE,
    ),
  );
  const pageRows = matching.slice(
    clampedOffset,
    clampedOffset + RETENTION_HISTORY_PAGE_SIZE,
  );
  const selectedRow: RetentionOfferRow | null =
    rows.find((row) => row.offer.id === selectedOfferId) ?? null;

  useEffect(() => {
    setOffset(0);
  }, [discount, evidence, query, sort, status]);

  return (
    <PageShell className="max-w-6xl">
      <EngagementPageHeader
        eyebrow="Audience recovery"
        title="Win-back"
        description="Review stored churn-scoring settings, offer rows, and aggregate counters without treating them as proof of a live automation."
        icon={<Heart aria-hidden />}
      />

      <EngagementIdentityGate
        pending={meQuery.isPending}
        error={meQuery.isError || !meQuery.data}
        retrying={meQuery.isFetching}
        onRetry={() => void meQuery.refetch()}
      >
        {!canLoad ? (
          <section
            aria-labelledby="retention-scope-title"
            className="rounded-xl border bg-card p-4 shadow-sm sm:p-6"
          >
            <h2
              id="retention-scope-title"
              className="text-base font-semibold tracking-tight"
            >
              Owner or admin access required
            </h2>
            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
              Retention settings, offer rows, and aggregate funnel counters were
              not requested. Exit viewer mode or ask a workspace owner or admin
              for access.
            </p>
          </section>
        ) : (
          <>
            <div
              className="mb-6 rounded-lg border border-warning/30 bg-warning/5 p-4 text-sm leading-relaxed text-muted-foreground"
              role="note"
            >
              <strong className="text-foreground">
                Runtime delivery unavailable.
              </strong>{" "}
              Automated win-back dispatch is {RETENTION_WINBACK_RELEASE_VERDICT}{" "}
              ({RETENTION_WINBACK_RELEASE_HOLD_CODE}). Stored settings, scores,
              offers, and funnel rows do not prove enrollment, delivery, portal
              acceptance, or coupon application.
            </div>
            <EngagementSurface
              id="wb-settings"
              title="Churn scoring posture"
              description="This is stored configuration and scoring coverage; the outbound worker is not mounted."
            >
              {settings.isPending ? (
                <EngagementLoading label="Loading win-back settings" />
              ) : settings.isError || !config ? (
                <EngagementQueryError
                  title="Win-back settings could not be loaded"
                  description="Automation and churn coverage are unknown; no subscriber is being represented as eligible."
                  retrying={settings.isFetching}
                  onRetry={() => void settings.refetch()}
                />
              ) : (
                <>
                  <div className="grid gap-3 sm:grid-cols-3">
                    <EngagementMetric
                      label="Stored switch"
                      value={config.enabled ? "Enabled" : "Disabled"}
                      tone="warning"
                    />
                    <EngagementMetric
                      label="Risk threshold"
                      value={formatChurnThreshold(config.churn_threshold)}
                      hint="The wire value is a probability; this is shown as a percentage."
                    />
                    <EngagementMetric
                      label="Profiles scored"
                      value={config.churn_profiles_scored.toLocaleString()}
                    />
                  </div>
                  {inert ? (
                    <p className="mt-4 rounded-lg border border-warning/30 bg-warning/5 p-3 text-sm leading-relaxed text-muted-foreground">
                      {config.churn_profiles_scored.toLocaleString()} subscriber
                      {config.churn_profiles_scored === 1 ? " has" : "s have"} a
                      churn score and the stored switch is disabled. Runtime
                      delivery is unavailable regardless of score.
                    </p>
                  ) : config.enabled ? (
                    <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
                      The stored switch is enabled at{" "}
                      {formatChurnThreshold(config.churn_threshold)}
                      risk. It does not enroll a subscriber or start delivery in
                      this release.
                    </p>
                  ) : (
                    <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
                      The stored switch is disabled and no profiles have been
                      scored yet. This is configuration state, not a
                      healthy-retention or runtime-delivery verdict.
                    </p>
                  )}
                </>
              )}
            </EngagementSurface>

            <EngagementSurface
              id="wb-offers"
              title="Retention offers"
              description="Stored offer configuration. A row marked active is not a mounted campaign, portal, or dispatch path."
              className="mb-6"
            >
              {offers.isPending ? (
                <EngagementLoading label="Loading retention offers" />
              ) : offers.isError ? (
                <EngagementQueryError
                  title="Retention offers could not be loaded"
                  description="A failed request is not shown as an offer-free workspace."
                  retrying={offers.isFetching}
                  onRetry={() => void offers.refetch()}
                />
              ) : offerRows.length === 0 ? (
                <EngagementEmpty
                  title="No retention offers configured"
                  description="The request completed successfully and returned no stored offer rows. Authoring and delivery are unavailable in this release."
                />
              ) : (
                <>
                  {/* commerce-57: the service mounts no query parameters for
                      this list, so every control below narrows the bounded
                      (≤1,000-row) result already in hand. */}
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    <div className="lg:col-span-3">
                      <Label htmlFor="wb-offer-search">
                        Search retained offers
                      </Label>
                      <Input
                        id="wb-offer-search"
                        type="search"
                        className="mt-1.5"
                        value={query}
                        maxLength={256}
                        placeholder="Tier, offer ID, headline, state, or amount"
                        onChange={(event) => setQuery(event.target.value)}
                      />
                    </div>
                    <div>
                      <Label htmlFor="wb-offer-state">Stored state</Label>
                      <Select
                        id="wb-offer-state"
                        className="mt-1.5"
                        value={status}
                        onChange={(event) =>
                          setStatus(event.target.value as RetentionStatusFilter)
                        }
                      >
                        <option value="all">All states</option>
                        <option value="active">Active records</option>
                        <option value="inactive">Inactive records</option>
                      </Select>
                    </div>
                    <div>
                      <Label htmlFor="wb-offer-discount">Discount</Label>
                      <Select
                        id="wb-offer-discount"
                        className="mt-1.5"
                        value={discount}
                        onChange={(event) =>
                          setDiscount(
                            event.target.value as RetentionDiscountFilter,
                          )
                        }
                      >
                        <option value="all">All discounts</option>
                        <option value="percent">Percent</option>
                        <option value="fixed">Fixed amount</option>
                      </Select>
                    </div>
                    <div>
                      <Label htmlFor="wb-offer-evidence">Evidence</Label>
                      <Select
                        id="wb-offer-evidence"
                        className="mt-1.5"
                        value={evidence}
                        onChange={(event) =>
                          setEvidence(
                            event.target.value as RetentionEvidenceFilter,
                          )
                        }
                      >
                        <option value="all">All evidence</option>
                        <option value="measured">Measured</option>
                        <option value="zero">Zero shown</option>
                        <option value="unknown">Unknown or missing</option>
                        <option value="anomaly">
                          Row reconciliation issues
                        </option>
                      </Select>
                    </div>
                    <div>
                      <Label htmlFor="wb-offer-sort">Order</Label>
                      <Select
                        id="wb-offer-sort"
                        className="mt-1.5"
                        value={sort}
                        onChange={(event) =>
                          setSort(event.target.value as RetentionHistorySort)
                        }
                      >
                        <option value="newest">Newest recorded</option>
                        <option value="oldest">Oldest recorded</option>
                        <option value="updated-desc">Recently updated</option>
                        <option value="tier-asc">Tier A–Z</option>
                        <option value="shown-desc">Most shown</option>
                        <option value="accepted-desc">Most accepted</option>
                      </Select>
                    </div>
                  </div>

                  <p
                    role="status"
                    className="mt-3 text-xs text-muted-foreground"
                  >
                    {matching.length.toLocaleString()} matching{" "}
                    {matching.length === 1 ? "offer" : "offers"} of{" "}
                    {rows.length.toLocaleString()} stored.
                    {tiers.isError
                      ? " Tier names could not be read, so tiers are shown by reference."
                      : ""}
                  </p>

                  {matching.length === 0 ? (
                    <div className="mt-4">
                      <EngagementEmpty
                        title="No stored offer matches these controls"
                        description="Every stored row was filtered out here. This is the effect of the controls above, not an empty workspace."
                      />
                    </div>
                  ) : (
                    <ul
                      className="mt-4 space-y-3"
                      aria-label="Retention offers"
                    >
                      {pageRows.map((row) => (
                        <li
                          key={row.offer.id}
                          className="rounded-lg border bg-background/60 p-3"
                        >
                          <div className="flex flex-wrap items-start justify-between gap-2">
                            <div className="min-w-0">
                              <p className="break-words text-sm font-medium">
                                {row.offer.headline || "Untitled offer"}
                              </p>
                              <p className="mt-1 text-xs text-muted-foreground">
                                {retentionTierLabel(row, catalogueRead)} ·{" "}
                                {formatOfferDiscount(
                                  row.offer.percent_off,
                                  row.offer.fixed_off_cents,
                                )}
                                {row.offer.duration_months > 0
                                  ? ` for ${row.offer.duration_months} month${row.offer.duration_months === 1 ? "" : "s"}`
                                  : ""}
                              </p>
                            </div>
                            <span className="shrink-0 rounded-full border px-2 py-0.5 text-xs text-muted-foreground">
                              {row.offer.active
                                ? "Marked active"
                                : "Marked inactive"}
                            </span>
                          </div>
                          {row.offer.body ? (
                            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                              {row.offer.body}
                            </p>
                          ) : null}
                          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                            <p className="text-xs text-muted-foreground">
                              {retentionEvidenceLabel(row.evidence)} · updated{" "}
                              {offerTimestamp(row.offer.updated_at)}
                            </p>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="min-h-11 shrink-0 sm:min-h-9"
                              aria-label={`Inspect ${row.offer.headline || "untitled offer"}`}
                              onClick={() => setSelectedOfferId(row.offer.id)}
                            >
                              Inspect
                            </Button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}

                  {matching.length > RETENTION_HISTORY_PAGE_SIZE ? (
                    <nav
                      aria-label="Retention offer pages"
                      className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t pt-4"
                    >
                      <p
                        aria-live="polite"
                        className="text-xs text-muted-foreground"
                      >
                        Page{" "}
                        {(
                          Math.floor(
                            clampedOffset / RETENTION_HISTORY_PAGE_SIZE,
                          ) + 1
                        ).toLocaleString()}{" "}
                        of{" "}
                        {Math.max(
                          1,
                          Math.ceil(
                            matching.length / RETENTION_HISTORY_PAGE_SIZE,
                          ),
                        ).toLocaleString()}
                      </p>
                      <div className="flex items-center gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="min-h-11 sm:min-h-9"
                          disabled={clampedOffset === 0}
                          onClick={() =>
                            setOffset(
                              Math.max(
                                0,
                                clampedOffset - RETENTION_HISTORY_PAGE_SIZE,
                              ),
                            )
                          }
                        >
                          <ChevronLeft aria-hidden />
                          Previous
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="min-h-11 sm:min-h-9"
                          disabled={
                            clampedOffset + RETENTION_HISTORY_PAGE_SIZE >=
                            matching.length
                          }
                          onClick={() =>
                            setOffset(
                              clampedOffset + RETENTION_HISTORY_PAGE_SIZE,
                            )
                          }
                        >
                          Next
                          <ChevronRight aria-hidden />
                        </Button>
                      </div>
                    </nav>
                  ) : null}
                </>
              )}
            </EngagementSurface>

            <div className="grid gap-6">
              <EngagementSurface
                id="wb-funnel"
                title="Recorded offer funnel"
                description="Historical counters returned by the service; a missing funnel is not treated as zero, and a counter is not proof that a current delivery path is mounted."
              >
                {funnel.isPending ? (
                  <EngagementLoading label="Loading retention funnel" />
                ) : funnel.isError ? (
                  <EngagementQueryError
                    title="Retention funnel could not be loaded"
                    description="Offer outcomes are unavailable until the funnel request succeeds."
                    retrying={funnel.isFetching}
                    onRetry={() => void funnel.refetch()}
                  />
                ) : tiles.length === 0 ? (
                  <EngagementEmpty
                    title="No offer outcomes yet"
                    description="No funnel stages were recorded. That may mean no offer has been shown, not that every shown offer was declined."
                  />
                ) : (
                  <ul
                    className="space-y-3"
                    aria-label="Retention funnel by offer"
                  >
                    {tiles.map((tile) => (
                      <li
                        key={tile.offer_id}
                        className="rounded-lg border bg-background/60 p-3"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="min-w-0">
                            {/* commerce-59: the catalogue name when it is
                                known; the raw reference is a fallback, not the
                                default. */}
                            <p className="text-sm font-medium">
                              {tierNames.get(tile.tier_id) ??
                                `Tier ${tile.tier_id.slice(0, 8)}…`}
                            </p>
                            <p className="mt-0.5 break-all text-xs text-muted-foreground">
                              Offer {tile.offer_id}
                            </p>
                          </div>
                          <span className="text-sm font-semibold tabular-nums">
                            {formatAcceptanceRate(tile)} acceptance
                          </span>
                        </div>
                        <dl className="mt-3 grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
                          {[
                            ["Shown", tile.shown],
                            ["Accepted", tile.accepted],
                            ["Declined", tile.declined],
                            ["Expired", tile.expired],
                          ].map(([label, value]) => (
                            <div key={String(label)}>
                              <dt className="text-muted-foreground">{label}</dt>
                              <dd className="font-medium tabular-nums">
                                {Number(value).toLocaleString()}
                              </dd>
                            </div>
                          ))}
                        </dl>
                        {hasRetentionOutcomeConflict(tile) ? (
                          <p className="mt-3 text-xs text-amber-700 dark:text-amber-300">
                            Outcome-count conflict: accepted, declined, and
                            expired exceed shown. Raw counters remain visible,
                            but no acceptance rate is computed.
                          </p>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
              </EngagementSurface>
            </div>

            {/* commerce-58: renders the already-loaded row. It reads nothing
                new, edits nothing, and certifies no provider delivery. */}
            <Dialog
              open={selectedOfferId !== null}
              onOpenChange={(open) => {
                if (!open) setSelectedOfferId(null);
              }}
            >
              <DialogContent className="max-w-xl">
                <DialogHeader>
                  <DialogTitle>
                    {selectedRow?.offer.headline || "Untitled retention offer"}
                  </DialogTitle>
                  <DialogDescription>
                    {selectedRow
                      ? `${retentionTierLabel(selectedRow, catalogueRead)} · ${
                          selectedRow.offer.active
                            ? "Marked active"
                            : "Marked inactive"
                        }`
                      : "No offer is selected."}
                  </DialogDescription>
                </DialogHeader>
                {selectedRow ? (
                  <div className="space-y-4">
                    <p
                      role="status"
                      className="rounded-lg border bg-muted/30 p-3 text-sm"
                    >
                      <strong className="font-semibold">
                        {retentionEvidenceLabel(selectedRow.evidence)}
                      </strong>{" "}
                      This drawer never edits an offer or certifies provider
                      delivery.
                    </p>
                    <dl className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      {[
                        [
                          "Discount",
                          formatOfferDiscount(
                            selectedRow.offer.percent_off,
                            selectedRow.offer.fixed_off_cents,
                          ),
                        ],
                        [
                          "Duration",
                          `${selectedRow.offer.duration_months.toLocaleString()} ${
                            selectedRow.offer.duration_months === 1
                              ? "month"
                              : "months"
                          }`,
                        ],
                        [
                          "Coupon reference",
                          selectedRow.offer.provider_coupon_present
                            ? "Present"
                            : "Not recorded",
                        ],
                        [
                          "Created",
                          offerTimestamp(selectedRow.offer.created_at),
                        ],
                        [
                          "Last stored update",
                          offerTimestamp(selectedRow.offer.updated_at),
                        ],
                        ["Record reference", selectedRow.offer.id],
                      ].map(([label, value]) => (
                        <div
                          key={label}
                          className="min-w-0 rounded-lg bg-muted/30 p-2.5"
                        >
                          <dt className="text-xs text-muted-foreground">
                            {label}
                          </dt>
                          <dd className="mt-0.5 break-all text-sm font-medium">
                            {value}
                          </dd>
                        </div>
                      ))}
                    </dl>
                    <div>
                      <p className="text-xs uppercase tracking-wide text-muted-foreground">
                        Stored customer-facing copy
                      </p>
                      <p className="mt-1 text-sm leading-relaxed">
                        {selectedRow.offer.body || "No body copy recorded."}
                      </p>
                    </div>
                    {selectedRow.funnel &&
                    (selectedRow.evidence === "measured" ||
                      selectedRow.evidence === "zero") ? (
                      <dl className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-5">
                        {[
                          ["Shown", selectedRow.funnel.shown],
                          ["Accepted", selectedRow.funnel.accepted],
                          ["Declined", selectedRow.funnel.declined],
                          ["Expired", selectedRow.funnel.expired],
                        ].map(([label, value]) => (
                          <div key={String(label)}>
                            <dt className="text-muted-foreground">{label}</dt>
                            <dd className="font-medium tabular-nums">
                              {Number(value).toLocaleString()}
                            </dd>
                          </div>
                        ))}
                        <div>
                          <dt className="text-muted-foreground">
                            Derived acceptance
                          </dt>
                          <dd className="font-medium tabular-nums">
                            {formatAcceptanceRate(selectedRow.funnel)}
                          </dd>
                        </div>
                      </dl>
                    ) : (
                      <p
                        role="note"
                        className="rounded-lg border border-warning/30 bg-warning/5 p-3 text-xs leading-relaxed text-muted-foreground"
                      >
                        Counts remain withheld for this offer. That is not
                        evidence the offer has zero activity — it is the absence
                        of a reconciled funnel row.
                      </p>
                    )}
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      Audience or segment, attribution source, recovered
                      revenue, and a provider application receipt are not
                      available from this API.
                    </p>
                  </div>
                ) : null}
                <div className="flex justify-end">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setSelectedOfferId(null)}
                  >
                    Close
                  </Button>
                </div>
              </DialogContent>
            </Dialog>
          </>
        )}
      </EngagementIdentityGate>
    </PageShell>
  );
}
