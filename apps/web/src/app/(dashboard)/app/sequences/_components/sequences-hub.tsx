// SPDX-License-Identifier: AGPL-3.0-only
"use client";

//
// Client browser for the sequences hub: search, status filter, sortable
// headers, pagination, multi-select + bulk actions — all URL-persisted so
// refresh and Back restore the operator's place. Covers SEQ-007/011/012/043/
// 051 and reuses the shared list-url-state, RelativeTime, Checkbox, Select and
// FidelityBadge primitives.

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, ChevronsUpDown, Sparkles } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { RelativeTime } from "@/components/relative-time";
import { FidelityBadge } from "@/components/sequences/fidelity-badge";
import { sequenceStatusPresentation } from "@/lib/sequence-operational-availability";
import {
  filterSortSequences,
  sequenceStatusGroup,
  type SequenceSortKey,
  type SequenceStatusFilter,
  type SortDir,
} from "@/lib/sequence-helpers";
import { pluralize } from "@/lib/analytics-format";
import { useTableUrlState } from "@/lib/use-table-url-state";
import { enumParam, intParam, stringParam } from "@/lib/table-url-state";
import { cn } from "@/lib/utils";
import type { SequenceListItem } from "@/lib/voice-types";
import { SequenceRowActions } from "./row-actions";

const PAGE_SIZE = 15;

const HUB_SCHEMA = {
  q: stringParam(""),
  status: enumParam<SequenceStatusFilter>(
    ["all", "draft", "archived", "read-only"],
    "all",
  ),
  sort: enumParam<SequenceSortKey>(["name", "fidelity", "updated"], "updated"),
  dir: enumParam<SortDir>(["asc", "desc"], "desc"),
  page: intParam(1, 1),
};

