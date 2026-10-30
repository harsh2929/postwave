// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import Link from "next/link";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import {
  keepPreviousData,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  BookOpen,
  Copy,
  FileJson,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  Upload,
} from "lucide-react";
import { toast } from "sonner";

import { PageShell } from "@/components/dashboard/page-shell";
import { Button } from "@/components/ui/button";
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
import {
  effectiveAuthRole,
  whoami,
  whoamiFresh,
  type MeResponse,
} from "@/lib/auth-api";
import { apiErrorMessage } from "@/lib/api";
import { copyToClipboard, isClipboardAvailable } from "@/lib/clipboard";
import { loadNextQueryPage } from "@/lib/infinite-query-action";
import {
  createCollection,
  createSavedBlock,
  deleteCollection,
  deleteSavedBlock,
  getCollection,
  getSavedBlock,
  listCollections,
  listSavedBlocks,
  updateCollection,
  updateSavedBlock,
  type Collection,
  type CollectionRow,
  type CollectionSource,
  type CollectionType,
  type SavedBlock,
  type SavedBlockKind,
} from "@/lib/content-library-api";
import { qk, STALE } from "@/lib/query-keys";
import {
  getTemplateBlockImpact,
  type TemplateBlockImpact,
} from "@/lib/template-block-impact-api";

const PAGE_SIZE = 30;
const MAX_IMPORT_BYTES = 1024 * 1024;
const SEARCH_DEBOUNCE_MS = 250;

/** Settles `value` after `ms` of no changes — the search cadence. */
function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

function mutationKey(kind: string, id = "create"): string {
  const nonce =
    globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  return `web-content-library:${kind}:${id}:${nonce}`;
}

