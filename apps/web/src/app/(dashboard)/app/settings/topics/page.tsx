// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import Link from "next/link";
import { Eye, GripVertical, ListChecks } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { useQuery, useQueryClient } from "@tanstack/react-query";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  type CreateTopicInput,
  type Topic,
  createTopic,
  deleteTopic,
  listTopics,
  updateTopic,
} from "@/lib/preferences-api";
import { effectiveAuthRole, whoami } from "@/lib/auth-api";
import { verifyFreshAdminAuthority } from "@/lib/admin-mutation-authority";
import { qk, STALE } from "@/lib/query-keys";
import { commitTopicOrder } from "./reorder";
import { isDuplicateSlug, isValidSlug, slugify } from "@/lib/topic-slug";
import { roleCanWrite } from "@/lib/use-admin-gate";

const UNDO_WINDOW_MS = 6000;

function errText(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

export default function TopicsPage() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [draft, setDraft] = useState<CreateTopicInput>({
    slug: "",
    name: "",
    description: "",
    defaultOptIn: true,
    displayOrder: 0,
  });
  const [slugEdited, setSlugEdited] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const creatingRef = useRef(false);
  const createErrorRef = useRef<HTMLParagraphElement>(null);
  const createReturnFocusRef = useRef<HTMLButtonElement | null>(null);
  const previewReturnFocusRef = useRef<HTMLButtonElement | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  // Pending deletes are local intents only. Navigation or an identity change
  // cancels them; an old principal must never commit a delayed DELETE.
  const pendingDeletes = useRef<
    Map<string, { timer: ReturnType<typeof setTimeout>; commit: () => void }>
  >(new Map());

  const meQuery = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const tenantId = meQuery.data?.tenant_id ?? "anon";
  const userId = meQuery.data?.user_id ?? "anon";
  const viewerState = meQuery.data?.viewer_mode
    ? "viewer-mode"
    : "durable-mode";
  const role = meQuery.data?.viewer_mode
    ? "viewer"
    : meQuery.data
      ? effectiveAuthRole(meQuery.data)
      : null;
  const canWrite = Boolean(meQuery.isSuccess && roleCanWrite(role));
  const topicsKey = useMemo(
    () =>
      [...qk.settings(tenantId, role, "topics"), userId, viewerState] as const,
    [role, tenantId, userId, viewerState],
  );
  const topicsQuery = useQuery({
    queryKey: topicsKey,
    queryFn: listTopics,
    enabled: meQuery.isSuccess && canWrite,
    staleTime: STALE.list,
  });
  const topics = Array.isArray(topicsQuery.data) ? topicsQuery.data : [];
  // A disabled query stays `pending` forever in TanStack v5, so the canWrite
  // term is load-bearing: without it a non-writer — whose topics query never
  // runs — sits on skeletons that can never resolve.
  const loading =
    meQuery.isLoading ||
    (canWrite && topicsQuery.isPending && !topicsQuery.data);
  const loadError =
    topicsQuery.error instanceof Error
      ? topicsQuery.error.message
      : topicsQuery.isError
        ? "Could not load topics — this is a failed request, not a workspace without topics."
        : null;

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (
      new URLSearchParams(window.location.search).get("create") === "1" &&
      canWrite
    ) {
      setOpen(true);
    }
  }, [canWrite]);

  useEffect(() => {
    const pending = pendingDeletes.current;
    return () => {
      for (const { timer } of pending.values()) {
        clearTimeout(timer);
      }
      pending.clear();
    };
  }, []);

  useEffect(() => {
    for (const { timer } of pendingDeletes.current.values())
      clearTimeout(timer);
    pendingDeletes.current.clear();
    creatingRef.current = false;
    setCreating(false);
    setOpen(false);
    setDraft({
      slug: "",
      name: "",
      description: "",
      defaultOptIn: true,
      displayOrder: 0,
    });
    setSlugEdited(false);
    setCreateError(null);
    if (!meQuery.isSuccess || !canWrite) {
      void queryClient.cancelQueries({ queryKey: topicsKey });
      queryClient.removeQueries({ queryKey: topicsKey });
    }
  }, [canWrite, meQuery.isSuccess, topicsKey, queryClient]);

  const invalidateTopics = (): Promise<void> =>
    queryClient
      .invalidateQueries({ queryKey: topicsKey, exact: false })
      .then(() => undefined);

  const slug = draft.slug.trim();
  const name = draft.name.trim();
  const slugFormatError =
    slug.length > 0 && !isValidSlug(slug)
      ? "Use kebab-case: lowercase letters, numbers, and single dashes."
      : null;
  const slugDuplicateError = isDuplicateSlug(slug, topics)
    ? "A topic with this slug already exists."
    : null;
  const createDisabled =
    creating ||
    !slug ||
    !name ||
    Boolean(slugFormatError) ||
    Boolean(slugDuplicateError);

  useEffect(() => {
    if (createError) createErrorRef.current?.focus();
  }, [createError]);

  const resetCreateDraft = () => {
    setDraft({
      slug: "",
      name: "",
      description: "",
      defaultOptIn: true,
      displayOrder: 0,
    });
    setSlugEdited(false);
    setCreateError(null);
  };

  const setName = (value: string) => {
    if (createError) setCreateError(null);
    setDraft((d) => ({
      ...d,
      name: value,
      // Auto-derive the slug from the name until the user edits it manually.
      slug: slugEdited ? d.slug : slugify(value),
    }));
  };

  const handleCreate = async () => {
    if (creatingRef.current) return;
    if (!canWrite || !meQuery.data) return;
    if (!slug || !name) {
      const message = "Slug and name are required.";
      setCreateError(message);
      toast.error(message);
      return;
    }
    if (slugFormatError || slugDuplicateError) return;
    creatingRef.current = true;
    setCreateError(null);
    setCreating(true);
    try {
      const openedIdentity = meQuery.data;
      await verifyFreshAdminAuthority(openedIdentity);
      const t = await createTopic({
        ...draft,
        slug,
        name,
        displayOrder: topics.length,
      });
      queryClient.setQueryData<Topic[]>(topicsKey, (cur) => [
        ...(cur ?? []),
        t,
      ]);
      creatingRef.current = false;
      setOpen(false);
      resetCreateDraft();
      setTimeout(() => createReturnFocusRef.current?.focus(), 0);
      toast.success("Topic created.");
      void invalidateTopics();
    } catch (err) {
      const message = errText(err, "Could not create topic.");
      setCreateError(message);
      toast.error(message);
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
  };

  // Undo-window delete (SETA-039): remove optimistically, delay the irreversible
  // server delete so an accidental removal (which also drops consent state) can
  // be undone. True archive/soft-delete remains a backend capability.
  const handleDelete = (topic: Topic) => {
    if (!canWrite || !meQuery.data || pendingDeletes.current.has(topic.id))
      return;
    const openedIdentity = meQuery.data;
    queryClient.setQueryData<Topic[]>(topicsKey, (cur) =>
      (cur ?? []).filter((t) => t.id !== topic.id),
    );
    const commit = () => {
      pendingDeletes.current.delete(topic.id);
      void (async () => {
        try {
          await verifyFreshAdminAuthority(openedIdentity);
          await deleteTopic(topic.id);
          // A list read can finish during the six-second undo window and put
          // this row back into the cache before the delayed DELETE commits.
          // Re-apply the authoritative removal after the server accepts the
          // delete, then resync. Otherwise a successful delete can leave a
          // visibly stale row until the next unrelated refetch.
          await queryClient.cancelQueries({
            queryKey: topicsKey,
            exact: false,
          });
          queryClient.setQueryData<Topic[]>(topicsKey, (cur) =>
            (cur ?? []).filter((candidate) => candidate.id !== topic.id),
          );
          void invalidateTopics();
        } catch (err) {
          // Resync from the server rather than restoring a list snapshot taken
          // when THIS delete started: with two deletes in the same undo window,
          // that snapshot would put the second one — already deleted on the
          // server — back on screen.
          void invalidateTopics();
          toast.error(errText(err, "Delete failed."));
        }
      })();
    };
    const timer = setTimeout(commit, UNDO_WINDOW_MS);
    pendingDeletes.current.set(topic.id, { timer, commit });
    toast.success(`"${topic.name}" deleted.`, {
      action: {
        label: "Undo",
        onClick: () => {
          const entry = pendingDeletes.current.get(topic.id);
          if (entry) {
            clearTimeout(entry.timer);
            pendingDeletes.current.delete(topic.id);
          }
          // Put back just this topic, in its original slot. Restoring a
          // whole-list snapshot would also resurrect any OTHER topic deleted
          // in the same undo window.
          queryClient.setQueryData<Topic[]>(topicsKey, (cur) =>
            [...(cur ?? []).filter((t) => t.id !== topic.id), topic].sort(
              (a, b) => a.displayOrder - b.displayOrder,
            ),
          );
        },
      },
    });
  };

  // Persist a whole reordering: optimistic cache set, then PATCH only the
  // topics whose displayOrder changed. Reverting is correct ONLY when every
  // write failed — see commitTopicOrder, which re-reads the server on a partial
  // failure rather than restoring an order the server no longer holds.
  const commitOrder = async (next: Topic[]) => {
    if (!canWrite || !meQuery.data) return;
    const openedIdentity = meQuery.data;
    await commitTopicOrder(next, topics, {
      update: async (id, patch) => {
        await verifyFreshAdminAuthority(openedIdentity);
        return updateTopic(id, patch);
      },
      setCache: (rows) => queryClient.setQueryData<Topic[]>(topicsKey, rows),
      resync: () => void invalidateTopics(),
      onError: (message) => toast.error(message),
    });
  };

  const move = (id: string, dir: -1 | 1) => {
    const idx = topics.findIndex((t) => t.id === id);
    const swap = idx + dir;
    if (idx < 0 || swap < 0 || swap >= topics.length) return;
    const next = [...topics];
    [next[idx], next[swap]] = [next[swap], next[idx]];
    void commitOrder(next);
  };

  const onDrop = (targetId: string) => {
    const from = draggingId;
    setDraggingId(null);
    if (!from || from === targetId) return;
    const fromIdx = topics.findIndex((t) => t.id === from);
    const toIdx = topics.findIndex((t) => t.id === targetId);
    if (fromIdx < 0 || toIdx < 0) return;
    const next = [...topics];
    const [moved] = next.splice(fromIdx, 1);
    next.splice(toIdx, 0, moved);
    void commitOrder(next);
  };

  return (
    <div className="max-w-5xl space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-xl font-semibold tracking-tight">
            Topics
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Subscription topics that power the hosted preference center.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={topics.length === 0}
          title={
            topics.length > 0
              ? undefined
              : canWrite
                ? "Add a topic to preview the preference center"
                : "Topics are readable by owners and admins, so there is nothing to preview for this role"
          }
          onClick={(event) => {
            previewReturnFocusRef.current = event.currentTarget;
            setPreviewOpen(true);
          }}
        >
          <Eye className="h-4 w-4" />
          Preview preference center
        </Button>
      </header>

      <Card>
        <CardHeader className="flex-row items-start justify-between">
          <div>
            <CardTitle>Topics</CardTitle>
            <CardDescription>
              Subscribers see this list and toggle opt-in per topic. Drag to set
              the order they appear on the hosted page.
            </CardDescription>
          </div>
          {canWrite ? (
            <Dialog
              open={open}
              onOpenChange={(next) => {
                if (!next && creatingRef.current) return;
                setOpen(next);
                if (next) setCreateError(null);
                else {
                  resetCreateDraft();
                  setTimeout(() => createReturnFocusRef.current?.focus(), 0);
                }
              }}
            >
              <DialogTrigger asChild>
                <Button
                  ref={createReturnFocusRef}
                  type="button"
                  onClick={(event) => {
                    createReturnFocusRef.current = event.currentTarget;
                  }}
                >
                  Add topic
                </Button>
              </DialogTrigger>
              <DialogContent
                aria-busy={creating}
                className="[&_button]:min-h-11 [&_input]:min-h-11 [&_input]:text-base sm:[&_button]:min-h-0 sm:[&_input]:min-h-0 sm:[&_input]:text-sm"
                onEscapeKeyDown={(event) => {
                  if (creatingRef.current) event.preventDefault();
                }}
                onPointerDownOutside={(event) => {
                  if (creatingRef.current) event.preventDefault();
                }}
                onCloseAutoFocus={(event) => {
                  if (!createReturnFocusRef.current) return;
                  event.preventDefault();
                  createReturnFocusRef.current.focus();
                }}
              >
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void handleCreate();
                  }}
                >
                  <DialogHeader>
                    <DialogTitle>New topic</DialogTitle>
                    <DialogDescription>
                      Name is what subscribers see. The slug is a stable
                      identifier, auto-derived from the name.
                    </DialogDescription>
                  </DialogHeader>
                  <div className="space-y-4 py-2">
                    <div className="space-y-2">
                      <Label htmlFor="t-name">Name</Label>
                      <Input
                        id="t-name"
                        placeholder="Weekly digest"
                        maxLength={256}
                        value={draft.name}
                        disabled={creating}
                        aria-describedby={
                          createError ? "topic-create-error" : undefined
                        }
                        onChange={(e) => setName(e.target.value)}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="t-slug">Slug</Label>
                      <Input
                        id="t-slug"
                        placeholder="weekly-digest"
                        maxLength={64}
                        value={draft.slug}
                        disabled={creating}
                        aria-invalid={Boolean(
                          slugFormatError || slugDuplicateError,
                        )}
                        aria-describedby={
                          slugFormatError || slugDuplicateError
                            ? "topic-slug-error"
                            : createError
                              ? "topic-create-error"
                              : undefined
                        }
                        onChange={(e) => {
                          setSlugEdited(true);
                          if (createError) setCreateError(null);
                          setDraft((d) => ({ ...d, slug: e.target.value }));
                        }}
                      />
                      {slugFormatError || slugDuplicateError ? (
                        <p
                          id="topic-slug-error"
                          className="text-xs text-destructive"
                        >
                          {slugFormatError ?? slugDuplicateError}
                        </p>
                      ) : (
                        <p className="text-xs text-muted-foreground">
                          Used in URLs and the API. Kebab-case.
                        </p>
                      )}
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="t-desc">Description</Label>
                      <Input
                        id="t-desc"
                        placeholder="Short Friday recap of what we shipped."
                        maxLength={2048}
                        value={draft.description ?? ""}
                        disabled={creating}
                        onChange={(e) => {
                          if (createError) setCreateError(null);
                          setDraft((d) => ({
                            ...d,
                            description: e.target.value,
                          }));
                        }}
                      />
                    </div>
                    <label className="flex cursor-pointer items-center gap-2 text-sm">
                      <Checkbox
                        checked={draft.defaultOptIn}
                        disabled={creating}
                        onChange={(e) =>
                          setDraft((d) => ({
                            ...d,
                            defaultOptIn: e.target.checked,
                          }))
                        }
                      />
                      Default to opted-in for new subscribers
                    </label>
                    {createError ? (
                      <p
                        ref={createErrorRef}
                        id="topic-create-error"
                        role="alert"
                        tabIndex={-1}
                        className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive-emphasis outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        {createError}
                      </p>
                    ) : null}
                  </div>
                  <DialogFooter>
                    <DialogClose asChild>
                      <Button variant="ghost" type="button" disabled={creating}>
                        Cancel
                      </Button>
                    </DialogClose>
                    <Button
                      type="submit"
                      disabled={createDisabled}
                      loading={creating}
                    >
                      {creating ? "Creating…" : "Create"}
                    </Button>
                  </DialogFooter>
                </form>
              </DialogContent>
            </Dialog>
          ) : null}
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="space-y-2">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : !canWrite ? (
            <div className="rounded-md border bg-muted/30 p-4">
              <p className="text-sm font-medium">
                Owner or admin access required
              </p>
              <p className="mt-1 text-sm text-muted-foreground" role="status">
                Topics are managed by owners and admins. No topic data was
                fetched for this role, so this is not a workspace without
                topics.
              </p>
            </div>
          ) : loadError ? (
            <div className="flex flex-col items-start gap-2">
              <p className="text-sm text-destructive">
                Could not load topics: {loadError}
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void topicsQuery.refetch()}
              >
                Retry
              </Button>
            </div>
          ) : topics.length === 0 ? (
            <EmptyState
              icon={ListChecks}
              title="No topics yet"
              description="Add a topic to enable the hosted preference center where subscribers manage what they hear about."
              action={
                canWrite ? (
                  <Button
                    type="button"
                    onClick={(event) => {
                      createReturnFocusRef.current = event.currentTarget;
                      setOpen(true);
                    }}
                  >
                    Add topic
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <TableContainer>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-24">Order</TableHead>
                    <TableHead>Topic</TableHead>
                    <TableHead>Default</TableHead>
                    <TableHead className="text-right">Subscribers</TableHead>
                    {canWrite ? (
                      <TableHead className="text-right">Actions</TableHead>
                    ) : null}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {topics.map((t, i) => (
                    <TableRow
                      key={t.id}
                      className="align-top"
                      draggable={canWrite}
                      onDragStart={() => canWrite && setDraggingId(t.id)}
                      onDragOver={(e) => {
                        if (canWrite && draggingId) e.preventDefault();
                      }}
                      onDrop={() => canWrite && onDrop(t.id)}
                      data-dragging={draggingId === t.id ? "" : undefined}
                    >
                      <TableCell>
                        <div className="flex items-center gap-1">
                          {canWrite ? (
                            <span
                              className="cursor-grab text-muted-foreground active:cursor-grabbing"
                              aria-hidden
                            >
                              <GripVertical className="h-4 w-4" />
                            </span>
                          ) : null}
                          {canWrite ? (
                            <div className="flex flex-col">
                              <button
                                type="button"
                                className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-40"
                                onClick={() => move(t.id, -1)}
                                disabled={i === 0}
                                aria-label={`Move ${t.name} up`}
                              >
                                ▲
                              </button>
                              <button
                                type="button"
                                className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-40"
                                onClick={() => move(t.id, 1)}
                                disabled={i === topics.length - 1}
                                aria-label={`Move ${t.name} down`}
                              >
                                ▼
                              </button>
                            </div>
                          ) : (
                            <span className="text-xs text-muted-foreground">
                              {i + 1}
                            </span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="font-medium">{t.name}</div>
                        <div className="font-mono text-xs text-muted-foreground">
                          {t.slug}
                        </div>
                        {t.description ? (
                          <div className="mt-1 max-w-prose text-xs text-muted-foreground">
                            {t.description}
                          </div>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        {t.defaultOptIn ? (
                          <Badge variant="warning">Opt-in</Badge>
                        ) : (
                          <Badge variant="secondary">Opt-out</Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-right text-sm tabular-nums">
                        <Link
                          href={`/app/subscribers?q=topic:${encodeURIComponent(t.slug)}`}
                          className="group inline-flex flex-col items-end rounded px-1 hover:bg-accent/50"
                          title={`View subscribers opted into ${t.name}`}
                        >
                          <span>
                            {(t.optedInCount ?? 0).toLocaleString()}{" "}
                            <span className="text-xs text-muted-foreground group-hover:text-foreground">
                              opted-in
                            </span>
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {(t.optedOutCount ?? 0).toLocaleString()} opted-out
                          </span>
                        </Link>
                      </TableCell>
                      {canWrite ? (
                        <TableCell className="space-x-2 text-right">
                          <Button
                            asChild
                            variant="ghost"
                            size="sm"
                            type="button"
                          >
                            <Link href={`/app/settings/topics/${t.id}/edit`}>
                              Edit
                            </Link>
                          </Button>
                          <ConfirmDialog
                            title="Delete topic?"
                            description={`"${t.name}" will be removed from the preference center. Subscriber opt-in state for this topic is also removed. You'll have a few seconds to undo.`}
                            confirmLabel="Delete"
                            onConfirm={() => handleDelete(t)}
                            fallbackFocusRef={createReturnFocusRef}
                            trigger={
                              <Button variant="ghost" size="sm" type="button">
                                Delete
                              </Button>
                            }
                          />
                        </TableCell>
                      ) : null}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </CardContent>
      </Card>

      {/* Preview: a faithful sample render of the hosted preference center so an
          admin can confirm ordering, descriptions, and default states (SETA-005). */}
      <Dialog
        open={previewOpen}
        onOpenChange={(next) => {
          setPreviewOpen(next);
          if (!next) {
            setTimeout(() => previewReturnFocusRef.current?.focus(), 0);
          }
        }}
      >
        <DialogContent
          className="max-w-md [&_button]:min-h-11 sm:[&_button]:min-h-0"
          onCloseAutoFocus={(event) => {
            if (!previewReturnFocusRef.current) return;
            event.preventDefault();
            previewReturnFocusRef.current.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>Preference center preview</DialogTitle>
            <DialogDescription>
              A sample of what subscribers see. Toggles reflect each
              topic&apos;s default opt-in state.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 rounded-md border bg-muted/20 p-4">
            <p className="text-sm font-medium">Manage your subscriptions</p>
            {topics.map((t) => (
              <div
                key={t.id}
                className="flex items-start justify-between gap-3 border-b pb-3 last:border-b-0 last:pb-0"
              >
                <div className="min-w-0 break-words">
                  <div className="text-sm font-medium break-words">
                    {t.name}
                  </div>
                  {t.description ? (
                    <div className="text-xs text-muted-foreground">
                      {t.description}
                    </div>
                  ) : null}
                </div>
                <Checkbox
                  checked={t.defaultOptIn}
                  disabled
                  aria-label={t.name}
                />
              </div>
            ))}
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button">Close</Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
