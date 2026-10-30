// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * Gift history — the sanitized lifecycle archive (commerce-33/34/35).
 *
 * Source quality already showed the gift AGGREGATE. An aggregate cannot answer
 * the question an operator actually arrives with: which record, and is what it
 * says about itself internally consistent? "12 redeemed" is compatible with
 * twelve rows that claim redemption and carry no redemption timestamp.
 *
 * So the archive is read at record level, with three things the totals cannot
 * express: a record whose fields contradict each other is reported as a data
 * issue rather than under its claimed state; the page-local "Review this page"
 * filter isolates exactly those; and the detail read re-fetches the record from
 * the server instead of re-rendering the row it was opened from.
 *
 * NOTHING HERE WRITES. The gateway mounts three gift routes — list, stats and
 * one record — and deliberately leaves creation, cancellation, redemption and
 * export unmounted (apps/api/internal/paid_tiers/gifts.go:544-546). A control
 * for any of those would be an invitation to a 404, so none exists, and the
 * boundary is stated on the page rather than left to be discovered.
 */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Gift,
  Search,
  ShieldCheck,
} from "lucide-react";

import { PageShell } from "@/components/dashboard/page-shell";
import {
  GovernanceEmpty,
  GovernanceError,
  GovernanceLoading,
  GovernanceMetrics,
  GovernancePageHeader,
  GovernanceSection,
} from "@/components/governance/governance-ui";
import { Badge } from "@/components/ui/badge";
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
import { apiErrorMessage } from "@/lib/api";
import { whoami } from "@/lib/auth-api";
import {
  GIFT_HISTORY_PAGE_SIZE,
  MAX_GIFT_HISTORY_OFFSET,
  formatGiftTimestamp,
  giftHistoryCounts,
  giftHistoryMatchesFilter,
  giftHistorySearchPrefix,
  giftHistoryServerFilter,
  giftHistoryState,
  giftStateBadgeVariant,
  giftStateLabel,
  sanitizeGiftHistorySearchInput,
  type GiftHistoryFilter,
  type GiftHistoryRecord,
  type GiftHistorySort,
} from "@/lib/gift-history";
import {
  getGiftStats,
  getGiftSubscription,
  listGiftSubscriptions,
} from "@/lib/monetisation-api";
import { base, STALE } from "@/lib/query-keys";
import { asRoute } from "@/lib/typed-routes";

const FILTERS: ReadonlyArray<{ id: GiftHistoryFilter; label: string }> = [
  { id: "all", label: "All records" },
  { id: "open", label: "Open lifecycle" },
  { id: "redeemed", label: "Redeemed" },
  { id: "closed", label: "Closed" },
  { id: "cancelled", label: "Cancelled" },
  { id: "expired", label: "Expired" },
  { id: "refunded", label: "Refunded" },
  { id: "data_issue", label: "Readable issues on this page" },
];

const SORTS: ReadonlyArray<{ id: GiftHistorySort; label: string }> = [
  { id: "newest", label: "Newest recorded first" },
  { id: "oldest", label: "Oldest recorded first" },
  { id: "duration", label: "Longest duration first" },
  { id: "status", label: "Lifecycle state" },
];

function durationLabel(months: number | null): string {
  if (months === null) return "Unavailable";
  return `${months.toLocaleString()} ${months === 1 ? "month" : "months"}`;
}

function evidenceLabel(present: boolean | null): string {
  if (present === true) return "recorded";
  if (present === false) return "not recorded";
  return "unknown";
}

