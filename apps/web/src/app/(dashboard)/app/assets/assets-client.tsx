// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  Copy,
  Download,
  Eye,
  Folder,
  FolderPlus,
  Pencil,
  RefreshCw,
  Tag,
  Trash2,
  Upload,
} from "lucide-react";
import dynamic from "next/dynamic";
import { toast } from "sonner";

import {
  assetFiltersActive,
  assetGridClassName,
  useAssetBrowseView,
} from "@/components/assets/asset-browse-helpers";
import { PageShell } from "@/components/dashboard/page-shell";
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
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  effectiveAuthRole,
  whoami,
  whoamiFresh,
  type MeResponse,
} from "@/lib/auth-api";
import {
  addAssetTags,
  bulkDeleteAssets,
  createAssetFolder,
  deleteAsset,
  deleteAssetFolder,
  fetchAssetBlob,
  getAsset,
  getAssetTags,
  listAssetFolders,
  listAssetTags,
  listAssets,
  moveAsset,
  publicAssetURL,
  removeAssetTag,
  renameAssetFolder,
  updateAssetAltText,
  uploadAsset,
  type Asset,
  type AssetFilter,
  type AssetFolder,
  type AssetMime,
  type AssetSort,
} from "@/lib/assets-api";
import { apiErrorMessage } from "@/lib/api";
import { copyToClipboard, isClipboardAvailable } from "@/lib/clipboard";
import { downloadBlobFile } from "@/lib/download";
import { loadNextQueryPage } from "@/lib/infinite-query-action";
import { STALE } from "@/lib/query-keys";

// The browse toolbar (Grid / List, tile size, Reset filters) is a filter-bar
// utility rather than library content; like the analytics saved-views menu it
// loads after first paint so the route's eager graph stays inside the
// dashboard bundle budget. The fallback holds the toolbar's footprint so the
// filters section does not reflow. Its state hook and helpers are eager
// imports from ./asset-browse-helpers.
const AssetBrowseControls = dynamic(
  () =>
    import("@/components/assets/asset-browse-controls").then(
      (module) => module.AssetBrowseControls,
    ),
  {
    loading: () => (
      <Skeleton
        className="h-11 w-full sm:h-8 sm:col-span-2 lg:col-span-5"
        role="status"
        aria-label="Loading view controls"
      />
    ),
  },
);
// The list layout and the bulk URL copy only render on demand (List view,
// a non-empty selection), so they load as their own chunks as well.
const AssetListView = dynamic(
  () =>
    import("@/components/assets/asset-list-view").then(
      (module) => module.AssetListView,
    ),
  {
    loading: () => (
      <p role="status" className="mt-3 text-sm text-muted-foreground">
        Loading list view…
      </p>
    ),
  },
);
const CopyAssetUrlsButton = dynamic(
  () =>
    import("@/components/assets/asset-copy-urls-button").then(
      (module) => module.CopyAssetUrlsButton,
    ),
  {
    loading: () => (
      <Button size="sm" variant="outline" disabled loading>
        Copy URLs
      </Button>
    ),
  },
);

const PAGE_SIZE = 48;
const MAX_UPLOAD_FILES = 20;
const MAX_ASSET_BYTES = 10 * 1024 * 1024;
const MAX_BULK_ASSETS = 1000;

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  run: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (next < values.length) {
        const index = next++;
        results[index] = await run(values[index]!);
      }
    }),
  );
  return results;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes.toLocaleString()} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function mutationKey(kind: string, id = "create"): string {
  const nonce =
    globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  return `web-assets:${kind}:${id}:${nonce}`;
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

async function validateImageFile(file: File): Promise<AssetMime> {
  if (
    !file.name.trim() ||
    new TextEncoder().encode(file.name).length > 128 ||
    /[\u0000-\u001f\u007f]/u.test(file.name)
  ) {
    throw new Error(
      `${file.name || "Unnamed file"}: filename must be 1–128 safe bytes.`,
    );
  }
  if (file.size < 1 || file.size > MAX_ASSET_BYTES) {
    throw new Error(
      `${file.name}: images must be non-empty and no larger than 10 MiB.`,
    );
  }
  const bytes = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const ascii = String.fromCharCode(...bytes);
  let detected: AssetMime | null = null;
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (
    bytes.length >= png.length &&
    png.every((part, index) => bytes[index] === part)
  ) {
    detected = "image/png";
  } else if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    detected = "image/jpeg";
  } else if (ascii.startsWith("GIF87a") || ascii.startsWith("GIF89a")) {
    detected = "image/gif";
  } else if (ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP") {
    detected = "image/webp";
  }
  if (!detected || file.type !== detected) {
    throw new Error(
      `${file.name}: the declared type and signature must match PNG, JPEG, GIF, or WebP.`,
    );
  }
  return detected;
}

async function fileBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () =>
      reject(new Error(`${file.name}: the browser could not read this file.`));
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const comma = result.indexOf(",");
      if (comma < 0) {
        reject(new Error(`${file.name}: the browser returned invalid data.`));
      } else {
        resolve(result.slice(comma + 1));
      }
    };
    reader.readAsDataURL(file);
  });
}

interface InspectorProps {
  assetId: string | null;
  me: MeResponse;
  folders: AssetFolder[];
  writable: boolean;
  onClose: () => void;
  onChanged: () => Promise<void>;
}

