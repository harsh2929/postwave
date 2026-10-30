// SPDX-License-Identifier: AGPL-3.0-only
"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  History,
  Merge,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  Users,
} from "lucide-react";
import { toast } from "sonner";
import { PageShell } from "@/components/dashboard/page-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import {
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { apiErrorMessage } from "@/lib/api";
import {
  effectiveAuthRole,
  whoami,
  whoamiFresh,
  type MeResponse,
} from "@/lib/auth-api";
import {
  createTag,
  createTagGroup,
  deleteTagGroup,
  listTagGroups,
  listTags,
  mutateTagMembership,
  newWriteKey,
  updateTag,
  updateTagGroup,
  type TagGroup,
  type TagRecord,
} from "@/lib/audience-admin-api";
import { qk, STALE, tagKeys } from "@/lib/query-keys";
import {
  TAG_MERGE_AVAILABLE,
  TAG_MERGE_UNAVAILABLE_REASON,
} from "@/lib/tag-merge-availability";
import {
  listTagTaxonomy,
  suggestTags,
  TAG_SUGGESTION_LIMIT,
  type TagSuggestion,
  type TagUsage,
} from "@/lib/tags-api";
import {
  buildTagDisplayRows,
  COLOR_FILTER_ALL,
  DEFAULT_TAG_COLOR,
  DEFAULT_TAG_VIEW,
  GROUP_FILTER_ALL,
  GROUP_FILTER_UNGROUPED,
  isDefaultTagView,
  pageOfRows,
  runeLength,
  sortTagDisplayRows,
  TAG_PALETTE,
  tagColorPresentation,
  tagIdentityKey,
  tagSubscriberCount,
  tagUsageMap,
  type TagSortField,
  type TagView,
} from "./tag-catalogue-model";
import {
  BulkEditDialog,
  type BulkEditMode,
} from "./_components/bulk-edit-dialog";
import { MergeTagsDialog } from "./_components/merge-tags-dialog";
import { RegisterOrphanDialog } from "./_components/register-orphan-dialog";
import { TagColorPalette, TagSwatch } from "./_components/tag-color-palette";
import { TagDetailDialog } from "./_components/tag-detail-dialog";

const WRITE_ROLES = ["owner", "admin", "editor"];
const GROUP_ADMIN_ROLES = ["owner", "admin"];
const GROUPS_ADMIN_ONLY =
  "Only workspace owners and admins can create, rename, or delete tag groups.";
// The groups notice above covers groups only, so without this every greyed-out
// tag control on the page was unexplained — including for an owner who simply
// has viewer mode on and can turn it off.
const TAGS_READ_ONLY =
  "Editor, admin, or owner access is required to create or change tags. Viewer mode is read-only.";
const SUGGEST_DEBOUNCE_MS = 200;
// Desktop parity audience-103: the Merge control reads the same policy as the
// transport (TAG_MERGE_AVAILABLE) and points at the one status element that
// carries the reason, so a disabled Merge is never unexplained.
const MERGE_REASON_ID = "tags-merge-availability";

function assertIdentity(a: MeResponse, b: MeResponse) {
  if (
    a.user_id !== b.user_id ||
    a.tenant_id !== b.tenant_id ||
    effectiveAuthRole(a) !== effectiveAuthRole(b) ||
    b.viewer_mode
  )
    throw new Error(
      "Your workspace authority changed. Nothing was written; refresh and retry.",
    );
  if (!WRITE_ROLES.includes(effectiveAuthRole(b)))
    throw new Error("Editor access is required.");
}

/** Settles `value` after `ms` of no changes — the typeahead cadence. */
function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

const blank = {
  name: "",
  color: DEFAULT_TAG_COLOR,
  description: "",
  group_id: "",
  pii: false,
};