export default function GiftHistoryPage() {
  const meQuery = useQuery({
    queryKey: ["whoami"],
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const keyBase = useMemo(
    () =>
      base(
        "gift-history",
        meQuery.data?.tenant_id ?? "anon",
        meQuery.data?.role ?? null,
      ),
    [meQuery.data?.role, meQuery.data?.tenant_id],
  );

  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<GiftHistoryFilter>("all");
  const [sort, setSort] = useState<GiftHistorySort>("newest");
  const [offset, setOffset] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // A half-typed prefix must not send a request, and must not silently widen
  // the current result to the whole archive either. Only a complete, valid
  // prefix (or an empty box) changes what is asked for.
  const searchPrefix = giftHistorySearchPrefix(search);
  const invalidSearch = search.trim() !== "" && searchPrefix === undefined;
  const acceptedPrefix = search.trim() === "" ? undefined : searchPrefix;
  const serverFilter = giftHistoryServerFilter(filter);

  useEffect(() => {
    setOffset(0);
  }, [acceptedPrefix, filter, sort]);

  const history = useQuery({
    queryKey: [
      ...keyBase,
      "page",
      {
        limit: GIFT_HISTORY_PAGE_SIZE,
        offset,
        q: acceptedPrefix ?? null,
        filter: serverFilter ?? "all",
        sort,
      },
    ],
    queryFn: () =>
      listGiftSubscriptions({
        limit: GIFT_HISTORY_PAGE_SIZE,
        offset,
        q: acceptedPrefix,
        filter: serverFilter,
        sort,
      }),
    enabled: meQuery.isFetched,
    staleTime: STALE.list,
  });
  const stats = useQuery({
    queryKey: [...keyBase, "stats"],
    queryFn: getGiftStats,
    enabled: meQuery.isFetched,
    staleTime: STALE.dashboard,
  });
  const detail = useQuery({
    queryKey: [...keyBase, "record", selectedId ?? "none"],
    queryFn: () => {
      if (selectedId === null) {
        throw new Error("Gift detail query has no selected record");
      }
      return getGiftSubscription(selectedId);
    },
    enabled: selectedId !== null,
    staleTime: STALE.detail,
  });

  const page = history.data ?? null;
  const g = stats.data;
  const records = useMemo(
    () => (Array.isArray(page?.items) ? page.items : []),
    [page?.items],
  );
  const counts = useMemo(() => giftHistoryCounts(records), [records]);
  // `data_issue` is not a server filter — the server has no notion of a row
  // contradicting itself — so it is applied to the page that came back.
  const visible =
    filter === "data_issue"
      ? records.filter((r) => giftHistoryMatchesFilter(r, "data_issue"))
      : records;
  const integrityCount =
    counts.data_issue +
    (page?.rejectedRows ?? 0) +
    (page?.envelopeIssues?.length ?? 0);
  const refreshing =
    meQuery.isFetching || history.isFetching || stats.isFetching;

  const selected: GiftHistoryRecord | null =
    detail.data ?? records.find((r) => r.sourceRecordID === selectedId) ?? null;

  const first = page && page.items?.length > 0 ? page.offset + 1 : 0;
  const last = page ? Math.min(page.offset + page.items.length, page.total) : 0;
  const canPrevious = page !== null && page.offset > 0;
  const canNext =
    page !== null &&
    page.offset + page.items.length < page.total &&
    page.offset + page.limit <= MAX_GIFT_HISTORY_OFFSET;

  return (
    <PageShell className="max-w-5xl [&_[data-slot=button]]:min-h-11 sm:[&_[data-slot=button]]:min-h-9">
      <div>
        <Link
          href={asRoute("/app/source-quality")}
          className="inline-flex min-h-11 items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground sm:min-h-0"
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
          Back to source quality
        </Link>
      </div>

      <GovernancePageHeader
        icon={Gift}
        eyebrow="Commerce evidence"
        title="Gift history"
        description="Record-level gift lifecycle evidence. A record whose stored fields contradict each other is reported as a data issue, never counted as healthy history."
        refreshLabel="Refresh evidence"
        refreshing={refreshing}
        onRefresh={() => {
          void history.refetch();
          void stats.refetch();
        }}
      />

      <GovernanceSection
        icon={Gift}
        title="Lifecycle summary"
        description="Aggregate totals for the whole archive. Select a total to narrow the records below to it."
      >
        {stats.isPending ? (
          <GovernanceLoading label="Loading gift-subscription statistics…" />
        ) : stats.isError ? (
          <GovernanceError
            message={apiErrorMessage(
              stats.error,
              "Could not load gift statistics. No lifecycle count or conversion is being inferred; the records below remain readable.",
            )}
            retrying={stats.isFetching}
            onRetry={() => void stats.refetch()}
          />
        ) : g ? (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {(
              [
                {
                  label: "Total archive",
                  value: g.total,
                  note: "Every stored lifecycle",
                  target: "all" as GiftHistoryFilter,
                },
                {
                  label: "Redeemed",
                  value: g.granted,
                  note: "Access recorded",
                  target: "redeemed" as GiftHistoryFilter,
                },
                {
                  label: "Open",
                  value: g.pending + g.paid,
                  note: `${g.pending.toLocaleString()} pending · ${g.paid.toLocaleString()} paid`,
                  target: "open" as GiftHistoryFilter,
                },
                {
                  label: "Closed",
                  value: g.granted + g.canceled + g.expired + g.refunded,
                  note: "Terminal stored outcomes",
                  target: "closed" as GiftHistoryFilter,
                },
              ] as const
            ).map((cell) => (
              <button
                key={cell.label}
                type="button"
                aria-pressed={filter === cell.target}
                onClick={() => setFilter(cell.target)}
                className={
                  filter === cell.target
                    ? "min-w-0 rounded-xl border border-primary bg-primary/5 p-3.5 text-left"
                    : "min-w-0 rounded-xl border bg-muted/25 p-3.5 text-left hover:border-ring/40"
                }
              >
                <span className="block text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {cell.label}
                </span>
                <span className="mt-1 block text-xl font-semibold tabular-nums tracking-tight">
                  {cell.value.toLocaleString()}
                </span>
                <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                  {cell.note}
                </span>
              </button>
            ))}
          </div>
        ) : (
          <GovernanceEmpty>No gift statistics reported.</GovernanceEmpty>
        )}
        <p className="mt-3 text-xs leading-5 text-muted-foreground">
          Aggregate generated{" "}
          {formatGiftTimestamp(g?.generated_at ?? null) ||
            "at an unstated time"}
          . Records verified{" "}
          {formatGiftTimestamp(page?.snapshotAt ?? null) || "not yet"}.
        </p>
      </GovernanceSection>

      <GovernanceSection
        icon={Search}
        title="Archive explorer"
        description="Search is limited to the server-authored record prefix. This reporting scope cannot probe purchaser or recipient identity."
      >
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="sm:col-span-1">
            <Label htmlFor="gift-search">Record prefix</Label>
            <Input
              id="gift-search"
              type="search"
              className="mt-1.5"
              value={search}
              maxLength={96}
              autoComplete="off"
              placeholder="8–32 hex characters"
              aria-invalid={invalidSearch}
              aria-describedby="gift-search-boundary"
              onChange={(event) =>
                setSearch(sanitizeGiftHistorySearchInput(event.target.value))
              }
            />
          </div>
          <div>
            <Label htmlFor="gift-filter">Lifecycle</Label>
            <Select
              id="gift-filter"
              className="mt-1.5"
              value={filter}
              onChange={(event) =>
                setFilter(event.target.value as GiftHistoryFilter)
              }
            >
              {FILTERS.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="gift-sort">Order</Label>
            <Select
              id="gift-sort"
              className="mt-1.5"
              value={sort}
              onChange={(event) =>
                setSort(event.target.value as GiftHistorySort)
              }
            >
              {SORTS.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label}
                </option>
              ))}
            </Select>
          </div>
        </div>
        <p
          id="gift-search-boundary"
          role="status"
          className={
            invalidSearch
              ? "mt-3 text-xs leading-5 text-warning-emphasis"
              : "mt-3 text-xs leading-5 text-muted-foreground"
          }
        >
          {invalidSearch
            ? "Enter 8–32 hexadecimal characters from a gift record label. The current result stays in place; nothing is sent until the prefix is valid."
            : "Records are searched by the opaque archive record prefix only."}
        </p>
      </GovernanceSection>

      <GovernanceSection
        icon={ShieldCheck}
        title="Record-level evidence"
        description="Each card is the sanitized archive projection: no purchaser, recipient, message, or provider identifier crosses this boundary."
      >
        {integrityCount > 0 && page ? (
          <div
            role="status"
            className="mb-4 flex flex-col gap-3 rounded-lg border border-warning/30 bg-warning/5 p-3 sm:flex-row sm:items-center sm:justify-between"
          >
            <p className="min-w-0 text-sm leading-5">
              <strong className="font-semibold">
                Archive integrity needs review.
              </strong>{" "}
              {counts.data_issue.toLocaleString()} readable{" "}
              {counts.data_issue === 1 ? "record has" : "records have"} field
              warnings
              {page.rejectedRows > 0
                ? `; ${page.rejectedRows.toLocaleString()} contract-invalid ${page.rejectedRows === 1 ? "row was" : "rows were"} contained`
                : ""}
              {page.envelopeIssues.length > 0
                ? `; ${page.envelopeIssues.length.toLocaleString()} envelope ${page.envelopeIssues.length === 1 ? "warning was" : "warnings were"} detected`
                : ""}
              . Nothing has been silently treated as healthy.
            </p>
            <Button
              type="button"
              variant="outline"
              className="shrink-0 bg-background sm:self-start"
              onClick={() => setFilter("data_issue")}
            >
              Review this page
            </Button>
          </div>
        ) : null}

        {history.isPending ? (
          <GovernanceLoading label="Loading gift lifecycle records…" rows={4} />
        ) : history.isError ? (
          <GovernanceError
            message={apiErrorMessage(
              history.error,
              "Could not load gift history. This is a failed request, not an empty archive.",
            )}
            retrying={history.isFetching}
            onRetry={() => void history.refetch()}
          />
        ) : visible.length === 0 ? (
          <GovernanceEmpty>
            {filter === "data_issue"
              ? "No readable field issues appear on this page. This review mode is page-local; continue through the archive to inspect later pages."
              : acceptedPrefix !== undefined || filter !== "all"
                ? "Nothing on this page matches these controls."
                : "No gift lifecycle records are on file. Records appear only after a separately verified commerce system writes them; this workspace cannot issue a gift."}
          </GovernanceEmpty>
        ) : (
          <ul className="space-y-3" aria-label="Gift lifecycle records">
            {visible.map((record) => {
              const state = giftHistoryState(record);
              return (
                <li
                  key={record.key}
                  className="min-w-0 rounded-xl border bg-background/60 p-4"
                >
                  <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-xs uppercase tracking-wide text-muted-foreground">
                        Sanitized archive record
                      </p>
                      <p className="mt-0.5 break-words text-sm font-medium">
                        {record.label}
                      </p>
                    </div>
                    <Badge variant={giftStateBadgeVariant(state)}>
                      {giftStateLabel(state)}
                    </Badge>
                  </div>
                  <dl className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
                    {[
                      ["Plan class", record.planLabel],
                      ["Duration", durationLabel(record.durationMonths)],
                      [
                        "Recorded",
                        formatGiftTimestamp(record.createdAt) || "Unavailable",
                      ],
                    ].map(([label, value]) => (
                      <div
                        key={label}
                        className="min-w-0 rounded-lg bg-muted/30 p-2.5"
                      >
                        <dt className="text-xs text-muted-foreground">
                          {label}
                        </dt>
                        <dd className="mt-0.5 break-words text-sm font-medium">
                          {value}
                        </dd>
                      </div>
                    ))}
                  </dl>
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                    <p className="min-w-0 text-xs leading-5 text-muted-foreground">
                      Provider reference:{" "}
                      {evidenceLabel(record.providerInvoiceLinked)} · Recipient
                      member: {evidenceLabel(record.recipientMemberLinked)}
                      {record.issues.length > 0
                        ? ` · ${record.issues.length.toLocaleString()} integrity ${record.issues.length === 1 ? "warning" : "warnings"}`
                        : ""}
                    </p>
                    <Button
                      type="button"
                      variant="outline"
                      className="shrink-0"
                      disabled={record.sourceRecordID === null}
                      aria-label={`Inspect ${record.label}`}
                      onClick={() => setSelectedId(record.sourceRecordID)}
                    >
                      Inspect evidence
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {page && page.total > 0 ? (
          <nav
            aria-label="Gift history pages"
            className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t pt-4"
          >
            <p aria-live="polite" className="text-xs text-muted-foreground">
              Showing {first.toLocaleString()}–{last.toLocaleString()} of{" "}
              {page.total.toLocaleString()}
              {page.offset + page.limit > MAX_GIFT_HISTORY_OFFSET &&
              page.offset + page.items.length < page.total
                ? " · archive window limit reached; narrow the lifecycle filter or record prefix"
                : ""}
            </p>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={!canPrevious}
                onClick={() => setOffset(Math.max(0, page.offset - page.limit))}
              >
                <ChevronLeft className="size-4" aria-hidden="true" />
                Previous
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={!canNext}
                onClick={() => setOffset(page.offset + page.limit)}
              >
                Next
                <ChevronRight className="size-4" aria-hidden="true" />
              </Button>
            </div>
          </nav>
        ) : null}
      </GovernanceSection>

      <GovernanceSection
        icon={ShieldCheck}
        title="Release boundary"
        description="What this route can and cannot do."
      >
        <p className="text-sm leading-6 text-muted-foreground">
          Historical inspection is the complete route. Gift creation,
          cancellation, editing, payment handoff, redemption, attribution
          identities, provider reconciliation, entitlement changes, and export
          are not mounted by the service and are absent here rather than offered
          and refused.
        </p>
      </GovernanceSection>

      <Dialog
        open={selectedId !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedId(null);
        }}
      >
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>
              {selected?.label ?? "Gift record evidence"}
            </DialogTitle>
            <DialogDescription>
              Re-read from the server. Full gift identifiers, identities, free
              text, and provider objects are not present in this response.
            </DialogDescription>
          </DialogHeader>
          {detail.isPending && selectedId !== null ? (
            <GovernanceLoading label="Verifying gift record…" rows={3} />
          ) : detail.isError ? (
            <GovernanceError
              message={apiErrorMessage(
                detail.error,
                "Could not verify this gift record. No evidence is being shown for it.",
              )}
              retrying={detail.isFetching}
              onRetry={() => void detail.refetch()}
            />
          ) : selected ? (
            <div className="space-y-4">
              <GovernanceMetrics
                columns={2}
                items={[
                  {
                    label: "Lifecycle",
                    value: giftStateLabel(giftHistoryState(selected)),
                  },
                  { label: "Plan class", value: selected.planLabel },
                  {
                    label: "Duration",
                    value: durationLabel(selected.durationMonths),
                  },
                  {
                    label: "Created",
                    value:
                      formatGiftTimestamp(selected.createdAt) || "Unavailable",
                  },
                  {
                    label: "Redeemed",
                    value:
                      formatGiftTimestamp(selected.redeemedAt) ||
                      "Not recorded",
                  },
                  {
                    label: "Expiry boundary",
                    value:
                      formatGiftTimestamp(selected.expiresAt) || "Not recorded",
                  },
                ]}
              />
              <dl className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {[
                  ["Personal message", selected.messageRecorded],
                  [
                    "Provider invoice reference",
                    selected.providerInvoiceLinked,
                  ],
                  ["Gifter member linkage", selected.gifterMemberLinked],
                  ["Recipient member linkage", selected.recipientMemberLinked],
                ].map(([label, present]) => (
                  <div
                    key={String(label)}
                    className="min-w-0 rounded-lg bg-muted/30 p-2.5"
                  >
                    <dt className="text-xs text-muted-foreground">
                      {String(label)}
                    </dt>
                    <dd className="mt-0.5 text-sm font-medium capitalize">
                      {evidenceLabel(present as boolean | null)}
                    </dd>
                  </div>
                ))}
              </dl>
              <p className="text-xs leading-5 text-muted-foreground">
                Linkage flags report presence only. The linked address,
                subscriber, message body, and provider identifier are withheld
                by the server projection.
              </p>
              {selected.issues.length > 0 ? (
                <div
                  role="note"
                  className="rounded-lg border border-warning/30 bg-warning/5 p-3"
                >
                  <p className="text-sm font-semibold">
                    Data integrity warnings
                  </p>
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-xs leading-5 text-muted-foreground">
                    {selected.issues.map((issue) => (
                      <li key={issue}>{issue}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : (
            <GovernanceEmpty>No record is selected.</GovernanceEmpty>
          )}
          <div className="flex justify-end">
            <Button
              type="button"
              variant="outline"
              onClick={() => setSelectedId(null)}
            >
              Close evidence
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </PageShell>
  );
}