function AssetInspector({
  assetId,
  me,
  folders,
  writable,
  onClose,
  onChanged,
}: InspectorProps) {
  const [preview, setPreview] = useState<string | null>(null);
  // A failed blob fetch used to leave `preview` null forever, so the box kept
  // saying "Preview loading…" long after the only notice (a toast) had gone.
  // Hold the failure so the placeholder can state it, and bump `previewAttempt`
  // to re-run the fetch effect without reopening the dialog.
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewAttempt, setPreviewAttempt] = useState(0);
  const [alt, setAlt] = useState("");
  const [folderId, setFolderId] = useState("root");
  const [newTag, setNewTag] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const altId = useId();
  const tagId = useId();
  const folderFieldId = useId();

  const detail = useQuery({
    queryKey: ["assets", me.tenant_id, me.user_id, "detail", assetId],
    queryFn: ({ signal }) =>
      getAsset({ tenantId: me.tenant_id, id: assetId!, signal }),
    enabled: Boolean(assetId),
    staleTime: 0,
  });
  const tags = useQuery({
    queryKey: ["assets", me.tenant_id, me.user_id, "detail-tags", assetId],
    queryFn: ({ signal }) =>
      getAssetTags({ tenantId: me.tenant_id, id: assetId!, signal }),
    enabled: Boolean(assetId),
    staleTime: 0,
  });

  useEffect(() => {
    if (!detail.data) return;
    setAlt(detail.data.asset.altText);
    setFolderId(detail.data.asset.folderId ?? "root");
  }, [detail.data]);

  useEffect(() => {
    setPreview(null);
    setPreviewError(null);
    if (!detail.data) return;
    const controller = new AbortController();
    let objectUrl: string | null = null;
    void fetchAssetBlob({
      asset: detail.data.asset,
      signal: controller.signal,
    })
      .then((blob) => {
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setPreview(objectUrl);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) {
          const message = apiErrorMessage(
            cause,
            "Preview could not be loaded.",
          );
          setPreviewError(message);
          toast.error(message);
        }
      });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [detail.data, previewAttempt]);

  async function freshAsset(expectedVersion: number) {
    const freshMe = await whoamiFresh();
    assertSameIdentity(me, freshMe);
    const current = await getAsset({ tenantId: me.tenant_id, id: assetId! });
    if (current.asset.version !== expectedVersion) {
      throw new Error(
        "This asset changed after you opened it. Nothing was written; refresh its details.",
      );
    }
    return current;
  }

  async function mutate(
    success: string,
    action: (current: Asset) => Promise<unknown>,
  ) {
    if (!detail.data || pending) return;
    setPending(success);
    try {
      const current = await freshAsset(detail.data.asset.version);
      await action(current.asset);
      await onChanged();
      await Promise.all([detail.refetch(), tags.refetch()]);
      toast.success(success);
    } catch (cause) {
      toast.error(apiErrorMessage(cause, `${success} failed.`));
    } finally {
      setPending(null);
    }
  }

  const row = detail.data?.asset;
  const assetTags = Array.isArray(tags.data?.tags) ? tags.data.tags : [];
  // A failed first read leaves the tag set unknown, not empty. Saying "No tags."
  // there invites the operator to re-add tags that already exist and hides the
  // remove buttons for the real ones, so the add control is withheld until the
  // baseline is verified. A stale earlier success still counts as verified.
  const tagsUnknown = tags.isError && !tags.data;
  const availableFolders = Array.isArray(folders) ? folders : [];
  const publicURL = row ? publicAssetURL(row) : null;
  return (
    <Dialog
      open={Boolean(assetId)}
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogContent className="max-w-2xl" closeDisabled={Boolean(pending)}>
        <DialogHeader>
          <DialogTitle>{row?.filename ?? "Asset details"}</DialogTitle>
          <DialogDescription>
            Current metadata, usage, organisation, and file actions.
          </DialogDescription>
        </DialogHeader>
        {detail.isLoading ? (
          <p role="status" className="text-sm text-muted-foreground">
            Loading current asset…
          </p>
        ) : null}
        {detail.isError ? (
          <div
            role="alert"
            className="rounded-md border border-destructive/40 p-3 text-sm"
          >
            {apiErrorMessage(
              detail.error,
              "Asset details could not be loaded.",
            )}
            <Button
              className="ml-2"
              size="sm"
              variant="outline"
              onClick={() => detail.refetch()}
            >
              Retry
            </Button>
          </div>
        ) : null}
        {row ? (
          <div className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-[minmax(0,240px)_1fr]">
              <div className="flex min-h-40 items-center justify-center overflow-hidden rounded-lg border bg-muted/30">
                {preview ? (
                  // The image is a short-lived object URL from an authenticated,
                  // MIME-checked fetch and is revoked by the effect cleanup.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={preview}
                    alt={row.altText || ""}
                    className="max-h-64 max-w-full object-contain"
                  />
                ) : previewError ? (
                  <div className="space-y-2 p-3 text-center">
                    <p role="alert" className="text-sm text-muted-foreground">
                      {previewError}
                    </p>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setPreviewAttempt((n) => n + 1)}
                    >
                      Retry preview
                    </Button>
                  </div>
                ) : (
                  <span className="text-sm text-muted-foreground">
                    Preview loading…
                  </span>
                )}
              </div>
              <dl className="grid content-start grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                <dt className="text-muted-foreground">Type</dt>
                <dd>{row.mime}</dd>
                <dt className="text-muted-foreground">Size</dt>
                <dd>{formatBytes(row.bytes)}</dd>
                <dt className="text-muted-foreground">Dimensions</dt>
                <dd>
                  {row.width} × {row.height}px
                </dd>
                <dt className="text-muted-foreground">Updated</dt>
                <dd>{formatDate(row.updatedAt)}</dd>
                <dt className="text-muted-foreground">Version</dt>
                <dd>{row.version}</dd>
                <dt className="text-muted-foreground">Usage</dt>
                <dd>{detail.data?.usage?.length ?? 0} live reference(s)</dd>
              </dl>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={Boolean(pending)}
                onClick={async () => {
                  setPending("download");
                  try {
                    downloadBlobFile(
                      row.filename,
                      await fetchAssetBlob({ asset: row }),
                    );
                    toast.success("Download started");
                  } catch (cause) {
                    toast.error(apiErrorMessage(cause, "Download failed."));
                  } finally {
                    setPending(null);
                  }
                }}
              >
                <Download /> Download
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={
                  !publicURL || !isClipboardAvailable() || Boolean(pending)
                }
                title={
                  !publicURL
                    ? "This authenticated local URL cannot be shared as a public link."
                    : !isClipboardAvailable()
                      ? "Clipboard access is unavailable in this browser. Select the URL below to copy it manually."
                      : undefined
                }
                onClick={async () => {
                  if (!publicURL) return;
                  const result = await copyToClipboard(publicURL);
                  if (result === "copied") {
                    toast.success("Public asset URL copied");
                  } else {
                    toast.error("Clipboard is unavailable.");
                  }
                }}
              >
                <Copy /> Copy URL
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={
                  !publicURL || !isClipboardAvailable() || Boolean(pending)
                }
                title={
                  !publicURL
                    ? "Local authenticated assets must be downloaded and uploaded in the editor."
                    : !isClipboardAvailable()
                      ? "Clipboard access is unavailable in this browser. Select the URL below to copy it manually."
                      : undefined
                }
                onClick={async () => {
                  if (!publicURL) return;
                  const result = await copyToClipboard(publicURL);
                  if (result === "copied") {
                    toast.success("Asset URL copied for the editor");
                  } else {
                    toast.error("Clipboard is unavailable.");
                  }
                }}
              >
                Use in editor
              </Button>
            </div>

            {publicURL ? (
              // Both clipboard buttons above go dead on a browser without the
              // Clipboard API (insecure origin, locked-down enterprise build),
              // and they are the only two documented routes from an asset into
              // a campaign — so the URL itself has to stay selectable.
              <p className="break-all rounded-md bg-muted/40 px-2 py-1 font-mono text-xs select-all text-muted-foreground">
                {publicURL}
              </p>
            ) : null}

            {detail.data?.usage?.length ? (
              <div>
                <h3 className="text-sm font-medium">Live references</h3>
                <ul className="mt-2 divide-y rounded-md border text-sm">
                  {detail.data.usage.map((usage) => (
                    <li key={`${usage.kind}:${usage.id}`} className="p-2">
                      <span className="capitalize">{usage.kind}</span>:{" "}
                      {usage.name}
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                No live campaign, template, or form references were found.
              </p>
            )}

            <div className="space-y-2">
              <Label htmlFor={altId}>Alternative text</Label>
              <Textarea
                id={altId}
                value={alt}
                maxLength={1024}
                disabled={!writable || Boolean(pending)}
                onChange={(event) => setAlt(event.target.value)}
              />
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs text-muted-foreground">
                  {[...alt].length}/1,024 characters
                </span>
                <Button
                  size="sm"
                  disabled={
                    !writable || alt === row.altText || Boolean(pending)
                  }
                  loading={pending === "Alt text saved"}
                  onClick={() =>
                    mutate("Alt text saved", (current) =>
                      updateAssetAltText({
                        tenantId: me.tenant_id,
                        id: current.id,
                        expectedVersion: current.version,
                        altText: alt,
                        idempotencyKey: mutationKey("alt", current.id),
                      }),
                    )
                  }
                >
                  <Pencil /> Save alt text
                </Button>
              </div>
            </div>

            <div className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
              <div>
                <Label htmlFor={folderFieldId}>Folder</Label>
                <Select
                  id={folderFieldId}
                  value={folderId}
                  disabled={!writable || Boolean(pending)}
                  onChange={(event) => setFolderId(event.target.value)}
                >
                  <option value="root">Uncategorised</option>
                  {availableFolders.map((folder) => (
                    <option key={folder.id} value={folder.id}>
                      {folder.name}
                    </option>
                  ))}
                </Select>
              </div>
              <Button
                size="sm"
                disabled={
                  !writable ||
                  folderId === (row.folderId ?? "root") ||
                  Boolean(pending)
                }
                loading={pending === "Folder updated"}
                onClick={() =>
                  mutate("Folder updated", (current) =>
                    moveAsset({
                      tenantId: me.tenant_id,
                      id: current.id,
                      expectedVersion: current.version,
                      folderId: folderId === "root" ? null : folderId,
                      idempotencyKey: mutationKey("move", current.id),
                    }),
                  )
                }
              >
                Move
              </Button>
            </div>

            <div className="space-y-2">
              <Label htmlFor={tagId}>Tags</Label>
              <div className="flex flex-wrap gap-2">
                {assetTags.map((tag) => (
                  <span
                    key={tag}
                    className="inline-flex items-center gap-1 rounded-full border px-2 py-1 text-xs"
                  >
                    <Tag className="size-3" />
                    {tag}
                    {writable ? (
                      <button
                        type="button"
                        className="rounded px-1 hover:bg-muted focus-visible:outline-none focus-visible:ring-2"
                        disabled={Boolean(pending)}
                        aria-label={`Remove ${tag} tag`}
                        onClick={() =>
                          mutate("Tag removed", (current) =>
                            removeAssetTag({
                              tenantId: me.tenant_id,
                              id: current.id,
                              expectedVersion: current.version,
                              tag,
                              idempotencyKey: mutationKey("untag", current.id),
                            }),
                          )
                        }
                      >
                        ×
                      </button>
                    ) : null}
                  </span>
                ))}
                {tagsUnknown ? (
                  <span
                    role="alert"
                    className="flex items-center gap-2 text-sm text-muted-foreground"
                  >
                    Tags could not be read; this asset&apos;s existing tags are
                    unknown.
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void tags.refetch()}
                    >
                      Retry
                    </Button>
                  </span>
                ) : !tags.isLoading && !tags.data?.tags?.length ? (
                  <span className="text-sm text-muted-foreground">
                    No tags.
                  </span>
                ) : null}
              </div>
              {writable && !tagsUnknown ? (
                <div className="flex gap-2">
                  <Input
                    id={tagId}
                    value={newTag}
                    maxLength={64}
                    placeholder="Add a tag"
                    disabled={Boolean(pending)}
                    onChange={(event) => setNewTag(event.target.value)}
                  />
                  <Button
                    size="sm"
                    disabled={!newTag.trim() || Boolean(pending)}
                    loading={pending === "Tag added"}
                    onClick={() =>
                      mutate("Tag added", async (current) => {
                        await addAssetTags({
                          tenantId: me.tenant_id,
                          id: current.id,
                          expectedVersion: current.version,
                          tags: [newTag.trim()],
                          idempotencyKey: mutationKey("tag", current.id),
                        });
                        setNewTag("");
                      })
                    }
                  >
                    Add
                  </Button>
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
        <DialogFooter>
          <Button
            variant="outline"
            disabled={Boolean(pending)}
            onClick={onClose}
          >
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function AssetsClient() {
  const queryClient = useQueryClient();
  const uploadRef = useRef<HTMLInputElement>(null);
  const searchId = useId();
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<AssetSort>("newest");
  const [filter, setFilter] = useState<AssetFilter>("all");
  const [folderId, setFolderId] = useState("");
  const [tag, setTag] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [inspectedId, setInspectedId] = useState<string | null>(null);
  const [newFolder, setNewFolder] = useState("");
  const [editingFolder, setEditingFolder] = useState<string | null>(null);
  const [folderName, setFolderName] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const browse = useAssetBrowseView();

  const meQuery = useQuery({
    queryKey: ["whoami"],
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const me = meQuery.data;
  const writable = Boolean(
    me && !me.viewer_mode && effectiveAuthRole(me) !== "viewer",
  );
  const authorityKey = me
    ? ([
        "assets",
        me.tenant_id,
        me.user_id,
        effectiveAuthRole(me),
        Boolean(me.viewer_mode),
      ] as const)
    : (["assets", "anonymous"] as const);

  useEffect(() => {
    setSelected(new Set());
    setInspectedId(null);
  }, [
    me?.tenant_id,
    me?.user_id,
    me?.role,
    me?.effective_role,
    me?.viewer_mode,
  ]);

  useEffect(() => {
    setSelected(new Set());
  }, [query, sort, filter, folderId, tag]);

  const listing = useInfiniteQuery({
    queryKey: [
      ...authorityKey,
      "listing",
      query.trim(),
      sort,
      filter,
      folderId,
      tag,
    ],
    queryFn: ({ pageParam, signal }) =>
      listAssets({
        tenantId: me!.tenant_id,
        limit: PAGE_SIZE,
        before: pageParam ?? undefined,
        q: query,
        sort,
        filter,
        folderId: folderId ? (folderId as string | "root") : undefined,
        tag: tag || undefined,
        signal,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    enabled: Boolean(me),
    staleTime: STALE.list,
  });
  const folders = useQuery({
    queryKey: [...authorityKey, "folders"],
    queryFn: ({ signal }) =>
      listAssetFolders({ tenantId: me!.tenant_id, signal }),
    enabled: Boolean(me),
    staleTime: STALE.reference,
  });
  const tags = useQuery({
    queryKey: [...authorityKey, "tags"],
    queryFn: ({ signal }) => listAssetTags({ tenantId: me!.tenant_id, signal }),
    enabled: Boolean(me),
    staleTime: STALE.reference,
  });
  const folderRows = Array.isArray(folders.data) ? folders.data : [];
  const tagRows = Array.isArray(tags.data) ? tags.data : [];
  const assets = useMemo(() => {
    const byId = new Map<string, Asset>();
    const pages = Array.isArray(listing.data?.pages) ? listing.data.pages : [];
    for (const page of pages) {
      const items = Array.isArray(page.items) ? page.items : [];
      for (const asset of items) byId.set(asset.id, asset);
    }
    return [...byId.values()];
  }, [listing.data]);
  const counts = Array.isArray(listing.data?.pages)
    ? listing.data.pages[0]?.counts
    : undefined;
  const selectedAssets = assets.filter((asset) => selected.has(asset.id));

  // Selection is read-only state shared by the grid and list views: any role
  // may select to copy URLs; the destructive bulk verb stays writer-only.
  function toggleAssetSelection(asset: Asset, checked: boolean) {
    setSelected((value) => {
      const copy = new Set(value);
      if (checked) {
        if (copy.size >= MAX_BULK_ASSETS) {
          toast.error("Bulk actions support at most 1,000 assets at once.");
        } else {
          copy.add(asset.id);
        }
      } else copy.delete(asset.id);
      return copy;
    });
  }

  // Per-asset verbs, identical in the grid tile and the list row.
  function assetActions(asset: Asset) {
    return (
      <>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setInspectedId(asset.id)}
        >
          <Eye /> Inspect
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={Boolean(pending)}
          onClick={async () => {
            try {
              downloadBlobFile(asset.filename, await fetchAssetBlob({ asset }));
            } catch (cause) {
              toast.error(apiErrorMessage(cause, "Download failed."));
            }
          }}
        >
          <Download /> Download
        </Button>
        {writable ? (
          <ConfirmDialog
            trigger={
              <Button size="sm" variant="ghost">
                <Trash2 /> Delete
              </Button>
            }
            title={`Delete “${asset.filename}”?`}
            description={
              asset.referencesCount > 0
                ? `This asset has ${asset.referencesCount} live reference(s). Deleting it can break those drafts. There is no self-service restore.`
                : "Current usage and version will be checked again. There is no self-service restore."
            }
            confirmationToken={asset.filename}
            confirmLabel="Delete permanently"
            onConfirm={() => deleteOne(asset)}
          />
        ) : null}
      </>
    );
  }

  async function invalidateAll() {
    await queryClient.invalidateQueries({ queryKey: authorityKey });
  }

  async function reauthorize() {
    if (!me) throw new Error("Your session is not available.");
    assertSameIdentity(me, await whoamiFresh());
  }

  async function handleUploads(event: ChangeEvent<HTMLInputElement>) {
    const files = [...(event.target.files ?? [])];
    event.target.value = "";
    if (!files.length || !me || pending) return;
    if (files.length > MAX_UPLOAD_FILES) {
      toast.error(`Choose at most ${MAX_UPLOAD_FILES} images at once.`);
      return;
    }
    setPending("upload");
    try {
      await reauthorize();
      const prepared = await Promise.all(
        files.map(async (file) => ({
          file,
          mime: await validateImageFile(file),
        })),
      );
      let next = 0;
      const errors: string[] = [];
      const workers = Array.from(
        { length: Math.min(3, prepared.length) },
        async () => {
          while (next < prepared.length) {
            const item = prepared[next++];
            try {
              await uploadAsset({
                tenantId: me.tenant_id,
                filename: item.file.name,
                mime: item.mime,
                contentBase64: await fileBase64(item.file),
                idempotencyKey: mutationKey("upload", item.file.name),
              });
            } catch (cause) {
              errors.push(
                `${item.file.name}: ${apiErrorMessage(cause, "upload failed")}`,
              );
            }
          }
        },
      );
      await Promise.all(workers);
      await invalidateAll();
      const uploaded = prepared.length - errors.length;
      if (uploaded) {
        toast.success(`${uploaded} asset${uploaded === 1 ? "" : "s"} uploaded`);
      }
      if (errors.length) {
        toast.error(
          `${errors.length} upload${errors.length === 1 ? "" : "s"} failed`,
          {
            description: errors.slice(0, 3).join(" · "),
          },
        );
      }
    } catch (cause) {
      toast.error(apiErrorMessage(cause, "Upload validation failed."));
    } finally {
      setPending(null);
    }
  }

  async function deleteOne(asset: Asset) {
    if (!me) return;
    await reauthorize();
    const current = await getAsset({ tenantId: me.tenant_id, id: asset.id });
    if (current.asset.version !== asset.version) {
      throw new Error(
        "This asset changed. Nothing was deleted; refresh and review it again.",
      );
    }
    if (current.usage.length > 0 && asset.referencesCount === 0) {
      await invalidateAll();
      throw new Error(
        "This asset is now in use. Nothing was deleted; review the refreshed references and confirm again.",
      );
    }
    await deleteAsset({
      tenantId: me.tenant_id,
      id: asset.id,
      expectedVersion: current.asset.version,
      force: current.usage.length > 0,
      idempotencyKey: mutationKey("delete", asset.id),
    });
    setSelected((value) => {
      const copy = new Set(value);
      copy.delete(asset.id);
      return copy;
    });
    if (inspectedId === asset.id) setInspectedId(null);
    await invalidateAll();
    toast.success("Asset permanently removed");
  }

  async function deleteSelected() {
    if (!me || !selectedAssets.length) return;
    await reauthorize();
    const current = await mapWithConcurrency(selectedAssets, 8, (asset) =>
      getAsset({ tenantId: me.tenant_id, id: asset.id }),
    );
    for (const detail of current) {
      const listed = selectedAssets.find(
        (asset) => asset.id === detail.asset.id,
      )!;
      if (detail.asset.version !== listed.version) {
        throw new Error(
          `${listed.filename} changed. Nothing was deleted; refresh the selection.`,
        );
      }
      if (detail.usage.length > 0 && listed.referencesCount === 0) {
        await invalidateAll();
        throw new Error(
          `${listed.filename} is now in use. Nothing was deleted; review its references first.`,
        );
      }
    }
    const result = await bulkDeleteAssets({
      tenantId: me.tenant_id,
      items: current.map((detail) => ({
        id: detail.asset.id,
        expectedVersion: detail.asset.version,
      })),
      force: current.some((detail) => detail.usage.length > 0),
      idempotencyKey: mutationKey("bulk-delete"),
    });
    setSelected(new Set());
    await invalidateAll();
    if (result.failed.length) {
      toast.warning(
        `${result.deleted} removed; ${result.failed.length} could not be removed`,
        {
          description: result.failed
            .map((failure) => failure.reason)
            .join(", "),
        },
      );
    } else {
      toast.success(`${result.deleted} assets permanently removed`);
    }
  }

  async function createFolder() {
    if (!me || !newFolder.trim() || pending) return;
    setPending("folder-create");
    try {
      await reauthorize();
      await createAssetFolder({
        tenantId: me.tenant_id,
        name: newFolder,
        idempotencyKey: mutationKey("folder-create"),
      });
      setNewFolder("");
      await invalidateAll();
      toast.success("Folder created");
    } catch (cause) {
      toast.error(apiErrorMessage(cause, "Folder could not be created."));
    } finally {
      setPending(null);
    }
  }

  async function renameFolder(folder: AssetFolder) {
    if (!me || !folderName.trim() || pending) return;
    setPending(`folder-rename:${folder.id}`);
    try {
      await reauthorize();
      const current = (await listAssetFolders({ tenantId: me.tenant_id })).find(
        (row) => row.id === folder.id,
      );
      if (!current) throw new Error("This folder no longer exists.");
      if (current.version !== folder.version) {
        throw new Error(
          "This folder changed. Nothing was written; refresh and try again.",
        );
      }
      await renameAssetFolder({
        tenantId: me.tenant_id,
        id: folder.id,
        expectedVersion: current.version,
        name: folderName,
        idempotencyKey: mutationKey("folder-rename", folder.id),
      });
      setEditingFolder(null);
      await invalidateAll();
      toast.success("Folder renamed");
    } catch (cause) {
      toast.error(apiErrorMessage(cause, "Folder could not be renamed."));
    } finally {
      setPending(null);
    }
  }

  async function removeFolder(folder: AssetFolder) {
    if (!me) return;
    await reauthorize();
    const current = (await listAssetFolders({ tenantId: me.tenant_id })).find(
      (row) => row.id === folder.id,
    );
    if (!current) throw new Error("This folder no longer exists.");
    if (current.version !== folder.version) {
      throw new Error(
        "This folder changed. Nothing was deleted; refresh and try again.",
      );
    }
    await deleteAssetFolder({
      tenantId: me.tenant_id,
      id: folder.id,
      expectedVersion: current.version,
      idempotencyKey: mutationKey("folder-delete", folder.id),
    });
    if (folderId === folder.id) setFolderId("");
    await invalidateAll();
    toast.success("Folder deleted; its assets are now uncategorised");
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

  const countFilters: Array<{
    key: keyof NonNullable<typeof counts>;
    filter: AssetFilter;
    label: string;
  }> = [
    { key: "all", filter: "all", label: "All" },
    { key: "recent", filter: "recent", label: "Recent" },
    { key: "inUse", filter: "in-use", label: "In use" },
    { key: "unused", filter: "unused", label: "Unused" },
    { key: "large", filter: "large", label: "Large" },
  ];

  return (
    <PageShell className="max-w-6xl">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="font-display text-2xl font-semibold tracking-tight">
            Assets
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Upload, organise, inspect, reuse, download, and safely remove
            campaign images.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={!me || listing.isFetching}
            onClick={() => invalidateAll()}
          >
            <RefreshCw /> Refresh
          </Button>
          <Button
            disabled={!writable || pending === "upload"}
            loading={pending === "upload"}
            title={
              !writable
                ? "Editor, admin, or owner access is required."
                : undefined
            }
            onClick={() => uploadRef.current?.click()}
          >
            <Upload /> Upload images
          </Button>
          {/* `sr-only` hides this visually but keeps it focusable and in the
              accessibility tree, so a keyboard user tabbed onto an invisible
              control that announced no name. The visible button above is the
              real affordance: take this out of the tab order and give it a name
              for the case where assistive tech reaches it anyway. */}
          <input
            ref={uploadRef}
            className="sr-only"
            type="file"
            multiple
            tabIndex={-1}
            aria-label="Choose image files to upload"
            accept="image/png,image/jpeg,image/gif,image/webp"
            onChange={handleUploads}
          />
        </div>
      </header>

      {!writable && me ? (
        <p className="rounded-lg border bg-muted/30 p-3 text-sm text-muted-foreground">
          Read-only mode: browsing, inspection, copy, and download remain
          available. Changes require editor, admin, or owner authority.
        </p>
      ) : null}

      {counts ? (
        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-5">
          {countFilters.map((item) => (
            <button
              type="button"
              key={item.key}
              className={`rounded-lg border p-3 text-left transition-colors hover:bg-muted/40 ${
                filter === item.filter ? "border-primary" : ""
              }`}
              onClick={() => setFilter(item.filter)}
            >
              <dt className="text-xs text-muted-foreground">{item.label}</dt>
              <dd className="text-xl tabular-nums">
                {counts[item.key].toLocaleString()}
              </dd>
            </button>
          ))}
        </dl>
      ) : null}

      <section
        aria-label="Asset filters"
        className="grid gap-2 rounded-lg border p-3 sm:grid-cols-2 lg:grid-cols-5"
      >
        <div className="lg:col-span-2">
          <Label htmlFor={searchId} className="sr-only">
            Search assets
          </Label>
          <Input
            id={searchId}
            type="search"
            value={query}
            maxLength={200}
            placeholder="Search filenames"
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <Select
          aria-label="Sort assets"
          value={sort}
          onChange={(event) => setSort(event.target.value as AssetSort)}
        >
          <option value="newest">Newest</option>
          <option value="oldest">Oldest</option>
          <option value="largest">Largest</option>
          <option value="name">Name</option>
          <option value="most-used">Most used</option>
        </Select>
        <Select
          aria-label="Filter by folder"
          value={folderId}
          onChange={(event) => setFolderId(event.target.value)}
        >
          <option value="">All folders</option>
          <option value="root">Uncategorised</option>
          {folderRows.map((folder) => (
            <option key={folder.id} value={folder.id}>
              {folder.name} ({folder.assetCount})
            </option>
          ))}
        </Select>
        <Select
          aria-label="Filter by tag"
          value={tag}
          onChange={(event) => setTag(event.target.value)}
        >
          <option value="">All tags</option>
          {tagRows.map((row) => (
            <option key={row.tag} value={row.tag}>
              {row.tag} ({row.count})
            </option>
          ))}
        </Select>
        <AssetBrowseControls
          className="sm:col-span-2 lg:col-span-5"
          view={browse.view}
          density={browse.density}
          onViewChange={browse.setView}
          onDensityChange={browse.setDensity}
          filtersActive={assetFiltersActive({
            query,
            sort,
            filter,
            folderId,
            tag,
          })}
          onResetFilters={() => {
            setQuery("");
            setSort("newest");
            setFilter("all");
            setFolderId("");
            setTag("");
          }}
        />
      </section>

      {folders.isError || tags.isError ? (
        <div
          role="alert"
          className="rounded-lg border border-destructive/40 p-3 text-sm"
        >
          Folder or tag filters could not be loaded. Asset results remain
          available, but those filters may be incomplete.{" "}
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              if (folders.isError) void folders.refetch();
              if (tags.isError) void tags.refetch();
            }}
          >
            Retry filters
          </Button>
        </div>
      ) : null}

      {writable ? (
        <section
          aria-labelledby="folder-heading"
          className="rounded-lg border p-4"
        >
          <h2 id="folder-heading" className="font-medium">
            Folders
          </h2>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <Input
              value={newFolder}
              maxLength={128}
              placeholder="New folder name"
              aria-label="New folder name"
              disabled={Boolean(pending)}
              onChange={(event) => setNewFolder(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void createFolder();
                }
              }}
            />
            <Button
              disabled={!newFolder.trim() || Boolean(pending)}
              loading={pending === "folder-create"}
              onClick={createFolder}
            >
              <FolderPlus /> Create folder
            </Button>
          </div>
          <ul className="mt-3 grid gap-2 sm:grid-cols-2">
            {folderRows.map((folder) => (
              <li key={folder.id} className="rounded-md border p-2">
                {editingFolder === folder.id ? (
                  <div className="flex gap-2">
                    <Input
                      autoFocus
                      value={folderName}
                      maxLength={128}
                      aria-label={`Rename ${folder.name}`}
                      disabled={Boolean(pending)}
                      onChange={(event) => setFolderName(event.target.value)}
                    />
                    <Button
                      size="sm"
                      disabled={!folderName.trim() || Boolean(pending)}
                      onClick={() => renameFolder(folder)}
                    >
                      Save
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={Boolean(pending)}
                      onClick={() => setEditingFolder(null)}
                    >
                      Cancel
                    </Button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <Folder className="size-4" />
                    <span className="min-w-0 flex-1 truncate text-sm">
                      {folder.name}{" "}
                      <span className="text-muted-foreground">
                        ({folder.assetCount})
                      </span>
                    </span>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={`Rename ${folder.name}`}
                      onClick={() => {
                        setEditingFolder(folder.id);
                        setFolderName(folder.name);
                      }}
                    >
                      <Pencil />
                    </Button>
                    <ConfirmDialog
                      trigger={
                        <Button
                          size="icon"
                          variant="ghost"
                          aria-label={`Delete ${folder.name}`}
                        >
                          <Trash2 />
                        </Button>
                      }
                      title={`Delete “${folder.name}”?`}
                      description={`${folder.assetCount} asset(s) will become uncategorised. The files themselves are not deleted.`}
                      confirmLabel="Delete folder"
                      onConfirm={() => removeFolder(folder)}
                    />
                  </div>
                )}
              </li>
            ))}
          </ul>
          {!folders.isLoading && !folders.isError && !folderRows.length ? (
            <p className="mt-2 text-sm text-muted-foreground">
              No folders yet.
            </p>
          ) : null}
        </section>
      ) : null}

      {selectedAssets.length ? (
        <div className="sticky top-2 z-10 flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-background/95 p-3 shadow-sm backdrop-blur">
          <span className="text-sm font-medium">
            {selectedAssets.length} selected
          </span>
          <div className="flex gap-2">
            <CopyAssetUrlsButton assets={selectedAssets} />
            <Button
              size="sm"
              variant="outline"
              onClick={() => setSelected(new Set())}
            >
              Clear
            </Button>
            {writable ? (
              <ConfirmDialog
                trigger={
                  <Button size="sm" variant="destructive">
                    <Trash2 /> Delete selected
                  </Button>
                }
                title={`Permanently delete ${selectedAssets.length} assets?`}
                description={
                  selectedAssets.some((asset) => asset.referencesCount > 0)
                    ? "At least one selected asset has live references. Those drafts may show broken images. Deleted assets have no self-service restore."
                    : "Deleted assets have no self-service restore. Current versions and references will be checked again before deletion."
                }
                confirmationToken="DELETE"
                confirmLabel="Delete permanently"
                onConfirm={deleteSelected}
              />
            ) : null}
          </div>
        </div>
      ) : null}

      <section aria-labelledby="asset-list-heading">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 id="asset-list-heading" className="font-medium">
              Files
            </h2>
            <p className="text-sm text-muted-foreground">
              {listing.isLoading
                ? "Loading…"
                : listing.isError
                  ? "Files unavailable."
                  : `${assets.length.toLocaleString()} shown${
                      counts ? ` of ${counts.all.toLocaleString()}` : ""
                    }.`}
            </p>
          </div>
          {assets.length ? (
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={
                  selectedAssets.length ===
                    Math.min(assets.length, MAX_BULK_ASSETS) &&
                  assets.length > 0
                }
                indeterminate={
                  selectedAssets.length > 0 &&
                  selectedAssets.length <
                    Math.min(assets.length, MAX_BULK_ASSETS)
                }
                onChange={(event) =>
                  setSelected(
                    event.target.checked
                      ? new Set(
                          assets
                            .slice(0, MAX_BULK_ASSETS)
                            .map((asset) => asset.id),
                        )
                      : new Set(),
                  )
                }
              />
              Select shown
              {assets.length > MAX_BULK_ASSETS ? " (first 1,000)" : ""}
            </label>
          ) : null}
        </div>
        {listing.isError ? (
          <div
            role="alert"
            className="mt-3 rounded-lg border border-destructive/40 p-4"
          >
            {apiErrorMessage(
              listing.error,
              "The asset library could not be loaded.",
            )}{" "}
            <Button
              size="sm"
              variant="outline"
              onClick={() => listing.refetch()}
            >
              Retry
            </Button>
          </div>
        ) : null}
        {!listing.isLoading && !listing.isError && !assets.length ? (
          <p className="mt-3 rounded-lg border p-6 text-center text-sm text-muted-foreground">
            No assets match these filters.
          </p>
        ) : null}
        {assets.length && browse.view === "list" ? (
          <AssetListView
            assets={assets}
            selected={selected}
            selectable
            onToggle={toggleAssetSelection}
            renderActions={assetActions}
          />
        ) : assets.length ? (
          <ul className={`mt-3 ${assetGridClassName(browse.density)}`}>
            {assets.map((asset) => (
              <li
                key={asset.id}
                className="flex min-w-0 flex-col rounded-lg border bg-card p-3"
              >
                <div className="flex items-start gap-3">
                  <Checkbox
                    aria-label={`Select ${asset.filename}`}
                    checked={selected.has(asset.id)}
                    onChange={(event) =>
                      toggleAssetSelection(asset, event.target.checked)
                    }
                  />
                  <div className="min-w-0 flex-1">
                    <p
                      className="truncate text-sm font-medium"
                      title={asset.filename}
                    >
                      {asset.filename}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {asset.width} × {asset.height}px ·{" "}
                      {formatBytes(asset.bytes)}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {asset.referencesCount} live reference
                      {asset.referencesCount === 1 ? "" : "s"} · v
                      {asset.version}
                    </p>
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap gap-1">
                  {assetActions(asset)}
                </div>
              </li>
            ))}
          </ul>
        ) : null}
        {listing.hasNextPage ? (
          <div className="mt-4 flex justify-center">
            <Button
              variant="outline"
              loading={listing.isFetchingNextPage}
              onClick={() => void loadNextQueryPage(listing, listing.isEnabled)}
            >
              Load more
            </Button>
          </div>
        ) : null}
      </section>

      {me ? (
        <AssetInspector
          assetId={inspectedId}
          me={me}
          folders={folderRows}
          writable={writable}
          onClose={() => setInspectedId(null)}
          onChanged={invalidateAll}
        />
      ) : null}
      <p aria-live="polite" className="sr-only">
        {pending ? `Asset operation in progress: ${pending}` : ""}
      </p>
    </PageShell>
  );
}