export function SequencesHub({
  rows,
  notDeployedId,
}: {
  rows: SequenceListItem[];
  /**
   * Set when sequences aren't set up in this environment (the list answered
   * 503 service_not_deployed): the id of the page's notice. The empty state
   * stops claiming "no sequences yet" and its actions stay visible but off,
   * described by that notice.
   */
  notDeployedId?: string;
}) {
  const router = useRouter();
  const { state, setState } = useTableUrlState(HUB_SCHEMA);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkPending, setBulkPending] = useState(false);

  const counts = useMemo(() => {
    const c = { all: rows.length, draft: 0, archived: 0, "read-only": 0 };
    for (const r of rows) c[sequenceStatusGroup(r.status)] += 1;
    return c;
  }, [rows]);

  const filtered = useMemo(
    () =>
      filterSortSequences(rows, {
        query: state.q,
        statusFilter: state.status,
        sort: state.sort,
        dir: state.dir,
      }),
    [rows, state.q, state.status, state.sort, state.dir],
  );

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const page = Math.min(state.page, totalPages);
  const pageRows = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const pageIds = pageRows.map((r) => r.id);
  const allPageSelected =
    pageIds.length > 0 && pageIds.every((id) => selected.has(id));
  const somePageSelected = pageIds.some((id) => selected.has(id));

  const toggleAllOnPage = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allPageSelected) pageIds.forEach((id) => next.delete(id));
      else pageIds.forEach((id) => next.add(id));
      return next;
    });
  };

  const toggleOne = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const setSort = (key: SequenceSortKey) => {
    if (state.sort === key) {
      setState({ dir: state.dir === "asc" ? "desc" : "asc" });
    } else {
      setState({ sort: key, dir: key === "name" ? "asc" : "desc" });
    }
  };

  const selectedRows = rows.filter((r) => selected.has(r.id));
  const archivableSelected = selectedRows.filter((r) => r.status === "draft");

  async function bulkDuplicate() {
    if (bulkPending || selectedRows.length === 0) return;
    setBulkPending(true);
    const ids = selectedRows.map((r) => r.id);
    // The voice client is only needed once a bulk verb fires; loading it here
    // keeps the sequences route's eager chunk inside the bundle budget.
    const { duplicateSequence } = await import("@/lib/voice-api");
    const results = await Promise.allSettled(
      ids.map((id) => duplicateSequence(id)),
    );
    const ok = results.filter((r) => r.status === "fulfilled").length;
    const failed = results.length - ok;
    if (failed > 0)
      toast.error(`Duplicated ${ok} of ${ids.length}; ${failed} failed.`);
    else toast.success(`Duplicated ${pluralize(ok, "sequence")}.`);
    setSelected(new Set());
    setBulkPending(false);
    router.refresh();
  }

  // Restores exactly the ids this bar just archived — the Undo the row menu
  // already offers, applied to the whole batch, because the alternative is one
  // Restore-to-draft trip through every row's menu.
  async function undoBulkArchive(ids: string[]) {
    const { unarchiveSequence } = await import("@/lib/voice-api");
    const results = await Promise.allSettled(
      ids.map((id) => unarchiveSequence(id)),
    );
    const ok = results.filter((r) => r.status === "fulfilled").length;
    if (ok < ids.length) {
      toast.error(
        `Restored ${ok} of ${ids.length}; ${ids.length - ok} are still archived.`,
      );
    } else {
      toast.success(`Restored ${ok} ${pluralize(ok, "draft")} to draft.`);
    }
    router.refresh();
  }

  async function bulkArchive() {
    if (bulkPending || archivableSelected.length === 0) return;
    setBulkPending(true);
    const ids = archivableSelected.map((r) => r.id);
    const { archiveSequence } = await import("@/lib/voice-api");
    const results = await Promise.allSettled(
      ids.map((id) => archiveSequence(id)),
    );
    const archived = ids.filter((_, i) => results[i].status === "fulfilled");
    const failed = ids.length - archived.length;
    const undo =
      archived.length > 0
        ? { label: "Undo", onClick: () => void undoBulkArchive(archived) }
        : undefined;
    if (failed > 0) {
      // The ones that failed stay selected, so "6 failed" names something the
      // operator can still act on instead of vanishing with the selection.
      toast.error(
        `Archived ${archived.length} of ${ids.length}; ${failed} failed.`,
        { action: undo },
      );
      setSelected(new Set(ids.filter((id) => !archived.includes(id))));
    } else {
      toast.success(
        `Archived ${archived.length} ${pluralize(archived.length, "draft")}.`,
        { action: undo },
      );
      setSelected(new Set());
    }
    setBulkPending(false);
    router.refresh();
  }

  const hasFilters = state.q.trim() !== "" || state.status !== "all";
  // Names the count, because a selection survives a page change: the bar can
  // hold far more drafts than the fifteen rows the operator can see.
  const archiveConfirmDescription =
    archivableSelected.length === 1
      ? "Archiving moves this draft out of your working set and makes it read-only. You can restore it to a draft later, or use Undo right after."
      : `Archiving moves these ${archivableSelected.length} drafts out of your working set and makes them read-only. You can restore them to a draft later, or use Undo right after.`;

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1 sm:max-w-sm">
          <Input
            value={state.q}
            onChange={(e) => setState({ q: e.target.value, page: 1 })}
            placeholder="Search by name or template"
            aria-label="Search sequences"
            className="pr-8"
          />
          {state.q ? (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => setState({ q: "", page: 1 })}
              className="absolute right-1 top-1/2 inline-flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              ×
            </button>
          ) : null}
        </div>
        <Select
          value={state.status}
          aria-label="Filter by status"
          onChange={(e) =>
            setState({
              status: e.target.value as SequenceStatusFilter,
              page: 1,
            })
          }
          className="sm:w-56"
        >
          <option value="all">All ({counts.all})</option>
          <option value="draft">Drafts ({counts.draft})</option>
          <option value="archived">Archived ({counts.archived})</option>
          <option value="read-only">Read-only ({counts["read-only"]})</option>
        </Select>
        <Select
          value={`${state.sort}:${state.dir}`}
          aria-label="Sort sequences"
          onChange={(e) => {
            const [sort, dir] = e.target.value.split(":") as [
              SequenceSortKey,
              SortDir,
            ];
            setState({ sort, dir, page: 1 });
          }}
          className="sm:hidden"
        >
          <option value="updated:desc">Recently updated</option>
          <option value="updated:asc">Oldest updated</option>
          <option value="name:asc">Name (A–Z)</option>
          <option value="name:desc">Name (Z–A)</option>
          <option value="fidelity:desc">Highest fidelity</option>
          <option value="fidelity:asc">Lowest fidelity</option>
        </Select>
      </div>

      {selected.size > 0 ? (
        <div className="flex flex-col items-stretch gap-3 rounded-md border bg-accent/40 px-4 py-3 text-sm sm:flex-row sm:flex-wrap sm:items-center sm:py-2">
          <span className="font-medium">{selected.size} selected</span>
          <div className="flex flex-wrap items-center gap-2 sm:ml-auto">
            <Button
              size="sm"
              variant="outline"
              disabled={bulkPending}
              onClick={() => void bulkDuplicate()}
            >
              Duplicate
            </Button>
            {/* The same gate the row menu puts on a single draft. */}
            <ConfirmDialog
              title={`Archive ${archivableSelected.length} ${pluralize(archivableSelected.length, "draft")}?`}
              description={archiveConfirmDescription}
              confirmLabel="Archive"
              onConfirm={bulkArchive}
              trigger={
                <Button
                  size="sm"
                  variant="outline"
                  disabled={bulkPending || archivableSelected.length === 0}
                  title={
                    archivableSelected.length === 0
                      ? "Only draft sequences can be archived"
                      : undefined
                  }
                >
                  Archive
                  {archivableSelected.length > 0
                    ? ` (${archivableSelected.length})`
                    : ""}
                </Button>
              }
            />
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setSelected(new Set())}
            >
              Clear
            </Button>
          </div>
        </div>
      ) : null}

      {filtered.length === 0 ? (
        hasFilters && !notDeployedId ? (
          <div className="rounded-md border bg-card">
            <EmptyState
              icon={Sparkles}
              title="No sequences match your filters"
              description="Try a different status or clear your search."
              action={
                <Button
                  variant="outline"
                  onClick={() => setState({ q: "", status: "all", page: 1 })}
                >
                  Clear filters
                </Button>
              }
            />
          </div>
        ) : notDeployedId ? (
          <div className="rounded-md border bg-card">
            <EmptyState
              icon={Sparkles}
              title="Sequences can't be shown here"
              description="Generating a sequence and previewing templates are switched off in this environment."
              action={
                <div className="flex flex-wrap items-center justify-center gap-2">
                  <Button disabled aria-describedby={notDeployedId}>
                    Generate your first sequence
                  </Button>
                  <Button
                    variant="outline"
                    disabled
                    aria-describedby={notDeployedId}
                  >
                    Preview a template
                  </Button>
                </div>
              }
            />
          </div>
        ) : (
          <div className="rounded-md border bg-card">
            <EmptyState
              icon={Sparkles}
              title="No sequences yet"
              description="Start from a template and Moosewave will draft a fidelity-scored sequence in your voice. Not sure yet? Preview a template to see what a finished sequence looks like first."
              action={
                <div className="flex flex-wrap items-center justify-center gap-2">
                  <Button asChild>
                    <Link href="/app/sequences/new">
                      Generate your first sequence
                    </Link>
                  </Button>
                  <Button asChild variant="outline">
                    <Link href="/app/sequence-templates">
                      Preview a template
                    </Link>
                  </Button>
                </div>
              }
            />
          </div>
        )
      ) : (
        <>
          <div className="space-y-3 sm:hidden">
            {pageRows.map((sequence) => {
              const status = sequenceStatusPresentation(sequence.status);
              return (
                <article
                  key={sequence.id}
                  className={cn(
                    "min-w-0 rounded-lg border bg-card p-4 shadow-sm",
                    selected.has(sequence.id) &&
                      "border-primary/50 bg-accent/30 ring-1 ring-primary/20",
                  )}
                >
                  <div className="flex min-w-0 items-start gap-3">
                    <Checkbox
                      aria-label={`Select ${sequence.name}`}
                      checked={selected.has(sequence.id)}
                      onChange={() => toggleOne(sequence.id)}
                      className="mt-0.5 h-6 w-6 shrink-0"
                    />
                    <div className="min-w-0 flex-1">
                      <Link
                        href={`/app/sequences/${sequence.id}`}
                        className="inline-flex min-h-8 max-w-full items-center break-words font-medium underline-offset-4 hover:underline"
                      >
                        {sequence.name}
                      </Link>
                      <p className="break-words text-xs text-muted-foreground">
                        {sequence.templateName}
                      </p>
                    </div>
                    <SequenceRowActions
                      id={sequence.id}
                      status={sequence.status}
                      onChanged={() => {
                        setSelected(new Set());
                        router.refresh();
                      }}
                    />
                  </div>
                  <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-xs">
                    <div>
                      <dt className="text-muted-foreground">Status</dt>
                      <dd className="mt-1">
                        <Badge
                          variant={
                            status.tone === "danger"
                              ? "destructive"
                              : status.tone === "warning"
                                ? "warning"
                                : sequence.status === "archived"
                                  ? "outline"
                                  : "secondary"
                          }
                          title={status.detail}
                        >
                          {status.label}
                        </Badge>
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Fidelity</dt>
                      <dd className="mt-1">
                        <FidelityBadge score={sequence.fidelityAvg} />
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Emails</dt>
                      <dd className="mt-1 tabular-nums">
                        {sequence.emailCount}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Updated</dt>
                      <dd className="mt-1">
                        <RelativeTime iso={sequence.updatedAt} />
                      </dd>
                    </div>
                  </dl>
                </article>
              );
            })}
          </div>

          <div
            role="region"
            aria-label="Sequences"
            tabIndex={0}
            className="hidden min-w-0 overflow-x-auto rounded-md border bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:block"
          >
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-muted-foreground">
                <tr>
                  <th scope="col" className="w-10 px-4 py-2">
                    <Checkbox
                      aria-label="Select all on this page"
                      checked={allPageSelected}
                      indeterminate={somePageSelected && !allPageSelected}
                      onChange={toggleAllOnPage}
                      className="h-6 w-6"
                    />
                  </th>
                  <SortHeader
                    label="Name"
                    active={state.sort === "name"}
                    dir={state.dir}
                    onClick={() => setSort("name")}
                  />
                  <th scope="col" className="px-4 py-2 text-left font-medium">
                    Template
                  </th>
                  <th scope="col" className="px-4 py-2 text-left font-medium">
                    Emails
                  </th>
                  <SortHeader
                    label="Fidelity"
                    active={state.sort === "fidelity"}
                    dir={state.dir}
                    onClick={() => setSort("fidelity")}
                  />
                  <th scope="col" className="px-4 py-2 text-left font-medium">
                    Status
                  </th>
                  <SortHeader
                    label="Updated"
                    active={state.sort === "updated"}
                    dir={state.dir}
                    onClick={() => setSort("updated")}
                  />
                  <th scope="col" className="px-4 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y">
                {pageRows.map((s) => {
                  const status = sequenceStatusPresentation(s.status);
                  return (
                    <tr
                      key={s.id}
                      className={cn(
                        "hover:bg-muted/30",
                        selected.has(s.id) && "bg-accent/30",
                      )}
                    >
                      <td className="px-4 py-3">
                        <Checkbox
                          aria-label={`Select ${s.name}`}
                          checked={selected.has(s.id)}
                          onChange={() => toggleOne(s.id)}
                          className="h-6 w-6"
                        />
                      </td>
                      <td className="px-4 py-3">
                        <Link
                          href={`/app/sequences/${s.id}`}
                          className="inline-flex min-h-6 items-center font-medium underline-offset-4 hover:underline"
                        >
                          {s.name}
                        </Link>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {s.templateName}
                      </td>
                      <td className="px-4 py-3 tabular-nums text-muted-foreground">
                        {s.emailCount}
                      </td>
                      <td className="px-4 py-3">
                        <FidelityBadge score={s.fidelityAvg} />
                      </td>
                      <td className="px-4 py-3">
                        <Badge
                          variant={
                            status.tone === "danger"
                              ? "destructive"
                              : status.tone === "warning"
                                ? "warning"
                                : s.status === "archived"
                                  ? "outline"
                                  : "secondary"
                          }
                          title={status.detail}
                        >
                          {status.label}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        <RelativeTime iso={s.updatedAt} />
                      </td>
                      <td className="px-4 py-3 text-right">
                        <SequenceRowActions
                          id={s.id}
                          status={s.status}
                          onChanged={() => {
                            setSelected(new Set());
                            router.refresh();
                          }}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>
              {(page - 1) * PAGE_SIZE + 1}–
              {Math.min(page * PAGE_SIZE, filtered.length)} of {filtered.length}
            </span>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={page <= 1}
                onClick={() => setState({ page: page - 1 })}
              >
                Prev
              </Button>
              <span className="tabular-nums">
                {page} / {totalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= totalPages}
                onClick={() => setState({ page: page + 1 })}
              >
                Next
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function SortHeader({
  label,
  active,
  dir,
  onClick,
}: {
  label: string;
  active: boolean;
  dir: SortDir;
  onClick: () => void;
}) {
  return (
    <th
      scope="col"
      className="px-4 py-2 text-left font-medium"
      aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}
    >
      <button
        type="button"
        onClick={onClick}
        className="inline-flex min-h-8 items-center gap-1 rounded-sm outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
      >
        {label}
        {active ? (
          dir === "asc" ? (
            <ArrowUp className="h-3.5 w-3.5" />
          ) : (
            <ArrowDown className="h-3.5 w-3.5" />
          )
        ) : (
          <ChevronsUpDown className="h-3.5 w-3.5 opacity-40" />
        )}
      </button>
    </th>
  );
}