function assertSameIdentity(current: MeResponse, fresh: MeResponse): void {
  if (
    current.user_id !== fresh.user_id ||
    current.tenant_id !== fresh.tenant_id ||
    effectiveAuthRole(current) !== effectiveAuthRole(fresh) ||
    Boolean(current.viewer_mode) !== Boolean(fresh.viewer_mode)
  ) {
    throw new Error(
      "Your workspace identity changed. Nothing was written; refresh and try again.",
    );
  }
  if (fresh.viewer_mode || effectiveAuthRole(fresh) === "viewer") {
    throw new Error("This workspace is read-only for your current role.");
  }
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function parseJSONObject(
  value: string,
  label: string,
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = value.trim() ? JSON.parse(value) : {};
  } catch {
    throw new Error(`${label} must be valid JSON.`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

function parseCollectionRows(value: string): CollectionRow[] {
  let parsed: unknown;
  try {
    parsed = value.trim() ? JSON.parse(value) : [];
  } catch {
    throw new Error("Collection data must be valid JSON.");
  }
  if (
    !Array.isArray(parsed) ||
    parsed.some((row) => !row || typeof row !== "object" || Array.isArray(row))
  ) {
    throw new Error("Collection data must be an array of JSON objects.");
  }
  return parsed as CollectionRow[];
}

interface BlockDraft {
  mode: "create" | "edit" | "inspect";
  original: SavedBlock | null;
  name: string;
  kind: SavedBlockKind;
  bodyHtml: string;
  bodyJSON: string;
}

interface CollectionDraft {
  mode: "create" | "edit" | "inspect";
  original: Collection | null;
  name: string;
  collectionType: CollectionType;
  sourceType: CollectionSource;
  dataJSON: string;
}

function SavedBlockDialog({
  draft,
  setDraft,
  me,
  writable,
  onClose,
  onSaved,
}: {
  draft: BlockDraft | null;
  setDraft: (draft: BlockDraft) => void;
  me: MeResponse;
  writable: boolean;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const [impact, setImpact] = useState<TemplateBlockImpact | null>(null);
  const [impactError, setImpactError] = useState<string | null>(null);
  const [impactLoading, setImpactLoading] = useState(false);
  const nameId = useId();
  const kindId = useId();
  const htmlId = useId();
  const jsonId = useId();
  const editable = Boolean(draft && writable && draft.mode !== "inspect");

  useEffect(() => {
    const id = draft?.original?.id;
    setImpact(null);
    setImpactError(null);
    if (!id) return;
    const controller = new AbortController();
    setImpactLoading(true);
    void getTemplateBlockImpact(id, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setImpact(result);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setImpactError(
            cause instanceof Error
              ? cause.message
              : "Could not check linked templates.",
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setImpactLoading(false);
      });
    return () => controller.abort();
  }, [draft?.original?.id]);

  async function save() {
    if (!draft || !editable || pending) return;
    setPending(true);
    try {
      const fresh = await whoamiFresh();
      assertSameIdentity(me, fresh);
      const bodyJson = parseJSONObject(draft.bodyJSON, "Block JSON");
      if (draft.mode === "create") {
        await createSavedBlock({
          tenantId: me.tenant_id,
          name: draft.name,
          kind: draft.kind,
          bodyHtml: draft.bodyHtml,
          bodyJson,
          idempotencyKey: mutationKey("block-create"),
        });
      } else {
        const original = draft.original!;
        const current = await getSavedBlock({
          tenantId: me.tenant_id,
          id: original.id,
        });
        if (current.version !== original.version) {
          throw new Error(
            "This saved block changed after you opened it. Nothing was written; reopen it and review the current version.",
          );
        }
        await updateSavedBlock({
          tenantId: me.tenant_id,
          id: current.id,
          expectedVersion: current.version,
          name: draft.name,
          kind: draft.kind,
          bodyHtml: draft.bodyHtml,
          bodyJson,
          idempotencyKey: mutationKey("block-update", current.id),
        });
      }
      await onSaved();
      toast.success(
        draft.mode === "create" ? "Saved block created" : "Saved block updated",
      );
      onClose();
    } catch (cause) {
      toast.error(apiErrorMessage(cause, "Saved block could not be saved."));
    } finally {
      setPending(false);
    }
  }

  if (!draft) return null;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogContent className="max-w-3xl" closeDisabled={pending}>
        <DialogHeader>
          <DialogTitle>
            {draft.mode === "create"
              ? "Create saved block"
              : draft.mode === "edit"
                ? "Edit saved block"
                : draft.name}
          </DialogTitle>
          <DialogDescription>
            Reusable HTML and structured editor content. HTML is stored, not
            executed on this screen.
          </DialogDescription>
        </DialogHeader>
        {draft.original ? (
          <section
            className="space-y-2 rounded-md border bg-muted/20 p-3 text-xs"
            aria-label="Linked template impact"
          >
            <p className="font-medium">Template impact</p>
            {impactLoading ? (
              <p className="text-muted-foreground">
                Checking linked templates…
              </p>
            ) : null}
            {impactError ? (
              <p role="alert" className="text-destructive">
                {impactError} Do not assume this block is unused.
              </p>
            ) : null}
            {impact && impact.items.length === 0 ? (
              <p className="text-muted-foreground">
                No version-pinned template references found.
              </p>
            ) : null}
            {impact?.items.length ? (
              <ul className="max-h-40 space-y-1 overflow-auto">
                {impact.items.map((item) => (
                  <li key={item.template_id}>
                    <Link
                      className="underline-offset-2 hover:underline"
                      href={`/app/templates/${item.template_id}`}
                    >
                      {item.template_name || "Untitled template"}
                    </Link>{" "}
                    · template v{item.template_version} · block pinned at v
                    {item.pinned_version || "?"}
                  </li>
                ))}
              </ul>
            ) : null}
            {impact?.truncated ? (
              <p className="text-amber-800">
                More than 100 linked references exist; this list is incomplete.
              </p>
            ) : null}
            <p className="text-muted-foreground">
              Updating this block does not silently alter pinned templates.
              Authors review and apply updates in each template editor.
            </p>
          </section>
        ) : null}
        <div className="grid gap-4">
          <div>
            <Label htmlFor={nameId}>Name</Label>
            <Input
              id={nameId}
              value={draft.name}
              maxLength={120}
              readOnly={!editable}
              disabled={pending}
              onChange={(event) =>
                setDraft({ ...draft, name: event.target.value })
              }
            />
          </div>
          <div>
            <Label htmlFor={kindId}>Kind</Label>
            <Select
              id={kindId}
              value={draft.kind}
              disabled={!editable || pending}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  kind: event.target.value as SavedBlockKind,
                })
              }
            >
              <option value="block">Block</option>
              <option value="snippet">Snippet</option>
              <option value="section">Section</option>
            </Select>
          </div>
          <div>
            <Label htmlFor={htmlId}>HTML</Label>
            <Textarea
              id={htmlId}
              className="min-h-40 font-mono text-xs"
              value={draft.bodyHtml}
              readOnly={!editable}
              disabled={pending}
              onChange={(event) =>
                setDraft({ ...draft, bodyHtml: event.target.value })
              }
            />
          </div>
          <div>
            <Label htmlFor={jsonId}>Structured JSON</Label>
            <Textarea
              id={jsonId}
              className="min-h-40 font-mono text-xs"
              value={draft.bodyJSON}
              readOnly={!editable}
              disabled={pending}
              onChange={(event) =>
                setDraft({ ...draft, bodyJSON: event.target.value })
              }
            />
          </div>
          {draft.original ? (
            <p className="text-xs text-muted-foreground">
              Updated {formatDate(draft.original.updatedAt)} · version{" "}
              {draft.original.version}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={pending} onClick={onClose}>
            {editable ? "Cancel" : "Close"}
          </Button>
          {editable ? (
            <Button
              loading={pending}
              disabled={
                !draft.name.trim() ||
                (!draft.bodyHtml.trim() && draft.bodyJSON.trim() === "{}")
              }
              onClick={save}
            >
              Save block
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CollectionDialog({
  draft,
  setDraft,
  me,
  writable,
  onClose,
  onSaved,
}: {
  draft: CollectionDraft | null;
  setDraft: (draft: CollectionDraft) => void;
  me: MeResponse;
  writable: boolean;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const importRef = useRef<HTMLInputElement>(null);
  const nameId = useId();
  const typeId = useId();
  const sourceId = useId();
  const dataId = useId();
  const editable = Boolean(draft && writable && draft.mode !== "inspect");

  async function importJSON(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !draft) return;
    if (file.size < 1 || file.size > MAX_IMPORT_BYTES) {
      toast.error("Choose a non-empty JSON file no larger than 1 MiB.");
      return;
    }
    if (
      file.type &&
      file.type !== "application/json" &&
      file.type !== "text/json"
    ) {
      toast.error("The imported file must declare a JSON content type.");
      return;
    }
    try {
      const text = await file.text();
      const rows = parseCollectionRows(text);
      setDraft({
        ...draft,
        sourceType: "uploaded",
        dataJSON: JSON.stringify(rows, null, 2),
      });
      toast.success(
        `${rows.length} row${rows.length === 1 ? "" : "s"} imported`,
      );
    } catch (cause) {
      toast.error(apiErrorMessage(cause, "JSON import failed."));
    }
  }

  async function save() {
    if (!draft || !editable || pending) return;
    setPending(true);
    try {
      const fresh = await whoamiFresh();
      assertSameIdentity(me, fresh);
      const data = parseCollectionRows(draft.dataJSON);
      if (draft.mode === "create") {
        await createCollection({
          tenantId: me.tenant_id,
          name: draft.name,
          collectionType: draft.collectionType,
          sourceType: draft.sourceType,
          data,
          idempotencyKey: mutationKey("collection-create"),
        });
      } else {
        const original = draft.original!;
        const current = await getCollection({
          tenantId: me.tenant_id,
          id: original.id,
        });
        if (current.version !== original.version) {
          throw new Error(
            "This collection changed after you opened it. Nothing was written; reopen it and review the current version.",
          );
        }
        await updateCollection({
          tenantId: me.tenant_id,
          id: current.id,
          expectedVersion: current.version,
          name: draft.name,
          collectionType: draft.collectionType,
          sourceType: draft.sourceType,
          data,
          idempotencyKey: mutationKey("collection-update", current.id),
        });
      }
      await onSaved();
      toast.success(
        draft.mode === "create" ? "Collection created" : "Collection updated",
      );
      onClose();
    } catch (cause) {
      toast.error(apiErrorMessage(cause, "Collection could not be saved."));
    } finally {
      setPending(false);
    }
  }

  if (!draft) return null;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogContent className="max-w-3xl" closeDisabled={pending}>
        <DialogHeader>
          <DialogTitle>
            {draft.mode === "create"
              ? "Create collection"
              : draft.mode === "edit"
                ? "Edit collection"
                : draft.name}
          </DialogTitle>
          <DialogDescription>
            Workspace reference data for coupons, content, or schedules. These
            rows do not activate coupon delivery or automation.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div>
            <Label htmlFor={nameId}>Name</Label>
            <Input
              id={nameId}
              value={draft.name}
              maxLength={200}
              readOnly={!editable}
              disabled={pending}
              onChange={(event) =>
                setDraft({ ...draft, name: event.target.value })
              }
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor={typeId}>Collection type</Label>
              <Select
                id={typeId}
                value={draft.collectionType}
                disabled={!editable || pending}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    collectionType: event.target.value as CollectionType,
                  })
                }
              >
                <option value="coupons">Coupons</option>
                <option value="content">Content</option>
                <option value="schedule">Schedule</option>
              </Select>
            </div>
            <div>
              <Label htmlFor={sourceId}>Source</Label>
              <Select
                id={sourceId}
                value={draft.sourceType}
                disabled={!editable || pending}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    sourceType: event.target.value as CollectionSource,
                  })
                }
              >
                <option value="manual">Manual</option>
                <option value="uploaded">Uploaded</option>
                <option value="api">API</option>
              </Select>
            </div>
          </div>
          <div>
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor={dataId}>Rows (JSON array of objects)</Label>
              {editable ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  onClick={() => importRef.current?.click()}
                >
                  <Upload /> Import JSON
                </Button>
              ) : null}
            </div>
            <input
              ref={importRef}
              type="file"
              accept="application/json,text/json,.json"
              className="sr-only"
              onChange={importJSON}
            />
            <Textarea
              id={dataId}
              className="mt-1 min-h-72 font-mono text-xs"
              value={draft.dataJSON}
              readOnly={!editable}
              disabled={pending}
              onChange={(event) =>
                setDraft({ ...draft, dataJSON: event.target.value })
              }
            />
          </div>
          {draft.original ? (
            <p className="text-xs text-muted-foreground">
              {draft.original.rowCount.toLocaleString()} row(s) · updated{" "}
              {formatDate(draft.original.updatedAt)} · version{" "}
              {draft.original.version}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          {draft.mode === "inspect" ? (
            <Button
              variant="outline"
              disabled={!isClipboardAvailable() || pending}
              onClick={async () => {
                const result = await copyToClipboard(draft.dataJSON);
                if (result === "copied") {
                  toast.success("Collection rows copied");
                } else {
                  toast.error("Clipboard is unavailable.");
                }
              }}
            >
              <Copy /> Copy rows
            </Button>
          ) : null}
          <Button variant="outline" disabled={pending} onClick={onClose}>
            {editable ? "Cancel" : "Close"}
          </Button>
          {editable ? (
            <Button
              loading={pending}
              disabled={!draft.name.trim()}
              onClick={save}
            >
              Save collection
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ContentLibraryClient() {
  const queryClient = useQueryClient();
  const blockSearchId = useId();
  const collectionSearchId = useId();
  const [blockSearch, setBlockSearch] = useState("");
  const [blockKind, setBlockKind] = useState<"" | SavedBlockKind>("");
  const [collectionSearch, setCollectionSearch] = useState("");
  const [collectionType, setCollectionType] = useState<"" | CollectionType>("");
  const [blockDraft, setBlockDraft] = useState<BlockDraft | null>(null);
  const [collectionDraft, setCollectionDraft] =
    useState<CollectionDraft | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  // Every keystroke would otherwise mint a fresh query key with no cached
  // entry, so the result grid unmounts and a request goes out per character.
  const blockSearchTerm = useDebounced(blockSearch.trim(), SEARCH_DEBOUNCE_MS);
  const collectionSearchTerm = useDebounced(
    collectionSearch.trim(),
    SEARCH_DEBOUNCE_MS,
  );

  const meQuery = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const me = meQuery.data;
  const writable = Boolean(
    me && !me.viewer_mode && effectiveAuthRole(me) !== "viewer",
  );
  const authorityKey = me
    ? ([
        "content-library",
        me.tenant_id,
        me.user_id,
        effectiveAuthRole(me),
        Boolean(me.viewer_mode),
      ] as const)
    : (["content-library", "anonymous"] as const);

  useEffect(() => {
    setBlockDraft(null);
    setCollectionDraft(null);
  }, [
    me?.tenant_id,
    me?.user_id,
    me?.role,
    me?.effective_role,
    me?.viewer_mode,
  ]);

  const blocksQuery = useInfiniteQuery({
    queryKey: [...authorityKey, "blocks", blockSearchTerm, blockKind],
    queryFn: ({ pageParam, signal }) =>
      listSavedBlocks({
        tenantId: me!.tenant_id,
        q: blockSearchTerm,
        kind: blockKind || undefined,
        before: pageParam ?? undefined,
        limit: PAGE_SIZE,
        signal,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    enabled: Boolean(me),
    staleTime: STALE.list,
    // Keep the current results on screen while a new filter loads instead of
    // blanking the grid between keystrokes.
    placeholderData: keepPreviousData,
  });
  const collectionsQuery = useInfiniteQuery({
    queryKey: [
      ...authorityKey,
      "collections",
      collectionSearchTerm,
      collectionType,
    ],
    queryFn: ({ pageParam, signal }) =>
      listCollections({
        tenantId: me!.tenant_id,
        q: collectionSearchTerm,
        collectionType: collectionType || undefined,
        cursor: pageParam ?? undefined,
        limit: PAGE_SIZE,
        signal,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    enabled: Boolean(me),
    staleTime: STALE.list,
    placeholderData: keepPreviousData,
  });

  const blocks = useMemo(() => {
    const byId = new Map<string, SavedBlock>();
    const pages = Array.isArray(blocksQuery.data?.pages)
      ? blocksQuery.data.pages
      : [];
    for (const page of pages) {
      const items = Array.isArray(page.items) ? page.items : [];
      for (const block of items) byId.set(block.id, block);
    }
    return [...byId.values()];
  }, [blocksQuery.data]);
  const collections = useMemo(() => {
    const byId = new Map<string, Collection>();
    const pages = Array.isArray(collectionsQuery.data?.pages)
      ? collectionsQuery.data.pages
      : [];
    for (const page of pages) {
      const items = Array.isArray(page.items) ? page.items : [];
      for (const collection of items) byId.set(collection.id, collection);
    }
    return [...byId.values()];
  }, [collectionsQuery.data]);
  const blockTotal = Array.isArray(blocksQuery.data?.pages)
    ? (blocksQuery.data.pages[0]?.total ?? 0)
    : 0;
  const collectionTotal = Array.isArray(collectionsQuery.data?.pages)
    ? (collectionsQuery.data.pages[0]?.total ?? 0)
    : 0;

  async function invalidateAll() {
    await queryClient.invalidateQueries({ queryKey: authorityKey });
  }

  async function reauthorize() {
    if (!me) throw new Error("Your session is not available.");
    assertSameIdentity(me, await whoamiFresh());
  }

  function inspectBlock(block: SavedBlock, mode: BlockDraft["mode"]) {
    setBlockDraft({
      mode,
      original: block,
      name: block.name,
      kind: block.kind,
      bodyHtml: block.bodyHtml,
      bodyJSON: JSON.stringify(block.bodyJson, null, 2),
    });
  }

  async function inspectCollection(
    summary: Collection,
    mode: CollectionDraft["mode"],
  ) {
    if (!me || pending) return;
    if (!writable) {
      toast.info(
        "Editor, admin, or owner access is required to read collection rows because they may contain confidential lookup values.",
      );
      return;
    }
    setPending(`collection-open:${summary.id}`);
    try {
      const current = await getCollection({
        tenantId: me.tenant_id,
        id: summary.id,
      });
      setCollectionDraft({
        mode,
        original: current,
        name: current.name,
        collectionType: current.collectionType,
        sourceType: current.sourceType,
        dataJSON: JSON.stringify(current.data, null, 2),
      });
    } catch (cause) {
      toast.error(
        apiErrorMessage(cause, "Collection details could not be loaded."),
      );
    } finally {
      setPending(null);
    }
  }

  async function removeBlock(block: SavedBlock) {
    if (!me) return;
    await reauthorize();
    const current = await getSavedBlock({
      tenantId: me.tenant_id,
      id: block.id,
    });
    if (current.version !== block.version) {
      throw new Error(
        "This block changed. Nothing was deleted; refresh and review it again.",
      );
    }
    await deleteSavedBlock({
      tenantId: me.tenant_id,
      id: current.id,
      expectedVersion: current.version,
      idempotencyKey: mutationKey("block-delete", current.id),
    });
    await invalidateAll();
    toast.success("Saved block permanently deleted");
  }

  async function removeCollection(summary: Collection) {
    if (!me) return;
    await reauthorize();
    const current = await getCollection({
      tenantId: me.tenant_id,
      id: summary.id,
    });
    if (current.version !== summary.version) {
      throw new Error(
        "This collection changed. Nothing was deleted; refresh and review it again.",
      );
    }
    await deleteCollection({
      tenantId: me.tenant_id,
      id: current.id,
      expectedVersion: current.version,
      idempotencyKey: mutationKey("collection-delete", current.id),
    });
    await invalidateAll();
    toast.success("Collection permanently deleted");
  }

  async function copyText(text: string, success: string) {
    const result = await copyToClipboard(text);
    if (result === "copied") toast.success(success);
    else toast.error("Clipboard is unavailable.");
  }

  if (meQuery.isError) {
    return (
      <PageShell className="max-w-6xl">
        <div
          role="alert"
          className="rounded-lg border border-destructive/40 p-4"
        >
          {apiErrorMessage(
            meQuery.error,
            "Your workspace identity could not be loaded.",
          )}{" "}
          <Button variant="outline" onClick={() => meQuery.refetch()}>
            Retry
          </Button>
        </div>
      </PageShell>
    );
  }

  return (
    <PageShell className="max-w-6xl">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="font-display text-2xl font-semibold tracking-tight">
            Content library
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Create, inspect, reuse, update, and safely remove saved blocks and
            reference collections.
          </p>
        </div>
        <Button
          variant="outline"
          disabled={
            !me || blocksQuery.isFetching || collectionsQuery.isFetching
          }
          onClick={() => invalidateAll()}
        >
          <RefreshCw /> Refresh
        </Button>
      </header>

      {!writable && me ? (
        <p className="rounded-lg border bg-muted/30 p-3 text-sm text-muted-foreground">
          Read-only mode: saved blocks remain inspectable and copyable.
          Collection rows are intentionally hidden because they can contain
          confidential lookup values. Changes require editor, admin, or owner
          authority.
        </p>
      ) : null}

      <section aria-labelledby="saved-blocks-heading" className="space-y-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h2 id="saved-blocks-heading" className="text-lg font-semibold">
              Saved blocks
            </h2>
            <p className="text-sm text-muted-foreground">
              {blocksQuery.isPending
                ? "Loading…"
                : `${blocks.length.toLocaleString()} shown of ${blockTotal.toLocaleString()}.`}
            </p>
          </div>
          <Button
            disabled={!writable}
            title={
              !writable
                ? "Editor, admin, or owner access is required."
                : undefined
            }
            onClick={() =>
              setBlockDraft({
                mode: "create",
                original: null,
                name: "",
                kind: "block",
                bodyHtml: "",
                bodyJSON: "{}",
              })
            }
          >
            <Plus /> Create block
          </Button>
        </div>
        <div className="grid gap-2 rounded-lg border p-3 sm:grid-cols-[1fr_180px]">
          <div>
            <Label htmlFor={blockSearchId} className="sr-only">
              Search saved blocks
            </Label>
            <Input
              id={blockSearchId}
              type="search"
              value={blockSearch}
              maxLength={200}
              placeholder="Search saved blocks"
              onChange={(event) => setBlockSearch(event.target.value)}
            />
          </div>
          <Select
            aria-label="Filter saved-block kind"
            value={blockKind}
            onChange={(event) =>
              setBlockKind(event.target.value as "" | SavedBlockKind)
            }
          >
            <option value="">All kinds</option>
            <option value="block">Blocks</option>
            <option value="snippet">Snippets</option>
            <option value="section">Sections</option>
          </Select>
        </div>
        {blocksQuery.isError ? (
          <div
            role="alert"
            className="rounded-lg border border-destructive/40 p-4"
          >
            {apiErrorMessage(
              blocksQuery.error,
              "Saved blocks could not be loaded.",
            )}{" "}
            <Button
              size="sm"
              variant="outline"
              onClick={() => blocksQuery.refetch()}
            >
              Retry
            </Button>
          </div>
        ) : null}
        {/* `isPending`, not `isLoading`: these lists are gated on `enabled`,
            and a disabled query reports isLoading=false, so an isLoading guard
            would assert "nothing matches" for the whole identity round-trip. */}
        {!blocksQuery.isPending && !blocksQuery.isError && !blocks.length ? (
          <p className="rounded-lg border p-6 text-center text-sm text-muted-foreground">
            No saved blocks match this filter.
          </p>
        ) : null}
        {blocks.length ? (
          <ul className="grid gap-3 sm:grid-cols-2">
            {blocks.map((block) => (
              <li key={block.id} className="rounded-lg border bg-card p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate font-medium" title={block.name}>
                      {block.name}
                    </p>
                    <p className="mt-1 text-xs capitalize text-muted-foreground">
                      {block.kind} · version {block.version} · updated{" "}
                      {formatDate(block.updatedAt)}
                    </p>
                  </div>
                  <BookOpen className="size-4 shrink-0 text-muted-foreground" />
                </div>
                <div className="mt-3 flex flex-wrap gap-1">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => inspectBlock(block, "inspect")}
                  >
                    Inspect
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!isClipboardAvailable()}
                    onClick={() =>
                      copyText(
                        block.bodyHtml ||
                          JSON.stringify(block.bodyJson, null, 2),
                        "Block content copied",
                      )
                    }
                  >
                    <Copy /> Copy
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!isClipboardAvailable()}
                    onClick={() =>
                      copyText(
                        block.bodyHtml ||
                          JSON.stringify(block.bodyJson, null, 2),
                        "Block copied for the editor",
                      )
                    }
                  >
                    Use in editor
                  </Button>
                  {writable ? (
                    <>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => inspectBlock(block, "edit")}
                      >
                        <Pencil /> Edit
                      </Button>
                      <ConfirmDialog
                        trigger={
                          <Button size="sm" variant="ghost">
                            <Trash2 /> Delete
                          </Button>
                        }
                        title={`Delete “${block.name}”?`}
                        description="This permanently removes the saved block. Linked templates keep their pinned content but lose update checks. Inspect template impact before deleting. There is no self-service restore."
                        confirmationToken={block.name}
                        confirmLabel="Delete permanently"
                        onConfirm={() => removeBlock(block)}
                      />
                    </>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        ) : null}
        {blocksQuery.hasNextPage ? (
          <div className="flex justify-center">
            <Button
              variant="outline"
              loading={blocksQuery.isFetchingNextPage}
              onClick={() =>
                void loadNextQueryPage(blocksQuery, blocksQuery.isEnabled)
              }
            >
              Load more blocks
            </Button>
          </div>
        ) : null}
      </section>

      <section aria-labelledby="collections-heading" className="space-y-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h2 id="collections-heading" className="text-lg font-semibold">
              Reference collections
            </h2>
            <p className="text-sm text-muted-foreground">
              {collectionsQuery.isPending
                ? "Loading…"
                : `${collections.length.toLocaleString()} shown of ${collectionTotal.toLocaleString()}.`}
            </p>
          </div>
          <Button
            disabled={!writable}
            title={
              !writable
                ? "Editor, admin, or owner access is required."
                : undefined
            }
            onClick={() =>
              setCollectionDraft({
                mode: "create",
                original: null,
                name: "",
                collectionType: "content",
                sourceType: "manual",
                dataJSON: "[]",
              })
            }
          >
            <Plus /> Create collection
          </Button>
        </div>
        <div className="grid gap-2 rounded-lg border p-3 sm:grid-cols-[1fr_180px]">
          <div>
            <Label htmlFor={collectionSearchId} className="sr-only">
              Search collections
            </Label>
            <Input
              id={collectionSearchId}
              type="search"
              value={collectionSearch}
              maxLength={200}
              placeholder="Search collections"
              onChange={(event) => setCollectionSearch(event.target.value)}
            />
          </div>
          <Select
            aria-label="Filter collection type"
            value={collectionType}
            onChange={(event) =>
              setCollectionType(event.target.value as "" | CollectionType)
            }
          >
            <option value="">All types</option>
            <option value="coupons">Coupons</option>
            <option value="content">Content</option>
            <option value="schedule">Schedule</option>
          </Select>
        </div>
        {collectionsQuery.isError ? (
          <div
            role="alert"
            className="rounded-lg border border-destructive/40 p-4"
          >
            {apiErrorMessage(
              collectionsQuery.error,
              "Reference collections could not be loaded.",
            )}{" "}
            <Button
              size="sm"
              variant="outline"
              onClick={() => collectionsQuery.refetch()}
            >
              Retry
            </Button>
          </div>
        ) : null}
        {!collectionsQuery.isPending &&
        !collectionsQuery.isError &&
        !collections.length ? (
          <p className="rounded-lg border p-6 text-center text-sm text-muted-foreground">
            No collections match this filter.
          </p>
        ) : null}
        {collections.length ? (
          <ul className="grid gap-3 sm:grid-cols-2">
            {collections.map((collection) => (
              <li key={collection.id} className="rounded-lg border bg-card p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate font-medium" title={collection.name}>
                      {collection.name}
                    </p>
                    <p className="mt-1 text-xs capitalize text-muted-foreground">
                      {collection.collectionType} · {collection.sourceType} ·{" "}
                      {collection.rowCount.toLocaleString()} row(s) · v
                      {collection.version}
                    </p>
                  </div>
                  <FileJson className="size-4 shrink-0 text-muted-foreground" />
                </div>
                <div className="mt-3 flex flex-wrap gap-1">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={
                      !writable ||
                      pending === `collection-open:${collection.id}`
                    }
                    loading={pending === `collection-open:${collection.id}`}
                    title={
                      !writable
                        ? "Collection rows can contain confidential values and require editor, admin, or owner access."
                        : undefined
                    }
                    onClick={() => inspectCollection(collection, "inspect")}
                  >
                    Inspect rows
                  </Button>
                  {writable ? (
                    <>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={Boolean(pending)}
                        onClick={() => inspectCollection(collection, "edit")}
                      >
                        <Pencil /> Edit
                      </Button>
                      <ConfirmDialog
                        trigger={
                          <Button size="sm" variant="ghost">
                            <Trash2 /> Delete
                          </Button>
                        }
                        title={`Delete “${collection.name}”?`}
                        description="This permanently removes every row in the collection. There is no self-service restore. Its current version will be checked again first."
                        confirmationToken={collection.name}
                        confirmLabel="Delete permanently"
                        onConfirm={() => removeCollection(collection)}
                      />
                    </>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        ) : null}
        {collectionsQuery.hasNextPage ? (
          <div className="flex justify-center">
            <Button
              variant="outline"
              loading={collectionsQuery.isFetchingNextPage}
              onClick={() =>
                void loadNextQueryPage(
                  collectionsQuery,
                  collectionsQuery.isEnabled,
                )
              }
            >
              Load more collections
            </Button>
          </div>
        ) : null}
      </section>

      {me ? (
        <SavedBlockDialog
          draft={blockDraft}
          setDraft={setBlockDraft}
          me={me}
          writable={writable}
          onClose={() => setBlockDraft(null)}
          onSaved={invalidateAll}
        />
      ) : null}
      {me ? (
        <CollectionDialog
          draft={collectionDraft}
          setDraft={setCollectionDraft}
          me={me}
          writable={writable}
          onClose={() => setCollectionDraft(null)}
          onSaved={invalidateAll}
        />
      ) : null}
      <p aria-live="polite" className="sr-only">
        {pending ? "Content-library operation in progress" : ""}
      </p>
    </PageShell>
  );
}
