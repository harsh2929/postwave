// SPDX-License-Identifier: AGPL-3.0-only
"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, Plus, RefreshCw, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { PageShell } from "@/components/dashboard/page-shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { apiErrorMessage } from "@/lib/api";
import { asRoute } from "@/lib/typed-routes";
import {
  effectiveAuthRole,
  whoami,
  whoamiFresh,
  type MeResponse,
} from "@/lib/auth-api";
import {
  createAudienceList,
  deleteAudienceList,
  newWriteKey,
  updateAudienceList,
  type AudienceList,
} from "@/lib/audience-admin-api";
import { invalidateListCatalogue } from "@/lib/audience-invalidation";
import {
  getListHealth,
  LIST_HEALTH_WINDOW_DAYS,
  listAudienceCatalogue,
  type AudienceListRow,
} from "@/lib/lists-api";
import { listKeys, qk, STALE } from "@/lib/query-keys";

import { ListHealthBadge, type HealthState } from "./list-health-badge";

/** Desktop Lists.tsx pages the catalogue 25 at a time; match it. */
const PAGE_SIZE = 25;
const TYPE_FILTERS = ["all", "public", "private"] as const;
type TypeFilter = (typeof TYPE_FILTERS)[number];

function assertIdentity(old: MeResponse, fresh: MeResponse) {
  if (
    old.user_id !== fresh.user_id ||
    old.tenant_id !== fresh.tenant_id ||
    effectiveAuthRole(old) !== effectiveAuthRole(fresh) ||
    fresh.viewer_mode
  )
    throw new Error(
      "Your workspace authority changed. Nothing was written; refresh and retry.",
    );
  if (!["owner", "admin", "editor"].includes(effectiveAuthRole(fresh)))
    throw new Error("Editor access is required.");
}
interface ListDraft {
  name: string;
  type: AudienceList["type"];
  optin: AudienceList["optin"];
  description: string;
  tags: string;
}
const empty: ListDraft = {
  name: "",
  type: "private",
  optin: "single",
  description: "",
  tags: "",
};
export function ListsAdminClient() {
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<TypeFilter>("all");
  const [page, setPage] = useState(1);
  const [draft, setDraft] = useState(empty);
  const [editing, setEditing] = useState<AudienceListRow | null>(null);
  const [remove, setRemove] = useState<AudienceListRow | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const me = useQuery({
    queryKey: qk.authMe(),
    queryFn: () => whoami(),
    staleTime: STALE.authMe,
  });
  const tenantId = me.data?.tenant_id ?? "anon";
  const roleKey = me.data ? effectiveAuthRole(me.data) : null;
  // Keyed in the shared `lists` family so a write here reaches every other
  // reader of the catalogue (form target-list picker, "Add to list" pickers,
  // the list detail record) through one invalidation.
  const lists = useQuery({
    queryKey: qk.lists(tenantId, roleKey, { view: "index", q }),
    queryFn: ({ signal }) => listAudienceCatalogue(q, signal),
    enabled: Boolean(me.data),
    placeholderData: (p) => p,
  });
  const canWrite = Boolean(
    me.data &&
    !me.data.viewer_mode &&
    ["owner", "admin", "editor"].includes(effectiveAuthRole(me.data)),
  );
  const rows = useMemo(
    () => (Array.isArray(lists.data) ? lists.data : []),
    [lists.data],
  );
  // Listmonk's catalogue read has no type filter or paging on the proxy, so
  // both are client-side over the rows the search returned.
  const filtered = useMemo(
    () => (filter === "all" ? rows : rows.filter((x) => x.type === filter)),
    [rows, filter],
  );
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pageRows = useMemo(
    () =>
      filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE),
    [filtered, currentPage],
  );
  const strip = useMemo(() => {
    let subscribers = 0;
    let publicLists = 0;
    let doubleOptin = 0;
    for (const r of rows) {
      subscribers += r.subscriber_count ?? 0;
      if (r.type === "public") publicLists++;
      if (r.optin === "double") doubleOptin++;
    }
    return { total: rows.length, subscribers, publicLists, doubleOptin };
  }, [rows]);
  // One health read per visible row, keyed by the list's name — the score
  // route grades subscribers carrying that TAG (the tag-as-list pattern).
  const health = useQueries({
    queries: pageRows.map((row) => ({
      queryKey: listKeys.health(
        tenantId,
        roleKey,
        row.name,
        LIST_HEALTH_WINDOW_DAYS,
      ),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        getListHealth(row.name, LIST_HEALTH_WINDOW_DAYS, signal),
      enabled: Boolean(me.data) && Boolean(row.name.trim()),
      staleTime: STALE.dashboard,
    })),
  });
  function healthState(i: number): HealthState {
    const h = health[i];
    if (!h || h.isPending) return { status: "pending" };
    if (h.isError) return { status: "error", error: h.error };
    return { status: "success", health: h.data };
  }
  function launch(item?: AudienceListRow) {
    setEditing(item ?? null);
    setDraft(
      item
        ? {
            name: item.name,
            type: item.type,
            optin: item.optin,
            description: item.description,
            tags: item.tags.join(", "),
          }
        : empty,
    );
    setOpen(true);
  }
  async function exact(item: AudienceListRow) {
    const current = (await listAudienceCatalogue()).find(
      (x) => x.id === item.id,
    );
    if (!current) throw new Error("This list no longer exists.");
    if (JSON.stringify(current) !== JSON.stringify(item))
      throw new Error(
        "This list changed on the server. Nothing was written; review the refreshed record.",
      );
    return current;
  }
  async function save() {
    if (busy || !me.data) return;
    const name = draft.name.trim();
    if (!name || name.length > 200) {
      toast.error("Name must be 1–200 characters.");
      return;
    }
    setBusy(true);
    try {
      assertIdentity(me.data, await whoamiFresh());
      const body = {
        name,
        type: draft.type,
        optin: draft.optin,
        description: draft.description.trim(),
        tags: draft.tags
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean),
      };
      if (editing) {
        await exact(editing);
        await updateAudienceList(editing.id, body, newWriteKey("list-update"));
      } else await createAudienceList(body, newWriteKey("list-create"));
      await invalidateListCatalogue(qc, tenantId, roleKey);
      setOpen(false);
      toast.success(editing ? "List updated" : "List created");
    } catch (e) {
      toast.error(apiErrorMessage(e, "List change failed"));
      await invalidateListCatalogue(qc, tenantId, roleKey);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  async function destroy() {
    if (!remove || !me.data || busy) return;
    setBusy(true);
    try {
      assertIdentity(me.data, await whoamiFresh());
      await exact(remove);
      await deleteAudienceList(remove.id, newWriteKey("list-delete"));
      await invalidateListCatalogue(qc, tenantId, roleKey);
      setRemove(null);
      toast.success("List deleted");
    } catch (e) {
      toast.error(apiErrorMessage(e, "List deletion failed"));
      await invalidateListCatalogue(qc, tenantId, roleKey);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <PageShell>
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Lists</h1>
          <p className="text-sm text-muted-foreground">
            Audience containers backed by the production list service.
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() => lists.refetch()}
            disabled={lists.isFetching}
          >
            <RefreshCw aria-hidden className="size-4" /> Refresh
          </Button>
          <Button onClick={() => launch()} disabled={!canWrite}>
            <Plus aria-hidden className="size-4" /> Create list
          </Button>
        </div>
      </header>
      <div role="note" className="rounded-md border bg-muted/30 p-3 text-sm">
        List updates and deletion are idempotent, but the server does not yet
        expose record versions. Web performs a fresh identity and exact-record
        read immediately before writing; concurrent changes cannot be fully
        excluded.
      </div>
      <section
        aria-label="List inventory"
        className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
      >
        <StripStat label="Lists" value={strip.total.toLocaleString()} />
        <StripStat
          label="Subscribers"
          value={strip.subscribers.toLocaleString()}
          hint="Sum of each list's member count"
        />
        <StripStat
          label="Public lists"
          value={strip.publicLists.toLocaleString()}
        />
        <StripStat
          label="Double opt-in"
          value={strip.doubleOptin.toLocaleString()}
        />
      </section>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="min-w-0 flex-1">
          <Label htmlFor="list-search">Search lists</Label>
          <Input
            id="list-search"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setPage(1);
            }}
            placeholder="Name or description"
            className="max-w-md"
          />
        </div>
        <div
          role="group"
          aria-label="Filter by visibility"
          className="flex flex-wrap gap-1"
        >
          {TYPE_FILTERS.map((option) => (
            <Button
              key={option}
              type="button"
              size="sm"
              variant={filter === option ? "default" : "outline"}
              aria-pressed={filter === option}
              onClick={() => {
                setFilter(option);
                setPage(1);
              }}
            >
              {option[0]!.toUpperCase() + option.slice(1)}
            </Button>
          ))}
        </div>
      </div>
      {me.isError || lists.isError ? (
        <div role="alert" className="rounded-md border border-destructive p-4">
          <p>
            {apiErrorMessage(
              me.error ?? lists.error,
              "Lists could not be loaded",
            )}
          </p>
          <Button
            variant="outline"
            onClick={() => {
              void me.refetch();
              void lists.refetch();
            }}
          >
            Retry
          </Button>
        </div>
      ) : lists.isPending ? (
        <p role="status">Loading lists…</p>
      ) : filtered.length === 0 ? (
        <p className="rounded-md border p-6 text-center text-muted-foreground">
          {filter === "all"
            ? "No lists found."
            : `No ${filter} lists match. Choose "All" to see every list.`}
        </p>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2">
          {pageRows.map((x, i) => (
            <li key={x.id} className="rounded-lg border p-4">
              <div className="flex justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="truncate font-medium">
                    <Link
                      href={asRoute(`/app/lists/${x.id}`)}
                      className="hover:underline"
                    >
                      {x.name}
                    </Link>
                  </h2>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
                    <span>
                      {x.type} · {x.optin} opt-in
                      {typeof x.subscriber_count === "number"
                        ? ` · ${x.subscriber_count.toLocaleString()} subscriber${x.subscriber_count === 1 ? "" : "s"}`
                        : ""}
                    </span>
                    <ListHealthBadge listName={x.name} state={healthState(i)} />
                  </div>
                  <p className="mt-2 line-clamp-2 text-sm">
                    {x.description || "No description"}
                  </p>
                </div>
                <div className="flex gap-1">
                  <Button asChild size="icon" variant="ghost">
                    <Link
                      href={asRoute(`/app/lists/${x.id}`)}
                      aria-label={`Open ${x.name}`}
                    >
                      <ArrowUpRight className="size-4" />
                    </Link>
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={`Edit ${x.name}`}
                    disabled={!canWrite}
                    onClick={() => launch(x)}
                  >
                    <Pencil className="size-4" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={`Delete ${x.name}`}
                    disabled={!canWrite}
                    onClick={() => setRemove(x)}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
      {filtered.length > 0 ? (
        <nav
          aria-label="List pages"
          className="flex flex-col gap-3 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between"
        >
          <span>
            Page {currentPage} of {totalPages} ·{" "}
            {filtered.length.toLocaleString()} list
            {filtered.length === 1 ? "" : "s"}
          </span>
          {filtered.length > PAGE_SIZE ? (
            <div className="grid grid-cols-2 gap-2">
              <Button
                type="button"
                variant="outline"
                aria-label="Previous page"
                disabled={currentPage <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                Previous
              </Button>
              <Button
                type="button"
                variant="outline"
                aria-label="Next page"
                disabled={currentPage >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              >
                Next
              </Button>
            </div>
          ) : null}
        </nav>
      ) : null}
      <Dialog open={open} onOpenChange={(v) => !busy && setOpen(v)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? "Edit list" : "Create list"}</DialogTitle>
            <DialogDescription>
              Configure the list policy and metadata.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <Label htmlFor="list-name">Name</Label>
            <Input
              id="list-name"
              maxLength={200}
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
            <Label htmlFor="list-type">Visibility</Label>
            <Select
              id="list-type"
              value={draft.type}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  type: e.target.value as AudienceList["type"],
                })
              }
            >
              <option value="private">Private</option>
              <option value="public">Public</option>
              <option value="temporary">Temporary</option>
            </Select>
            <Label htmlFor="list-optin">Opt-in</Label>
            <Select
              id="list-optin"
              value={draft.optin}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  optin: e.target.value as AudienceList["optin"],
                })
              }
            >
              <option value="single">Single</option>
              <option value="double">Double</option>
            </Select>
            <Label htmlFor="list-description">Description</Label>
            <Textarea
              id="list-description"
              maxLength={2000}
              value={draft.description}
              onChange={(e) =>
                setDraft({ ...draft, description: e.target.value })
              }
            />
            <Label htmlFor="list-tags">Tags (comma-separated)</Label>
            <Input
              id="list-tags"
              value={draft.tags}
              onChange={(e) => setDraft({ ...draft, tags: e.target.value })}
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button onClick={save} disabled={busy}>
              {busy ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={Boolean(remove)}
        onOpenChange={(v) => !v && setRemove(null)}
        title="Delete list?"
        description="This permanently deletes the audience container. Type its exact name to continue."
        confirmationToken={remove?.name}
        confirmLabel="Delete list"
        onConfirm={destroy}
      />
    </PageShell>
  );
}

function StripStat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </p>
        <p className="mt-1 text-lg font-semibold tabular-nums">{value}</p>
        {hint ? (
          <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}