export function TagsAdminClient() {
  const qc = useQueryClient();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [view, setView] = useState<TagView>(DEFAULT_TAG_VIEW);
  const [draft, setDraft] = useState(blank);
  const [editing, setEditing] = useState<TagRecord | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [groupDraft, setGroupDraft] = useState("");
  const [groupEdit, setGroupEdit] = useState<TagGroup | null>(null);
  const [groupDelete, setGroupDelete] = useState<TagGroup | null>(null);
  const [inspectId, setInspectId] = useState<string | null>(null);
  const [membersId, setMembersId] = useState<string | null>(null);
  const [memberIds, setMemberIds] = useState("");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [bulk, setBulk] = useState<{ open: boolean; mode: BulkEditMode }>({
    open: false,
    mode: "color",
  });
  const [registerTarget, setRegisterTarget] = useState<TagUsage | null>(null);
  const [merge, setMerge] = useState<{
    open: boolean;
    from: readonly string[];
  }>({ open: false, from: [] });
  const [busy, setBusy] = useState(false);

  const me = useQuery({
    queryKey: qk.authMe(),
    queryFn: () => whoami(),
    staleTime: STALE.authMe,
  });
  const tenantId = me.data?.tenant_id ?? "";
  const role = me.data ? effectiveAuthRole(me.data) : null;
  const tagsKey = qk.tags(tenantId, role, "admin");
  const groupsKey = tagKeys.groups(tenantId, role);
  const taxonomyKey = tagKeys.taxonomy(tenantId, role);
  const groups = useQuery({
    queryKey: groupsKey,
    queryFn: ({ signal }) => listTagGroups(signal),
    enabled: Boolean(me.data),
    staleTime: STALE.list,
  });
  const tags = useQuery({
    queryKey: tagsKey,
    queryFn: ({ signal }) => listTags({ signal }),
    enabled: Boolean(me.data),
    staleTime: STALE.list,
  });
  const taxonomy = useQuery({
    queryKey: taxonomyKey,
    queryFn: ({ signal }) => listTagTaxonomy(signal),
    enabled: Boolean(me.data),
    staleTime: STALE.list,
  });
  const suggestQuery = useDebounced(draft.name.trim(), SUGGEST_DEBOUNCE_MS);
  const suggestionsEnabled =
    formOpen && !editing && Boolean(me.data) && suggestQuery.length >= 2;
  const suggestions = useQuery({
    queryKey: tagKeys.suggest(tenantId, role, suggestQuery),
    queryFn: ({ signal }) =>
      suggestTags(suggestQuery, TAG_SUGGESTION_LIMIT, signal),
    enabled: suggestionsEnabled,
    staleTime: STALE.detail,
    retry: false,
  });

  const canWrite = Boolean(
    me.data &&
    !me.data.viewer_mode &&
    WRITE_ROLES.includes(effectiveAuthRole(me.data)),
  );
  const canAdminGroups = Boolean(
    me.data &&
    !me.data.viewer_mode &&
    GROUP_ADMIN_ROLES.includes(effectiveAuthRole(me.data)),
  );
  const rows = useMemo(
    () => (Array.isArray(tags.data) ? tags.data : []),
    [tags.data],
  );
  const groupRows = useMemo(
    () => (Array.isArray(groups.data) ? groups.data : []),
    [groups.data],
  );
  const usage = useMemo(
    () => tagUsageMap(Array.isArray(taxonomy.data) ? taxonomy.data : []),
    [taxonomy.data],
  );
  const display = useMemo(() => {
    const built = buildTagDisplayRows(rows, usage, view);
    const sorted = sortTagDisplayRows(
      built.rows,
      view.sortField,
      view.sortDirection,
    );
    return {
      ...pageOfRows(sorted, view.page),
      total: sorted.length,
      hiddenOrphans: built.hiddenOrphans,
    };
  }, [rows, usage, view]);
  const selectedRecords = useMemo(
    () => rows.filter((x) => selected.has(x.id)),
    [rows, selected],
  );
  const inspectTag = rows.find((x) => x.id === inspectId) ?? null;
  const membersTag = rows.find((x) => x.id === membersId) ?? null;
  // The duplicate hint answers from the catalogue and taxonomy the page
  // already holds first, so it survives a suggest-endpoint outage; the
  // server's suggestions add the near-matches local data cannot see.
  const dedupHint = useMemo((): TagSuggestion | null => {
    const key = tagIdentityKey(draft.name);
    if (!key) return null;
    const local = rows.find((x) => tagIdentityKey(x.name) === key);
    if (local)
      return {
        tag: local.name,
        registered: true,
        subscribers: tagSubscriberCount(local, usage) ?? 0,
      };
    const applied = usage.get(key);
    if (applied && (applied.subscribers > 0 || applied.registered))
      return {
        tag: applied.tag,
        registered: applied.registered,
        subscribers: applied.subscribers,
      };
    if (!Array.isArray(suggestions.data)) return null;
    return (
      suggestions.data.find(
        (s) =>
          tagIdentityKey(s.tag) === key && (s.subscribers > 0 || s.registered),
      ) ?? null
    );
  }, [draft.name, rows, usage, suggestions.data]);

  function patchView(patch: Partial<TagView>) {
    setView((v) => ({ ...v, ...patch, page: patch.page ?? 1 }));
  }
  function toggleSort(field: TagSortField) {
    setView((v) => ({
      ...v,
      sortField: field,
      sortDirection:
        v.sortField === field && v.sortDirection === "asc" ? "desc" : "asc",
      page: 1,
    }));
  }
  async function invalidateCatalogue() {
    await Promise.all([
      qc.invalidateQueries({ queryKey: tagsKey }),
      qc.invalidateQueries({ queryKey: taxonomyKey }),
    ]);
  }
  async function auth() {
    if (!me.data) throw new Error("Workspace identity is unavailable.");
    assertIdentity(me.data, await whoamiFresh());
  }
  async function exactTag(x: TagRecord) {
    const current = (await listTags()).find((y) => y.id === x.id);
    if (!current) throw new Error("This tag no longer exists.");
    if (current.etag !== x.etag)
      throw new Error(
        "This tag changed on the server. Review the refreshed record.",
      );
    return current;
  }
  async function exactGroup(x: TagGroup) {
    const current = (await listTagGroups()).find((y) => y.id === x.id);
    if (!current) throw new Error("This group no longer exists.");
    if (JSON.stringify(current) !== JSON.stringify(x))
      throw new Error(
        "This group changed on the server. Review the refreshed record.",
      );
    return current;
  }
  function launch(x?: TagRecord) {
    setEditing(x ?? null);
    setDraft(
      x
        ? {
            name: x.name,
            color: x.color || DEFAULT_TAG_COLOR,
            description: x.description,
            group_id: x.group_id,
            pii: x.pii,
          }
        : blank,
    );
    setFormOpen(true);
  }
  async function saveTag() {
    if (busy) return;
    setBusy(true);
    try {
      await auth();
      const name = draft.name.trim();
      if (!name || runeLength(name) > 64)
        throw new Error("Tag name must be 1–64 characters.");
      if (runeLength(draft.description) > 1024)
        throw new Error("Description must be at most 1,024 characters.");
      if (editing) {
        const current = await exactTag(editing);
        await updateTag(current, { ...draft, name }, newWriteKey("tag-update"));
      } else await createTag({ ...draft, name }, newWriteKey("tag-create"));
      await invalidateCatalogue();
      setFormOpen(false);
      toast.success(editing ? "Tag updated" : "Tag created");
    } catch (e) {
      toast.error(apiErrorMessage(e, "Tag change failed"));
      await invalidateCatalogue();
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  async function saveGroup() {
    if (busy) return;
    setBusy(true);
    try {
      if (!canAdminGroups) throw new Error(GROUPS_ADMIN_ONLY);
      await auth();
      const name = groupDraft.trim();
      if (!name || runeLength(name) > 64)
        throw new Error("Group name must be 1–64 characters.");
      if (groupEdit) {
        await exactGroup(groupEdit);
        await updateTagGroup(
          groupEdit.id,
          { name },
          newWriteKey("group-update"),
        );
      } else
        await createTagGroup(
          { name, color: DEFAULT_TAG_COLOR, sort_order: groupRows.length },
          newWriteKey("group-create"),
        );
      await qc.invalidateQueries({ queryKey: groupsKey });
      setGroupEdit(null);
      setGroupDraft("");
      toast.success("Group saved");
    } catch (e) {
      toast.error(apiErrorMessage(e, "Group change failed"));
      await qc.invalidateQueries({ queryKey: groupsKey });
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  async function destroyGroup() {
    if (!groupDelete || busy) return;
    setBusy(true);
    try {
      if (!canAdminGroups) throw new Error(GROUPS_ADMIN_ONLY);
      await auth();
      await exactGroup(groupDelete);
      await deleteTagGroup(groupDelete.id, newWriteKey("group-delete"));
      await Promise.all([
        qc.invalidateQueries({ queryKey: groupsKey }),
        invalidateCatalogue(),
      ]);
      if (view.group === groupDelete.id) patchView({ group: GROUP_FILTER_ALL });
      setGroupDelete(null);
      toast.success("Group deleted; its tags are now ungrouped");
    } catch (e) {
      toast.error(apiErrorMessage(e, "Group deletion failed"));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  async function membership(mode: "apply" | "unapply") {
    if (!membersTag || busy) return;
    setBusy(true);
    try {
      await auth();
      const current = await exactTag(membersTag);
      const ids = [
        ...new Set(
          memberIds
            .split(/[\s,]+/)
            .map((x) => x.trim())
            .filter(Boolean),
        ),
      ];
      if (
        !ids.length ||
        ids.length > 1000 ||
        ids.some((x) => !/^[0-9a-f-]{36}$/i.test(x))
      )
        throw new Error("Enter 1–1,000 valid subscriber UUIDs.");
      const receipt = await mutateTagMembership(
        current.id,
        ids,
        mode,
        newWriteKey(`tag-${mode}`),
      );
      toast.success(
        `${receipt.applied} membership${receipt.applied === 1 ? "" : "s"} changed; ${receipt.skipped} skipped`,
      );
      setMembersId(null);
      setMemberIds("");
      await invalidateCatalogue();
    } catch (e) {
      toast.error(apiErrorMessage(e, "Membership change failed"));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  function toggleSelected(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  const pageTagIds = display.rows.flatMap((r) =>
    r.kind === "tag" ? [r.tag.id] : [],
  );
  const pageSelectedCount = pageTagIds.filter((id) => selected.has(id)).length;
  function toggleAllOnPage(checked: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of pageTagIds) {
        if (checked) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }

  const canMerge = canWrite && TAG_MERGE_AVAILABLE;
  const mergeReason = !canWrite
    ? TAGS_READ_ONLY
    : TAG_MERGE_AVAILABLE
      ? undefined
      : TAG_MERGE_UNAVAILABLE_REASON;
  function openMerge(from: readonly string[]) {
    // Never open the dialog while merge is held: the transport would refuse
    // anyway, but the control must not promise a verb the server declines.
    if (!canMerge) return;
    setMerge({ open: true, from });
  }

  const failed = me.isError || groups.isError || tags.isError;
  const activeView = !isDefaultTagView(view);
  const sortIcon = (field: TagSortField) =>
    view.sortField !== field ? (
      <ArrowUpDown className="size-3" aria-hidden="true" />
    ) : view.sortDirection === "asc" ? (
      <ArrowUp className="size-3" aria-hidden="true" />
    ) : (
      <ArrowDown className="size-3" aria-hidden="true" />
    );
  const sortHeader = (field: TagSortField, label: string) => (
    <TableHead
      aria-sort={
        view.sortField === field
          ? view.sortDirection === "asc"
            ? "ascending"
            : "descending"
          : "none"
      }
    >
      <button
        type="button"
        className="inline-flex items-center gap-1 font-medium hover:underline"
        onClick={() => toggleSort(field)}
      >
        {label} {sortIcon(field)}
      </button>
    </TableHead>
  );

  return (
    <PageShell>
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Tags</h1>
          <p className="text-sm text-muted-foreground">
            Versioned subscriber taxonomy, groups, usage and audit history.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={
              tags.isFetching || groups.isFetching || taxonomy.isFetching
            }
            onClick={() => {
              void tags.refetch();
              void groups.refetch();
              void taxonomy.refetch();
            }}
          >
            <RefreshCw className="size-4" /> Refresh
          </Button>
          <Button
            variant="outline"
            disabled={!canMerge}
            title={mergeReason}
            aria-describedby={canMerge ? undefined : MERGE_REASON_ID}
            onClick={() => openMerge([])}
          >
            <Merge className="size-4" /> Merge…
          </Button>
          <Button
            disabled={!canWrite}
            title={canWrite ? undefined : TAGS_READ_ONLY}
            onClick={() => launch()}
          >
            <Plus className="size-4" /> Create tag
          </Button>
        </div>
      </header>
      <div role="note" className="rounded-md border bg-muted/30 p-3 text-sm">
        Renames and edits use the tag’s exact server ETag. Permanent tag
        deletion and merge are unavailable because the server intentionally
        refuses them until an impact plan and idempotent receipt exist.
      </div>
      {TAG_MERGE_AVAILABLE ? null : (
        <p
          id={MERGE_REASON_ID}
          role="status"
          className="rounded-md border bg-muted/25 p-3 text-sm text-muted-foreground"
        >
          {TAG_MERGE_UNAVAILABLE_REASON}
        </p>
      )}
      {me.data && !canWrite ? (
        <p
          role="note"
          className="rounded-md border bg-muted/25 p-3 text-sm text-muted-foreground"
        >
          {TAGS_READ_ONLY}
        </p>
      ) : null}
      <section className="rounded-lg border p-4" aria-label="Catalogue view">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="grow">
            <Label htmlFor="tag-search">Search tags</Label>
            <Input
              id="tag-search"
              type="search"
              maxLength={256}
              placeholder="Search names and descriptions…"
              value={view.query}
              onChange={(e) => patchView({ query: e.target.value })}
            />
          </div>
          <div>
            <Label htmlFor="tag-color-filter">Colour</Label>
            <Select
              id="tag-color-filter"
              value={view.color}
              onChange={(e) => patchView({ color: e.target.value })}
            >
              <option value={COLOR_FILTER_ALL}>All colours</option>
              {TAG_PALETTE.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.label}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="tag-group-filter">Group</Label>
            <Select
              id="tag-group-filter"
              value={view.group}
              onChange={(e) => patchView({ group: e.target.value })}
            >
              <option value={GROUP_FILTER_ALL}>All groups</option>
              {groupRows.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
              <option value={GROUP_FILTER_UNGROUPED}>No group</option>
            </Select>
          </div>
          {activeView ? (
            <Button variant="outline" onClick={() => setView(DEFAULT_TAG_VIEW)}>
              Reset view
            </Button>
          ) : null}
        </div>
        <p
          role="status"
          aria-live="polite"
          className="mt-2 text-xs text-muted-foreground"
        >
          {display.total.toLocaleString()} result
          {display.total === 1 ? "" : "s"}
          {display.hiddenOrphans > 0
            ? ` · ${display.hiddenOrphans.toLocaleString()} orphan${display.hiddenOrphans === 1 ? "" : "s"} hidden by the active colour or group filter`
            : ""}
        </p>
      </section>
      <section aria-labelledby="tag-groups-heading">
        <div className="mb-3 flex items-center justify-between">
          <h2 id="tag-groups-heading" className="text-lg font-medium">
            Groups
          </h2>
        </div>
        <div className="flex flex-wrap gap-2">
          {groupRows.map((x) => (
            <div
              key={x.id}
              className="flex items-center rounded-md border pl-3"
            >
              <button
                type="button"
                className="text-sm underline-offset-4 hover:underline"
                aria-pressed={view.group === x.id}
                onClick={() =>
                  patchView({
                    group: view.group === x.id ? GROUP_FILTER_ALL : x.id,
                  })
                }
              >
                {x.name}
              </button>
              <Button
                size="icon"
                variant="ghost"
                aria-label={`Rename group ${x.name}`}
                disabled={!canAdminGroups}
                title={canAdminGroups ? undefined : GROUPS_ADMIN_ONLY}
                onClick={() => {
                  setGroupEdit(x);
                  setGroupDraft(x.name);
                }}
              >
                <Pencil className="size-4" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                aria-label={`Delete group ${x.name}`}
                disabled={!canAdminGroups}
                title={canAdminGroups ? undefined : GROUPS_ADMIN_ONLY}
                onClick={() => setGroupDelete(x)}
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
          ))}
          {canAdminGroups && (
            <div className="flex gap-2">
              <Input
                aria-label={
                  groupEdit
                    ? `New name for ${groupEdit.name}`
                    : "New group name"
                }
                maxLength={64}
                value={groupDraft}
                onChange={(e) => setGroupDraft(e.target.value)}
                placeholder="New group"
              />
              <Button
                variant="outline"
                disabled={busy || !groupDraft.trim()}
                onClick={saveGroup}
              >
                {groupEdit ? "Rename" : "Add"}
              </Button>
              {groupEdit ? (
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    setGroupEdit(null);
                    setGroupDraft("");
                  }}
                >
                  Cancel
                </Button>
              ) : null}
            </div>
          )}
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          {canAdminGroups
            ? "Group records are not versioned server-side; web exact-reads immediately before update/delete."
            : GROUPS_ADMIN_ONLY}
        </p>
      </section>
      {taxonomy.isError ? (
        <div
          role="alert"
          className="rounded-md border border-warning-emphasis/40 p-3 text-sm"
        >
          Couldn’t verify subscriber counts and orphan status:{" "}
          {apiErrorMessage(taxonomy.error, "the taxonomy request failed")}.
          Registered tags are still shown; no counts are inferred.{" "}
          <Button
            size="sm"
            variant="outline"
            onClick={() => void taxonomy.refetch()}
          >
            Retry
          </Button>
        </div>
      ) : null}
      {selectedRecords.length > 0 ? (
        <div
          role="group"
          aria-label="Selected tag actions"
          className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/30 p-2 text-sm"
        >
          <span>
            <strong>{selectedRecords.length}</strong> selected
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={!canWrite}
            title={canWrite ? undefined : TAGS_READ_ONLY}
            onClick={() => setBulk({ open: true, mode: "color" })}
          >
            Recolour…
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!canWrite}
            title={canWrite ? undefined : TAGS_READ_ONLY}
            onClick={() => setBulk({ open: true, mode: "description" })}
          >
            Describe…
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!canMerge}
            title={mergeReason}
            aria-describedby={canMerge ? undefined : MERGE_REASON_ID}
            onClick={() => openMerge(selectedRecords.map((x) => x.name))}
          >
            Merge…
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setSelected(new Set())}
          >
            Clear selection
          </Button>
        </div>
      ) : null}
      {failed ? (
        <div role="alert" className="rounded-md border border-destructive p-4">
          {apiErrorMessage(
            me.error ?? groups.error ?? tags.error,
            "Tag administration could not be loaded",
          )}{" "}
          <Button
            variant="outline"
            onClick={() => {
              void me.refetch();
              void groups.refetch();
              void tags.refetch();
            }}
          >
            Retry
          </Button>
        </div>
      ) : tags.isPending ? (
        <p role="status">Loading tags…</p>
      ) : display.total === 0 ? (
        <div className="rounded-md border p-6 text-center text-muted-foreground">
          {activeView ? (
            <>
              No tags match this view.{" "}
              <Button
                variant="outline"
                size="sm"
                onClick={() => setView(DEFAULT_TAG_VIEW)}
              >
                Reset view
              </Button>
            </>
          ) : (
            "No tags found."
          )}
        </div>
      ) : (
        <>
          <TableContainer aria-label="Tag catalogue">
            <Table>
              <caption className="sr-only">
                Registered and orphan tags. Sortable columns announce their
                current direction.
              </caption>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8">
                    <Checkbox
                      aria-label="Select all registered tags on this page"
                      checked={
                        pageTagIds.length > 0 &&
                        pageSelectedCount === pageTagIds.length
                      }
                      indeterminate={
                        pageSelectedCount > 0 &&
                        pageSelectedCount < pageTagIds.length
                      }
                      disabled={!canWrite || pageTagIds.length === 0}
                      title={canWrite ? undefined : TAGS_READ_ONLY}
                      onChange={(e) => toggleAllOnPage(e.target.checked)}
                    />
                  </TableHead>
                  {sortHeader("name", "Name")}
                  <TableHead>Description</TableHead>
                  {sortHeader("subscribers", "Subscribers")}
                  {sortHeader("created", "Created")}
                  <TableHead>
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {display.rows.map((row) =>
                  row.kind === "orphan" ? (
                    <TableRow key={`orphan:${row.name}`}>
                      <TableCell>
                        <Checkbox
                          aria-label={`Orphan tag ${row.name} cannot be selected`}
                          disabled
                        />
                      </TableCell>
                      <TableHead scope="row" className="py-3">
                        <span className="inline-flex items-center gap-2">
                          <span
                            aria-hidden="true"
                            className="inline-block size-3 rounded-full border border-dashed"
                          />
                          {row.name} <Badge variant="warning">Orphan</Badge>
                        </span>
                      </TableHead>
                      <TableCell className="text-muted-foreground">
                        Applied to subscribers but not in the catalogue.
                      </TableCell>
                      <TableCell className="tabular-nums">
                        {row.usage.subscribers.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-muted-foreground">—</TableCell>
                      <TableCell>
                        <Button
                          size="sm"
                          disabled={!canWrite}
                          title={canWrite ? undefined : TAGS_READ_ONLY}
                          aria-label={`Register ${row.name}`}
                          onClick={() => setRegisterTarget(row.usage)}
                        >
                          Register
                        </Button>
                      </TableCell>
                    </TableRow>
                  ) : (
                    <TableRow
                      key={row.tag.id}
                      data-selected={selected.has(row.tag.id) || undefined}
                    >
                      <TableCell>
                        <Checkbox
                          aria-label={`Select ${row.name}`}
                          checked={selected.has(row.tag.id)}
                          disabled={!canWrite}
                          title={canWrite ? undefined : TAGS_READ_ONLY}
                          onChange={() => toggleSelected(row.tag.id)}
                        />
                      </TableCell>
                      <TableHead scope="row" className="py-3">
                        <button
                          type="button"
                          className="inline-flex items-center gap-2 text-left hover:underline"
                          aria-label={`Open tag ${row.name}`}
                          onClick={() => setInspectId(row.tag.id)}
                        >
                          <TagSwatch color={row.tag.color} />
                          {row.name}
                        </button>{" "}
                        {row.tag.pii ? (
                          <Badge variant="outline">PII</Badge>
                        ) : null}
                        {tagColorPresentation(row.tag.color).legacy ? (
                          <Badge
                            variant="warning"
                            title={`Stored colour ${JSON.stringify(row.tag.color)} is unsupported and shown as neutral slate.`}
                          >
                            Legacy colour
                          </Badge>
                        ) : null}
                        <span className="ml-1 text-xs text-muted-foreground">
                          v{row.tag.version}
                        </span>
                      </TableHead>
                      <TableCell
                        className="max-w-xs truncate text-muted-foreground"
                        title={row.tag.description || undefined}
                      >
                        {row.tag.description || "No description"}
                      </TableCell>
                      <TableCell className="tabular-nums">
                        {row.count === null ? (
                          <span aria-label="Subscriber count unavailable">
                            —
                          </span>
                        ) : (
                          row.count.toLocaleString()
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {new Date(row.tag.created_at).toLocaleDateString()}
                      </TableCell>
                      <TableCell>
                        <div className="flex">
                          <Button
                            size="icon"
                            variant="ghost"
                            aria-label={`Inspect ${row.name}`}
                            onClick={() => setInspectId(row.tag.id)}
                          >
                            <History className="size-4" />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            aria-label={`Change ${row.name} memberships`}
                            disabled={!canWrite}
                            title={canWrite ? undefined : TAGS_READ_ONLY}
                            onClick={() => setMembersId(row.tag.id)}
                          >
                            <Users className="size-4" />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            aria-label={`Edit ${row.name}`}
                            disabled={!canWrite}
                            title={canWrite ? undefined : TAGS_READ_ONLY}
                            onClick={() => launch(row.tag)}
                          >
                            <Pencil className="size-4" />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            aria-label={`Delete ${row.name}`}
                            disabled
                            title="Deletion is safety-disabled by the server"
                          >
                            <Trash2 className="size-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ),
                )}
              </TableBody>
            </Table>
          </TableContainer>
          <nav
            aria-label="Tag catalogue pages"
            className="flex items-center justify-between text-sm"
          >
            <Button
              size="sm"
              variant="outline"
              disabled={display.page <= 1}
              onClick={() => setView((v) => ({ ...v, page: display.page - 1 }))}
            >
              Previous
            </Button>
            <span aria-live="polite">
              Page {display.page} of {display.totalPages}
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={display.page >= display.totalPages}
              onClick={() => setView((v) => ({ ...v, page: display.page + 1 }))}
            >
              Next
            </Button>
          </nav>
        </>
      )}
      <Dialog open={formOpen} onOpenChange={(v) => !busy && setFormOpen(v)}>
        <DialogContent closeDisabled={busy}>
          <DialogHeader>
            <DialogTitle>{editing ? "Edit tag" : "Create tag"}</DialogTitle>
            <DialogDescription>
              {editing
                ? `This update requires exact version ${editing.version}.`
                : "Tags label subscribers so you can segment campaigns."}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <Label htmlFor="tag-name">Name</Label>
            <Input
              id="tag-name"
              maxLength={64}
              autoComplete="off"
              spellCheck={false}
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
            {!editing ? (
              dedupHint ? (
                <p role="status" className="text-xs">
                  <strong>{dedupHint.tag}</strong>{" "}
                  {dedupHint.registered
                    ? "already exists in your catalogue."
                    : `is already applied to ${dedupHint.subscribers.toLocaleString()} subscribers but is not registered yet.`}
                </p>
              ) : suggestionsEnabled && suggestions.isError ? (
                <p role="status" className="text-xs text-muted-foreground">
                  Tag suggestions are unavailable. You can still create this
                  tag.
                </p>
              ) : suggestionsEnabled &&
                suggestions.data &&
                suggestions.data.length > 0 ? (
                <p role="status" className="text-xs text-muted-foreground">
                  Did you mean:{" "}
                  {suggestions.data.slice(0, 4).map((s, i) => (
                    <span key={s.tag}>
                      {i > 0 ? ", " : ""}
                      <button
                        type="button"
                        className="underline underline-offset-4"
                        onClick={() => setDraft({ ...draft, name: s.tag })}
                      >
                        {s.tag}
                      </button>
                    </span>
                  ))}
                  ?
                </p>
              ) : null
            ) : null}
            <Label htmlFor="tag-color">Colour</Label>
            <TagColorPalette
              id="tag-color"
              value={draft.color}
              onChange={(color) => setDraft({ ...draft, color })}
              disabled={busy}
            />
            <Label htmlFor="tag-description">Description</Label>
            <Textarea
              id="tag-description"
              maxLength={1024}
              placeholder="What does this tag mean? Who should get it?"
              value={draft.description}
              onChange={(e) =>
                setDraft({ ...draft, description: e.target.value })
              }
            />
            <p className="text-xs text-muted-foreground">
              {runeLength(draft.description).toLocaleString()} / 1,024
              characters.
            </p>
            <Label htmlFor="tag-group">Group</Label>
            <Select
              id="tag-group"
              value={draft.group_id}
              onChange={(e) => setDraft({ ...draft, group_id: e.target.value })}
            >
              <option value="">No group</option>
              {groupRows.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </Select>
            <label className="flex items-center gap-2">
              <Checkbox
                checked={draft.pii}
                onChange={(event) =>
                  setDraft({ ...draft, pii: event.target.checked })
                }
              />{" "}
              Contains PII
            </label>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setFormOpen(false)}
            >
              Cancel
            </Button>
            <Button disabled={busy} onClick={saveTag}>
              {busy ? "Saving…" : editing ? "Save changes" : "Create tag"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <TagDetailDialog
        tag={inspectTag}
        count={inspectTag ? tagSubscriberCount(inspectTag, usage) : null}
        tenantId={tenantId}
        role={role}
        canWrite={canWrite}
        authorize={auth}
        onClose={() => setInspectId(null)}
        onUpdated={async (next) => {
          qc.setQueryData<TagRecord[]>(tagsKey, (prev) =>
            Array.isArray(prev)
              ? prev.map((x) => (x.id === next.id ? next : x))
              : prev,
          );
          await invalidateCatalogue();
        }}
        onConflict={invalidateCatalogue}
      />
      <Dialog
        open={Boolean(membersTag)}
        onOpenChange={(v) => !v && setMembersId(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Change {membersTag?.name} memberships</DialogTitle>
            <DialogDescription>
              Enter subscriber UUIDs separated by commas or whitespace (maximum
              1,000).
            </DialogDescription>
          </DialogHeader>
          <Textarea
            aria-label="Subscriber UUIDs"
            value={memberIds}
            onChange={(e) => setMemberIds(e.target.value)}
            rows={8}
          />
          <DialogFooter>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => membership("unapply")}
            >
              Remove tag
            </Button>
            <Button disabled={busy} onClick={() => membership("apply")}>
              Apply tag
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <BulkEditDialog
        open={bulk.open}
        mode={bulk.mode}
        tags={selectedRecords}
        authorize={auth}
        onClose={() => setBulk((b) => ({ ...b, open: false }))}
        onSettled={async ({ failedIds }) => {
          await invalidateCatalogue();
          // Keep the submitted rows visible while refresh is pending, so the
          // running dialog cannot announce "Updating 2 of 0".
          setSelected(new Set(failedIds));
        }}
      />
      <MergeTagsDialog
        open={merge.open && canMerge}
        tags={rows}
        usage={usage}
        initialFrom={merge.from}
        authorize={auth}
        onClose={() => setMerge((m) => ({ ...m, open: false }))}
        onMerged={async () => {
          setSelected(new Set());
          await invalidateCatalogue();
        }}
      />
      <RegisterOrphanDialog
        usage={registerTarget}
        authorize={auth}
        onClose={() => setRegisterTarget(null)}
        onRegistered={async () => {
          setRegisterTarget(null);
          await invalidateCatalogue();
        }}
      />
      <ConfirmDialog
        open={Boolean(groupDelete)}
        onOpenChange={(v) => !v && setGroupDelete(null)}
        title="Delete tag group?"
        description="Tags remain and become ungrouped. Type the exact group name to continue."
        confirmationToken={groupDelete?.name}
        confirmLabel="Delete group"
        onConfirm={destroyGroup}
      />
    </PageShell>
  );
}
