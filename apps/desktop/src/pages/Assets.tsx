/**
 * Assets — refined image Library (PR 1 of the refined-library spec).
 *
 * Page shell. Owns:
 *   • the visible asset list + counts (fetched from /api/v1/assets)
 *   • search / sort / filter / viewMode / density (persisted per-workspace)
 *   • selection model (delegates rules to lib/library-selection)
 *   • upload tray (in-flight + failed)
 *   • Quick Look modal lifecycle
 *   • delete-with-references confirmation flow
 *
 * Everything else lives as a focused sub-component under
 * components/library/. The page wires them.
 *
 * See docs/superpowers/specs/2026-05-25-refined-library-design.md.
 */

import {
  type Dispatch,
  type ReactElement,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { PageHeader } from "../components/PageHeader";
import { Skeleton } from "../components/Skeleton";
import { StatStrip, type StatCell } from "../components/StatStrip";
import { LibraryDropZone } from "../components/library/LibraryDropZone";
import {
  DeleteAssetConfirmModal,
  LibraryEmptyState,
  LibraryFolderFilters,
  LibraryTagFilters,
} from "../components/library/LibraryAssetStates";
import { LibraryGrid, type Density } from "../components/library/LibraryGrid";
import { LibraryList } from "../components/library/LibraryList";
import { LibraryQuickLook } from "../components/library/LibraryQuickLook";
import { LibrarySelectionBar } from "../components/library/LibrarySelectionBar";
import { LibrarySmartFilters } from "../components/library/LibrarySmartFilters";
import {
  LibraryToolbar,
  type ViewMode,
} from "../components/library/LibraryToolbar";
import {
  LibraryUploadTray,
  type UploadEntry,
} from "../components/library/LibraryUploadTray";
import { ConfirmModal } from "../components/ConfirmModal";
import { Modal, ModalFooter } from "../components/Modal";
import { toast } from "../components/Toast";
import {
  type Asset,
  type AssetCounts,
  type AssetFilter,
  type AssetFolder,
  type AssetReferrer,
  type AssetSort,
  type AssetTagCount,
  apiSendTimeAssets as api,
} from "../lib/api-client";
import { writeClipboardText } from "../lib/clipboard";
import { desktopRouteIdentityScope } from "../lib/desktop-router";
import {
  acceptDroppedFiles,
  beginUploadTransfer,
  pickImportFiles,
} from "../lib/file-transfer";
import type { ImportPolicy } from "../lib/file-transfer-types";
import {
  createLocalAssetPreviewUrl,
  revokeLocalAssetPreviewUrl,
} from "../lib/asset-display";
import { fileToBase64, fmtBytes, sortAssets } from "../lib/library-filters";
import {
  type SelectionEvent,
  type SelectionState,
  applySelection,
  visibleIds,
} from "../lib/library-selection";
import { registerLifecycleGuard } from "../lib/lifecycle-coordinator";
import {
  ASSET_IMAGE_EXTENSIONS,
  ASSET_PAGE_LIMIT,
  ASSET_UPLOAD_CONCURRENCY,
  ASSET_UPLOAD_MAX_BYTES,
  ASSET_UPLOAD_MAX_FILES,
  decodeAsset,
  decodeAssetDetail,
  decodeAssetFolders,
  decodeAssetList,
  decodeAssetReferenceConflict,
  decodeAssetTagCounts,
  decodeMutationAck,
  decodeMutationReceipt,
  isSupportedAssetFile,
  publicAssetDeliveryUrl,
} from "../lib/asset-runtime";
import { useCanWrite, useMe } from "../lib/store";
import "../styles-assets.css";

const MAX_BYTES = ASSET_UPLOAD_MAX_BYTES;
const SEARCH_DEBOUNCE_MS = 200;
const UPLOAD_DONE_DISMISS_MS = 3500;
const ASSET_IMPORT_POLICY: ImportPolicy = {
  label: "asset images",
  privacy: "personal",
  extensions: [...ASSET_IMAGE_EXTENSIONS],
  maxBytes: MAX_BYTES,
  maxFiles: ASSET_UPLOAD_MAX_FILES,
  maxTotalBytes: MAX_BYTES * ASSET_UPLOAD_MAX_FILES,
};
// D08-forms-assets-archive#10: server page size for the library + load-more.
const PAGE_LIMIT = ASSET_PAGE_LIMIT;

/* ---------- helpers --------------------------------------------------- */

function assetPreferenceKey(
  identityScope: string | null,
  name: string,
): string | null {
  return identityScope ? `pw.library.v2.${identityScope}.${name}` : null;
}

function purgeLegacyAssetPreference(
  workspace: string | null,
  name: string,
): void {
  try {
    window.localStorage.removeItem(
      `pw.library.${workspace ?? "default"}.${name}`,
    );
  } catch {
    // Legacy cleanup is best-effort in hardened webviews.
  }
}

function readPref<T extends string>(
  key: string | null,
  legacyWorkspace: string | null,
  name: string,
  allowed: readonly T[],
  fallback: T,
): T {
  purgeLegacyAssetPreference(legacyWorkspace, name);
  if (!key) return fallback;
  try {
    const v = window.localStorage.getItem(key);
    if (v && (allowed as readonly string[]).includes(v)) return v as T;
  } catch {
    /* ignore */
  }
  return fallback;
}

function writePref(key: string | null, value: string): void {
  if (!key) return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

interface AssetCatalogOptions {
  workspaceKey: string | null;
  query: string;
  sort: AssetSort;
  filter: AssetFilter;
  activeTag: string;
  activeFolder: string;
  setActiveFolder: Dispatch<SetStateAction<string>>;
  density: Density;
  viewMode: ViewMode;
  quickLookId: string | null;
}

function useAssetCatalog({
  workspaceKey,
  query,
  sort,
  filter,
  activeTag,
  activeFolder,
  setActiveFolder,
  density,
  viewMode,
  quickLookId,
}: AssetCatalogOptions) {
  const [rows, setRows] = useState<Asset[] | null>(null);
  const [counts, setCounts] = useState<AssetCounts | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const loadRequestRef = useRef(0);
  const [hasMore, setHasMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const loadMoreRequestRef = useRef<Promise<void> | null>(null);
  const gridWrapRef = useRef<HTMLDivElement>(null);
  const [gridCols, setGridCols] = useState(4);
  const [tagCounts, setTagCounts] = useState<AssetTagCount[]>([]);
  const [folders, setFolders] = useState<AssetFolder[]>([]);
  const [foldersLoaded, setFoldersLoaded] = useState(false);
  const [folderLoadError, setFolderLoadError] = useState<string | null>(null);
  const [tagLoadError, setTagLoadError] = useState<string | null>(null);
  const [quickLookUsage, setQuickLookUsage] = useState<AssetReferrer[]>([]);
  const [quickLookUsageState, setQuickLookUsageState] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");
  const [quickLookUsageError, setQuickLookUsageError] = useState<string | null>(
    null,
  );
  const tagRequestRef = useRef(0);
  const folderRequestRef = useRef(0);
  const catalogQueryKey = [
    workspaceKey ?? "",
    query.trim(),
    sort,
    filter,
    activeTag,
    activeFolder,
  ].join("\u0000");
  const catalogQueryKeyRef = useRef(catalogQueryKey);
  catalogQueryKeyRef.current = catalogQueryKey;

  const load = useCallback(
    async (opts: {
      q: string;
      sort: AssetSort;
      filter: AssetFilter;
      tag: string;
      folder: string;
    }) => {
      const requestId = loadRequestRef.current + 1;
      loadRequestRef.current = requestId;
      setLoading(true);
      setError(null);
      try {
        const res = await api.listAssets({
          limit: PAGE_LIMIT,
          q: opts.q,
          sort: opts.sort,
          filter: opts.filter,
          tag: opts.tag || undefined,
          folder_id: opts.folder || undefined,
        });
        if (loadRequestRef.current !== requestId) return;
        if (res.error) {
          setError(res.error.message);
          return;
        }
        const decoded = decodeAssetList(res.data, {
          requireCounts: true,
          requireCursor: true,
        });
        if (!decoded.ok) {
          setError(
            `The server returned an invalid asset list (${decoded.error}).`,
          );
          return;
        }
        setRows(decoded.value.items);
        setCounts(decoded.value.counts);
        setNextCursor(decoded.value.nextCursor ?? null);
        setHasMore(typeof decoded.value.nextCursor === "string");
      } catch (loadError) {
        if (loadRequestRef.current === requestId) {
          setError(
            loadError instanceof Error && loadError.message.trim()
              ? loadError.message
              : "The asset list request failed.",
          );
        }
      } finally {
        if (loadRequestRef.current === requestId) setLoading(false);
      }
    },
    [],
  );

  const loadMore = useCallback(async (): Promise<void> => {
    const currentRows = rows ?? [];
    if (currentRows.length === 0 || !nextCursor || loadMoreRequestRef.current)
      return;
    const cursorId = nextCursor;
    const requestQueryKey = catalogQueryKeyRef.current;
    const request = (async (): Promise<void> => {
      setLoadingMore(true);
      try {
        const res = await api.listAssets({
          limit: PAGE_LIMIT,
          before: cursorId,
          q: query.trim(),
          sort,
          filter,
          tag: activeTag || undefined,
          folder_id: activeFolder || undefined,
        });
        if (catalogQueryKeyRef.current !== requestQueryKey) return;
        if (res.error) {
          toast.error({
            message: "Couldn't load more images",
            detail: res.error.message,
          });
          return;
        }
        const decoded = decodeAssetList(res.data, { requireCursor: true });
        if (!decoded.ok) {
          toast.error({
            message: "Couldn't verify the next image page",
            detail: decoded.error,
          });
          return;
        }
        if (decoded.value.nextCursor === cursorId) {
          setNextCursor(null);
          setHasMore(false);
          toast.error({
            message: "Pagination stopped safely",
            detail:
              "The server repeated the same page cursor. Refresh the Library before trying again.",
          });
          return;
        }
        const items = decoded.value.items;
        setRows((previous) => {
          const base = previous ?? [];
          const seen = new Set(base.map((asset) => asset.id));
          return [...base, ...items.filter((asset) => !seen.has(asset.id))];
        });
        if (decoded.value.counts) setCounts(decoded.value.counts);
        setNextCursor(decoded.value.nextCursor ?? null);
        setHasMore(typeof decoded.value.nextCursor === "string");
      } catch (loadError) {
        if (catalogQueryKeyRef.current === requestQueryKey) {
          toast.error({
            message: "Couldn't load more images",
            detail:
              loadError instanceof Error && loadError.message.trim()
                ? loadError.message
                : "The next asset page request failed.",
          });
        }
      } finally {
        setLoadingMore(false);
      }
    })();
    loadMoreRequestRef.current = request;
    try {
      await request;
    } finally {
      if (loadMoreRequestRef.current === request) {
        loadMoreRequestRef.current = null;
      }
    }
  }, [rows, nextCursor, query, sort, filter, activeTag, activeFolder]);

  useEffect(() => {
    const handle = window.setTimeout(() => {
      void load({
        q: query.trim(),
        sort,
        filter,
        tag: activeTag,
        folder: activeFolder,
      });
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [query, sort, filter, activeTag, activeFolder, load]);

  useEffect(() => {
    const wrap = gridWrapRef.current;
    if (!wrap) return;
    const measure = (): void => {
      const grid = wrap.querySelector<HTMLElement>(".lib-grid");
      if (!grid) return;
      const tracks = getComputedStyle(grid).gridTemplateColumns.trim();
      if (!tracks || tracks === "none") return;
      const count = tracks.split(/\s+/).filter(Boolean).length;
      if (count > 0) setGridCols(count);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(wrap);
    return () => observer.disconnect();
  }, [density, viewMode, rows]);

  const reloadTags = useCallback(async (): Promise<void> => {
    const requestId = ++tagRequestRef.current;
    try {
      const res = await api.listAssetTags();
      if (requestId !== tagRequestRef.current) return;
      if (res.error) {
        setTagLoadError(res.error.message);
        return;
      }
      const decoded = decodeAssetTagCounts(res.data);
      if (!decoded.ok) {
        setTagLoadError(`Invalid tag catalog (${decoded.error}).`);
        return;
      }
      setTagLoadError(null);
      setTagCounts(decoded.value);
    } catch (tagError) {
      if (requestId !== tagRequestRef.current) return;
      setTagLoadError(
        tagError instanceof Error && tagError.message.trim()
          ? tagError.message
          : "The tag catalog request failed.",
      );
    }
  }, []);
  const reloadFolders = useCallback(async (): Promise<void> => {
    const requestId = ++folderRequestRef.current;
    try {
      const res = await api.listAssetFolders();
      if (requestId !== folderRequestRef.current) return;
      if (res.error) {
        setFolderLoadError(res.error.message);
        return;
      }
      const decoded = decodeAssetFolders(res.data);
      if (!decoded.ok) {
        setFolderLoadError(`Invalid folder catalog (${decoded.error}).`);
        return;
      }
      setFolderLoadError(null);
      setFolders(decoded.value);
      setFoldersLoaded(true);
    } catch (folderError) {
      if (requestId !== folderRequestRef.current) return;
      setFolderLoadError(
        folderError instanceof Error && folderError.message.trim()
          ? folderError.message
          : "The folder catalog request failed.",
      );
    }
  }, []);
  useEffect(() => {
    void reloadTags();
    void reloadFolders();
    return () => {
      tagRequestRef.current += 1;
      folderRequestRef.current += 1;
    };
  }, [workspaceKey, reloadTags, reloadFolders]);
  useEffect(() => {
    if (
      foldersLoaded &&
      activeFolder !== "" &&
      activeFolder !== "root" &&
      !folders.some((folder) => folder.id === activeFolder)
    ) {
      setActiveFolder("");
    }
  }, [folders, foldersLoaded, activeFolder, setActiveFolder]);

  useEffect(() => {
    if (!quickLookId) {
      setQuickLookUsage([]);
      setQuickLookUsageState("idle");
      setQuickLookUsageError(null);
      return;
    }
    let cancelled = false;
    setQuickLookUsage([]);
    setQuickLookUsageState("loading");
    setQuickLookUsageError(null);
    void (async () => {
      try {
        const res = await api.getAsset(quickLookId);
        if (cancelled) return;
        if (res.error) {
          setQuickLookUsageState("error");
          setQuickLookUsageError(res.error.message);
          return;
        }
        const decoded = decodeAssetDetail(res.data);
        if (!decoded.ok) {
          setQuickLookUsageState("error");
          setQuickLookUsageError(`Invalid asset detail (${decoded.error}).`);
          return;
        }
        setQuickLookUsage(decoded.value.usage);
        setQuickLookUsageState("ready");
        const fresh = decoded.value.asset;
        setRows((previous) =>
          previous
            ? previous.map((asset) => (asset.id === fresh.id ? fresh : asset))
            : previous,
        );
      } catch (detailError) {
        if (!cancelled) {
          setQuickLookUsageState("error");
          setQuickLookUsageError(
            detailError instanceof Error && detailError.message.trim()
              ? detailError.message
              : "The asset detail request failed.",
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [quickLookId]);

  return {
    counts,
    error,
    folderLoadError,
    folders,
    gridCols,
    gridWrapRef,
    hasMore,
    load,
    loadMore,
    loading,
    loadingMore,
    quickLookUsage,
    quickLookUsageError,
    quickLookUsageState,
    reloadFolders,
    reloadTags,
    rows,
    setFolders,
    setRows,
    tagCounts,
    tagLoadError,
  };
}

function useAssetUploads({
  canMutate,
  refreshAssets,
}: {
  canMutate: boolean;
  refreshAssets: () => void;
}) {
  const [uploads, setUploads] = useState<UploadEntry[]>([]);
  const activeTransfersRef = useRef(0);
  const transferWaitersRef = useRef<Array<() => void>>([]);
  const objectUrlsRef = useRef(new Map<string, string>());

  const acquireUploadSlot = useCallback(async (): Promise<() => void> => {
    if (activeTransfersRef.current >= ASSET_UPLOAD_CONCURRENCY) {
      await new Promise<void>((resolve) =>
        transferWaitersRef.current.push(resolve),
      );
    }
    activeTransfersRef.current += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      activeTransfersRef.current = Math.max(0, activeTransfersRef.current - 1);
      transferWaitersRef.current.shift()?.();
    };
  }, []);

  const releaseObjectUrl = useCallback((id: string): void => {
    const url = objectUrlsRef.current.get(id);
    if (!url) return;
    revokeLocalAssetPreviewUrl(url);
    objectUrlsRef.current.delete(id);
  }, []);

  useEffect(
    () => () => {
      for (const url of objectUrlsRef.current.values())
        revokeLocalAssetPreviewUrl(url);
      objectUrlsRef.current.clear();
    },
    [],
  );

  const startUpload = useCallback(
    async (file: File): Promise<void> => {
      if (!isSupportedAssetFile(file) || file.size > MAX_BYTES) {
        toast.error("Use a PNG, JPEG, GIF, or WebP file up to 10 MiB.");
        return;
      }
      const transfer = beginUploadTransfer(file, {
        label: "Asset upload",
        privacy: "personal",
        retry: () => startUpload(file),
      });
      const id = `${file.name}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const thumbDataUrl = createLocalAssetPreviewUrl(file) ?? undefined;
      if (thumbDataUrl) objectUrlsRef.current.set(id, thumbDataUrl);
      setUploads((previous) => [
        ...previous,
        {
          id,
          filename: file.name,
          bytes: file.size,
          status: "queued",
          progress: 0,
          thumbDataUrl,
          file,
        },
      ]);
      const release = await acquireUploadSlot();
      setUploads((previous) =>
        previous.map((upload) =>
          upload.id === id
            ? { ...upload, status: "uploading", progress: 0.1 }
            : upload,
        ),
      );
      try {
        const contentBase64 = await fileToBase64(file);
        transfer.progress(Math.round(file.size * 0.5));
        setUploads((previous) =>
          previous.map((upload) =>
            upload.id === id ? { ...upload, progress: 0.5 } : upload,
          ),
        );
        const response = await api.uploadAsset({
          filename: file.name,
          mime: file.type || "application/octet-stream",
          content_base64: contentBase64,
        });
        if (response.error) {
          transfer.fail("asset_upload_failed");
          setUploads((previous) =>
            previous.map((upload) =>
              upload.id === id
                ? {
                    ...upload,
                    status: "failed",
                    progress: 0,
                    errorMessage: response.error?.message ?? "Upload failed",
                  }
                : upload,
            ),
          );
          return;
        }
        const decoded = decodeAsset(response.data);
        if (!decoded.ok) {
          transfer.fail("asset_upload_invalid_response");
          setUploads((previous) =>
            previous.map((upload) =>
              upload.id === id
                ? {
                    ...upload,
                    status: "failed",
                    progress: 0,
                    errorMessage: `Upload response was invalid: ${decoded.error}`,
                  }
                : upload,
            ),
          );
          return;
        }
        setUploads((previous) =>
          previous.map((upload) =>
            upload.id === id
              ? { ...upload, status: "done", progress: 1 }
              : upload,
          ),
        );
        transfer.complete();
        refreshAssets();
        window.setTimeout(() => {
          releaseObjectUrl(id);
          setUploads((previous) =>
            previous.filter((upload) => upload.id !== id),
          );
        }, UPLOAD_DONE_DISMISS_MS);
      } catch (error) {
        transfer.fail("asset_encoding_failed");
        setUploads((previous) =>
          previous.map((upload) =>
            upload.id === id
              ? {
                  ...upload,
                  status: "failed",
                  progress: 0,
                  errorMessage:
                    error instanceof Error ? error.message : "Encoding failed",
                }
              : upload,
          ),
        );
      } finally {
        release();
      }
    },
    [acquireUploadSlot, refreshAssets, releaseObjectUrl],
  );

  const handleFiles = useCallback(
    (files: File[], alreadyValidated = false): void => {
      if (!canMutate) {
        toast.error("Viewer role can't upload assets.");
        return;
      }
      const checked = alreadyValidated
        ? { ok: true as const, files, source: "native" as const }
        : acceptDroppedFiles(files, ASSET_IMPORT_POLICY);
      if (!checked.ok) {
        toast.error(checked.message);
        return;
      }
      const supported = checked.files.filter(isSupportedAssetFile);
      if (supported.length !== checked.files.length) {
        toast.error("Only PNG, JPEG, GIF, and WebP images are supported.");
        return;
      }
      const outstanding = uploads.filter(
        (upload) => upload.status === "queued" || upload.status === "uploading",
      ).length;
      if (outstanding + supported.length > ASSET_UPLOAD_MAX_FILES) {
        toast.error(
          `Up to ${ASSET_UPLOAD_MAX_FILES} uploads can be queued at once.`,
        );
        return;
      }
      for (const file of supported) void startUpload(file);
    },
    [canMutate, startUpload, uploads],
  );

  const recoverFailedUploads = useCallback((): void => {
    const failed = uploads.filter((upload) => upload.status === "failed");
    const files = failed
      .filter((upload) => upload.file)
      .map((upload) => upload.file!);
    for (const upload of failed) releaseObjectUrl(upload.id);
    setUploads((current) =>
      current.filter((upload) => upload.status !== "failed"),
    );
    for (const file of files) void startUpload(file);
  }, [releaseObjectUrl, startUpload, uploads]);

  useEffect(() => {
    const activeCount = uploads.filter(
      (upload) => upload.status === "uploading" || upload.status === "queued",
    ).length;
    const failedCount = uploads.filter(
      (upload) => upload.status === "failed",
    ).length;
    if (activeCount === 0 && failedCount === 0) return;
    return registerLifecycleGuard({
      id: "asset-uploads",
      label: "Asset uploads",
      inspect: (intent) =>
        intent.disposition === "hide"
          ? null
          : activeCount > 0
            ? {
                level: "blocking",
                detail: `${activeCount} asset upload${activeCount === 1 ? " is" : "s are"} still in progress. Wait for completion before leaving.`,
                canDiscard: false,
                canRecover: false,
              }
            : {
                level: "warning",
                detail: `${failedCount} failed asset upload${failedCount === 1 ? "" : "s"} can be retried while the file reference remains available.`,
              },
      recover: recoverFailedUploads,
      discard: () => {
        for (const upload of uploads) {
          if (upload.status === "failed") releaseObjectUrl(upload.id);
        }
        setUploads((current) =>
          current.filter((upload) => upload.status !== "failed"),
        );
      },
    });
  }, [recoverFailedUploads, releaseObjectUrl, uploads]);

  const onUploadButtonClick = useCallback((): void => {
    void pickImportFiles(ASSET_IMPORT_POLICY)
      .then((result) => {
        if (!result.ok) toast.error(result.message);
        else if (result.files.length > 0) handleFiles(result.files, true);
      })
      .catch((error: unknown) => {
        toast.error({
          message: "Couldn't open the image picker",
          detail:
            error instanceof Error && error.message.trim()
              ? error.message
              : "The native file picker failed.",
        });
      });
  }, [handleFiles]);

  return {
    handleFiles,
    onUploadButtonClick,
    setUploads,
    releaseObjectUrl,
    startUpload,
    uploads,
  };
}

function useAssetInteractions({
  rows,
  setRows,
  orderedRows,
  canMutate,
  refreshAssets,
  quickLookId,
  setQuickLookId,
}: {
  rows: Asset[] | null;
  setRows: Dispatch<SetStateAction<Asset[] | null>>;
  orderedRows: Asset[];
  canMutate: boolean;
  refreshAssets: () => void;
  quickLookId: string | null;
  setQuickLookId: Dispatch<SetStateAction<string | null>>;
}) {
  const [selection, setSelection] = useState<SelectionState>({
    selected: new Set(),
    focusId: null,
  });
  const [deleteConfirm, setDeleteConfirm] = useState<{
    ids: string[];
    usage: AssetReferrer[];
  } | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [copyBusy, setCopyBusy] = useState(false);
  const deleteOperationRef = useRef<Promise<void> | null>(null);
  const copyOperationRef = useRef<Promise<void> | null>(null);
  const visibleIdsArr = useMemo(() => visibleIds(orderedRows), [orderedRows]);

  const handleSelection = useCallback(
    (event: SelectionEvent): void => {
      setSelection((current) => applySelection(current, visibleIdsArr, event));
    },
    [visibleIdsArr],
  );
  const openQuickLook = useCallback(
    (id: string): void => {
      setSelection((current) => ({ ...current, focusId: id }));
      setQuickLookId(id);
    },
    [setQuickLookId],
  );
  const closeQuickLook = useCallback((): void => {
    const restoreId = quickLookId;
    setQuickLookId(null);
    queueMicrotask(() => {
      if (!restoreId) return;
      const escaped =
        typeof CSS !== "undefined" && typeof CSS.escape === "function"
          ? CSS.escape(restoreId)
          : restoreId.replace(/(["\\])/gu, "\\$1");
      document
        .querySelector<HTMLButtonElement>(`[data-library-primary="${escaped}"]`)
        ?.focus();
    });
  }, [quickLookId, setQuickLookId]);
  const quickLookIndex = quickLookId ? visibleIdsArr.indexOf(quickLookId) : -1;
  const quickLookAsset =
    quickLookId && rows
      ? (rows.find((asset) => asset.id === quickLookId) ?? null)
      : null;
  const onQuickLookPrev = useCallback((): void => {
    if (quickLookIndex > 0) {
      setQuickLookId(visibleIdsArr[quickLookIndex - 1]);
    }
  }, [quickLookIndex, setQuickLookId, visibleIdsArr]);
  const onQuickLookNext = useCallback((): void => {
    if (quickLookIndex >= 0 && quickLookIndex < visibleIdsArr.length - 1) {
      setQuickLookId(visibleIdsArr[quickLookIndex + 1]);
    }
  }, [quickLookIndex, setQuickLookId, visibleIdsArr]);

  const performDelete = useCallback(
    async (ids: string[], force: boolean): Promise<void> => {
      if (deleteOperationRef.current) return deleteOperationRef.current;
      const verifiedIds = ids.filter((id) =>
        rows?.some((asset) => asset.id === id),
      );
      if (verifiedIds.length !== ids.length || verifiedIds.length === 0) {
        toast.error(
          "Selection changed. Review the visible assets and try again.",
        );
        return;
      }
      setDeleteBusy(true);
      const operation = (async (): Promise<void> => {
        const deleted: string[] = [];
        const blocked: { id: string; usage: AssetReferrer[] }[] = [];
        for (const id of verifiedIds) {
          try {
            const listed = rows?.find((asset) => asset.id === id);
            if (!listed) {
              toast.error(
                "Delete stopped because the current asset version is unavailable.",
              );
              continue;
            }
            const exactRead = await api.getAsset(id);
            if (exactRead.error) {
              toast.error(`Delete stopped: ${exactRead.error.message}`);
              continue;
            }
            const exact = decodeAssetDetail(exactRead.data);
            if (!exact.ok || exact.value.asset.version !== listed.version) {
              toast.error(
                "Delete stopped because the asset changed after it was selected. Refresh and review it again.",
              );
              continue;
            }
            const response = await api.deleteAsset(id, {
              expectedVersion: exact.value.asset.version,
              force,
            });
            if (response.error) {
              if (!force && response.error.code === "has_references") {
                const conflict = decodeAssetReferenceConflict(
                  response.error.details,
                );
                if (!conflict.ok) {
                  toast.error(
                    `Delete stopped because usage couldn't be verified: ${conflict.error}`,
                  );
                  continue;
                }
                blocked.push({ id, usage: conflict.value.usage });
                continue;
              }
              toast.error(`Delete failed: ${response.error.message}`);
              continue;
            }
            const acknowledgement = decodeMutationAck(response.data);
            if (!acknowledgement.ok) {
              toast.error(`Delete failed: ${acknowledgement.error}`);
              continue;
            }
            deleted.push(id);
          } catch (error) {
            toast.error(
              `Delete failed: ${
                error instanceof Error && error.message.trim()
                  ? error.message
                  : "The asset delete request failed."
              }`,
            );
          }
        }
        if (deleted.length > 0) {
          setRows((previous) =>
            previous
              ? previous.filter((asset) => !deleted.includes(asset.id))
              : previous,
          );
          setSelection((current) => {
            const nextSelected = new Set(current.selected);
            for (const id of deleted) nextSelected.delete(id);
            return {
              selected: nextSelected,
              focusId:
                current.focusId && deleted.includes(current.focusId)
                  ? null
                  : current.focusId,
            };
          });
          toast.success(
            `Deleted ${deleted.length} asset${deleted.length === 1 ? "" : "s"}${
              blocked.length > 0
                ? ` — ${blocked.length} in use, confirm below`
                : ""
            }`,
          );
          refreshAssets();
        }
        if (blocked.length > 0) {
          const seen = new Set<string>();
          const mergedUsage: AssetReferrer[] = [];
          for (const entry of blocked) {
            for (const usage of entry.usage) {
              const key = `${usage.kind}-${usage.id}`;
              if (seen.has(key)) continue;
              seen.add(key);
              mergedUsage.push(usage);
            }
          }
          setDeleteConfirm({
            ids: blocked.map((entry) => entry.id),
            usage: mergedUsage,
          });
        }
      })();
      deleteOperationRef.current = operation;
      try {
        await operation;
      } finally {
        if (deleteOperationRef.current === operation)
          deleteOperationRef.current = null;
        setDeleteBusy(false);
      }
    },
    [refreshAssets, rows, setRows],
  );

  const onBulkDelete = useCallback((): void => {
    const ids = [...selection.selected];
    if (ids.length > 0) void performDelete(ids, false);
  }, [performDelete, selection.selected]);
  const onTileCopyUrl = useCallback(
    async (id: string): Promise<void> => {
      if (copyOperationRef.current) return copyOperationRef.current;
      const raw = rows?.find((asset) => asset.id === id)?.url ?? "";
      if (!raw) {
        toast.error("This asset has no URL yet.");
        return;
      }
      const url = publicAssetDeliveryUrl(raw);
      if (!url) {
        toast.error("This asset does not expose a public delivery URL.");
        return;
      }
      setCopyBusy(true);
      const operation = (async (): Promise<void> => {
        const result = await writeClipboardText(url, {
          contentClass: "public",
          label: "Asset URL",
        });
        if (result.ok) toast.success("URL copied");
        else toast.error(result.message);
      })();
      copyOperationRef.current = operation;
      try {
        await operation;
      } finally {
        if (copyOperationRef.current === operation)
          copyOperationRef.current = null;
        setCopyBusy(false);
      }
    },
    [rows],
  );
  const onTileDelete = useCallback(
    (id: string): void => {
      if (!canMutate) {
        toast.error("Viewer role can't delete assets.");
        return;
      }
      void performDelete([id], false);
    },
    [canMutate, performDelete],
  );
  const onBulkCopyUrls = useCallback(async (): Promise<void> => {
    if (copyOperationRef.current) return copyOperationRef.current;
    setCopyBusy(true);
    const operation = (async (): Promise<void> => {
      const urls = [...selection.selected]
        .map((id) => {
          const raw = rows?.find((asset) => asset.id === id)?.url;
          return publicAssetDeliveryUrl(raw);
        })
        .filter((url): url is string => Boolean(url));
      if (urls.length !== selection.selected.size || urls.length === 0) {
        toast.error(
          "Selection changed. Review the visible assets and try again.",
        );
        return;
      }
      const result = await writeClipboardText(urls.join("\n"), {
        contentClass: "public",
        label: "Asset URLs",
      });
      if (result.ok)
        toast.success(
          `Copied ${urls.length} URL${urls.length === 1 ? "" : "s"}`,
        );
      else toast.error(result.message);
    })();
    copyOperationRef.current = operation;
    try {
      await operation;
    } finally {
      if (copyOperationRef.current === operation)
        copyOperationRef.current = null;
      setCopyBusy(false);
    }
  }, [rows, selection.selected]);
  const onAltTextChanged = useCallback(
    (id: string, altText: string, version: number): void => {
      setRows((previous) =>
        previous
          ? previous.map((asset) =>
              asset.id === id ? { ...asset, altText, version } : asset,
            )
          : previous,
      );
    },
    [setRows],
  );

  return {
    closeQuickLook,
    deleteConfirm,
    deleteBusy,
    handleSelection,
    onAltTextChanged,
    onBulkCopyUrls,
    onBulkDelete,
    onQuickLookNext,
    onQuickLookPrev,
    onTileCopyUrl,
    onTileDelete,
    openQuickLook,
    performDelete,
    quickLookAsset,
    quickLookIndex,
    selection,
    copyBusy,
    setDeleteConfirm,
    setSelection,
    visibleIdsArr,
  };
}

/* ---------- page ------------------------------------------------------- */

interface AssetsContentProps {
  subtitleText: string;
  canMutate: boolean;
  hasRows: boolean;
  counts: AssetCounts | undefined;
  stats: StatCell[];
  query: string;
  setQuery: Dispatch<SetStateAction<string>>;
  sort: AssetSort;
  setSort: Dispatch<SetStateAction<AssetSort>>;
  viewMode: ViewMode;
  setViewMode: Dispatch<SetStateAction<ViewMode>>;
  density: Density;
  setDensity: Dispatch<SetStateAction<Density>>;
  onUpload: () => void;
  filter: AssetFilter;
  setFilter: Dispatch<SetStateAction<AssetFilter>>;
  activeFolder: string;
  folders: AssetFolder[];
  setActiveFolder: Dispatch<SetStateAction<string>>;
  onCreateFolder: () => void;
  onRenameFolder: (folder: AssetFolder) => void;
  onDeleteFolder: (folder: AssetFolder) => void;
  activeTag: string;
  tagCounts: AssetTagCount[];
  setActiveTag: Dispatch<SetStateAction<string>>;
  filterLoadError: string | null;
  onRetryFilters: () => void;
  error: string | null;
  onRetryLoad: () => void;
  loading: boolean;
  orderedRows: Asset[];
  selection: SelectionState;
  onSelection: (event: SelectionEvent) => void;
  onOpenQuickLook: (id: string) => void;
  onCopyUrl: (id: string) => void;
  onDelete?: (id: string) => void;
  gridWrapRef: React.RefObject<HTMLDivElement | null>;
  gridCols: number;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  onBulkCopyUrls: () => void;
  onBulkDelete: () => void;
  onClearSelection: () => void;
  onFiles: (files: File[]) => void;
  uploads: UploadEntry[];
  setUploads: Dispatch<SetStateAction<UploadEntry[]>>;
  onRetryUpload: (file: File) => void;
  releaseUploadPreview: (id: string) => void;
  operationBusy: boolean;
  onResetFilters: () => void;
}

function AssetsContent(props: AssetsContentProps): ReactElement {
  const {
    subtitleText,
    canMutate,
    hasRows,
    counts,
    stats,
    query,
    setQuery,
    sort,
    setSort,
    viewMode,
    setViewMode,
    density,
    setDensity,
    onUpload,
    filter,
    setFilter,
    activeFolder,
    folders,
    setActiveFolder,
    onCreateFolder,
    onRenameFolder,
    onDeleteFolder,
    activeTag,
    tagCounts,
    setActiveTag,
    filterLoadError,
    onRetryFilters,
    error,
    onRetryLoad,
    loading,
    orderedRows,
    selection,
    onSelection,
    onOpenQuickLook,
    onCopyUrl,
    onDelete,
    gridWrapRef,
    gridCols,
    hasMore,
    loadingMore,
    onLoadMore,
    onBulkCopyUrls,
    onBulkDelete,
    onClearSelection,
    onFiles,
    uploads,
    setUploads,
    onRetryUpload,
    releaseUploadPreview,
    operationBusy,
    onResetFilters,
  } = props;
  const catalogLocked = hasRows && (loading || Boolean(error));
  return (
    <>
      <PageHeader eyebrow="Library" title="Assets" subtitle={subtitleText} />
      {hasRows ? <StatStrip cells={stats} /> : null}
      <LibraryToolbar
        query={query}
        sort={sort}
        viewMode={viewMode}
        density={density}
        canUpload={canMutate}
        onSearchChange={setQuery}
        onSortChange={setSort}
        onViewModeChange={setViewMode}
        onDensityChange={setDensity}
        onUpload={onUpload}
      />
      <LibrarySmartFilters
        active={filter}
        counts={counts}
        onChange={setFilter}
      />
      <LibraryFolderFilters
        active={activeFolder}
        folders={folders}
        canMutate={canMutate}
        onChange={setActiveFolder}
        onCreate={onCreateFolder}
        onRename={onRenameFolder}
        onDelete={onDeleteFolder}
      />
      <LibraryTagFilters
        active={activeTag}
        tags={tagCounts}
        onChange={setActiveTag}
      />
      {filterLoadError ? (
        <div className="notice" role="alert" style={{ marginBottom: 10 }}>
          <span>
            Some library filters couldn&apos;t load: {filterLoadError}
          </span>
          <span className="spacer" />
          <button type="button" className="btn btn-sm" onClick={onRetryFilters}>
            Retry filters
          </button>
        </div>
      ) : null}
      {error ? (
        <div className="notice" role="alert">
          <span>
            Couldn&apos;t refresh assets: {error}
            {hasRows
              ? " Previously verified results remain visible as a read-only snapshot. Retry to verify the catalog before opening, selecting, copying, editing, or deleting an asset."
              : ""}
          </span>
          <span className="spacer" />
          <button
            type="button"
            className="btn btn-sm"
            onClick={onRetryLoad}
            disabled={loading}
          >
            Retry
          </button>
        </div>
      ) : null}
      {loading && !hasRows && !error ? (
        <div
          className="lib-catalog-loading"
          role="status"
          aria-live="polite"
          aria-busy="true"
        >
          <div className="lib-catalog-loading-copy">
            <strong>Loading verified images…</strong>
            <span className="muted small">
              Checking the current workspace catalog and usage state.
            </span>
          </div>
          <div className="lib-catalog-skeleton-grid" aria-hidden="true">
            {Array.from({ length: 6 }, (_, index) => (
              <Skeleton
                key={index}
                variant="card"
                height={180}
                className="lib-catalog-skeleton-card"
              />
            ))}
          </div>
        </div>
      ) : error && !hasRows ? null : !loading && !hasRows ? (
        <LibraryEmptyState
          query={query}
          filter={filter}
          hasAdditionalFilters={activeTag !== "" || activeFolder !== ""}
          canUpload={canMutate}
          onUpload={onUpload}
          onResetFilters={onResetFilters}
        />
      ) : (
        <div
          className={`lib-catalog-region${catalogLocked ? " is-locked" : ""}`}
          aria-busy={loading ? "true" : undefined}
        >
          {catalogLocked ? (
            <div
              className="lib-catalog-availability"
              role="status"
              aria-live="polite"
            >
              {loading
                ? "Refreshing verified results. Asset actions will resume when the current catalog arrives."
                : "This is the last verified snapshot. Asset actions are paused until Retry confirms the current catalog."}
            </div>
          ) : null}
          <div
            className="lib-catalog-stage"
            inert={catalogLocked ? true : undefined}
            aria-label={
              catalogLocked
                ? "Asset catalog snapshot; actions temporarily unavailable"
                : "Asset catalog"
            }
          >
            {viewMode === "list" ? (
              <LibraryList
                assets={orderedRows}
                selection={selection}
                onSelection={onSelection}
                onOpenQuickLook={onOpenQuickLook}
                onCopyUrl={onCopyUrl}
                onDelete={onDelete}
              />
            ) : (
              <div ref={gridWrapRef}>
                <LibraryGrid
                  assets={orderedRows}
                  selection={selection}
                  density={density}
                  rowSize={gridCols}
                  onSelection={onSelection}
                  onOpenQuickLook={onOpenQuickLook}
                  onCopyUrl={onCopyUrl}
                  onDelete={onDelete}
                />
              </div>
            )}
          </div>
        </div>
      )}
      {hasRows && !catalogLocked ? (
        <div
          className="lib-pagination-status"
          style={{
            display: "flex",
            justifyContent: "center",
            margin: "16px 0",
          }}
        >
          <span
            className="muted small"
            role="status"
            aria-live="polite"
            aria-busy={loadingMore ? "true" : undefined}
          >
            {hasMore
              ? loadingMore
                ? `Loading the next page after ${orderedRows.length.toLocaleString()} verified assets.`
                : `Showing ${orderedRows.length.toLocaleString()} verified assets; more may be available.`
              : `Showing all ${orderedRows.length.toLocaleString()} assets returned for these filters.`}
          </span>
          {hasMore ? (
            <button
              type="button"
              className="btn"
              onClick={onLoadMore}
              disabled={loadingMore}
            >
              {loadingMore ? "Loading…" : `Load next ${PAGE_LIMIT}`}
            </button>
          ) : null}
        </div>
      ) : null}
      <LibrarySelectionBar
        count={catalogLocked ? 0 : selection.selected.size}
        canMutate={canMutate}
        onCopyUrls={onBulkCopyUrls}
        onDelete={onBulkDelete}
        onClear={onClearSelection}
        busy={operationBusy}
      />
      <LibraryDropZone enabled={canMutate} onFiles={onFiles} />
      <LibraryUploadTray
        entries={uploads}
        onRetry={(id) => {
          const failed = uploads.find((upload) => upload.id === id);
          releaseUploadPreview(id);
          setUploads((previous) =>
            previous.filter((upload) => upload.id !== id),
          );
          if (failed?.file) onRetryUpload(failed.file);
          else
            toast.info("File reference lost — drag the file again to retry.");
        }}
        onDismiss={(id) => {
          releaseUploadPreview(id);
          setUploads((previous) =>
            previous.filter((upload) => upload.id !== id),
          );
        }}
        onClearAll={() => {
          const removable = uploads.filter(
            (upload) => upload.status === "done" || upload.status === "failed",
          );
          for (const upload of removable) releaseUploadPreview(upload.id);
          setUploads((previous) =>
            previous.filter(
              (upload) =>
                upload.status === "queued" || upload.status === "uploading",
            ),
          );
        }}
      />
    </>
  );
}

interface AssetsOverlaysProps {
  canMutate: boolean;
  quickLookAsset: Asset | null;
  quickLookUsage: AssetReferrer[];
  quickLookUsageState: "idle" | "loading" | "ready" | "error";
  quickLookUsageError: string | null;
  quickLookIndex: number;
  totalAssets: number;
  onQuickLookPrev: () => void;
  onQuickLookNext: () => void;
  closeQuickLook: () => void;
  onAltTextChanged: (id: string, text: string, version: number) => void;
  setRows: Dispatch<SetStateAction<Asset[] | null>>;
  reloadTags: () => Promise<void>;
  folders: AssetFolder[];
  reloadFolders: () => Promise<void>;
  performDelete: (ids: string[], force: boolean) => Promise<void>;
  deleteConfirm: { ids: string[]; usage: AssetReferrer[] } | null;
  setDeleteConfirm: Dispatch<
    SetStateAction<{ ids: string[]; usage: AssetReferrer[] } | null>
  >;
  newFolderOpen: boolean;
  setNewFolderOpen: (open: boolean) => void;
  newFolderRequestRef: React.MutableRefObject<Promise<void> | null>;
  newFolderName: string;
  setNewFolderName: (name: string) => void;
  newFolderBusy: boolean;
  createFolder: () => Promise<void>;
  renameFolderTarget: AssetFolder | null;
  setRenameFolderTarget: (folder: AssetFolder | null) => void;
  renameFolderName: string;
  setRenameFolderName: (name: string) => void;
  renameFolderBusy: boolean;
  renameFolder: () => Promise<void>;
  deleteFolderTarget: AssetFolder | null;
  setDeleteFolderTarget: (folder: AssetFolder | null) => void;
  deleteFolderBusy: boolean;
  deleteFolder: () => Promise<void>;
}

function AssetsOverlays(props: AssetsOverlaysProps): ReactElement {
  const {
    canMutate,
    quickLookAsset,
    quickLookUsage,
    quickLookUsageState,
    quickLookUsageError,
    quickLookIndex,
    totalAssets,
    onQuickLookPrev,
    onQuickLookNext,
    closeQuickLook,
    onAltTextChanged,
    setRows,
    reloadTags,
    folders,
    reloadFolders,
    performDelete,
    deleteConfirm,
    setDeleteConfirm,
    newFolderOpen,
    setNewFolderOpen,
    newFolderRequestRef,
    newFolderName,
    setNewFolderName,
    newFolderBusy,
    createFolder,
    renameFolderTarget,
    setRenameFolderTarget,
    renameFolderName,
    setRenameFolderName,
    renameFolderBusy,
    renameFolder,
    deleteFolderTarget,
    setDeleteFolderTarget,
    deleteFolderBusy,
    deleteFolder,
  } = props;

  const [discardFolderDraftOpen, setDiscardFolderDraftOpen] = useState(false);
  const [discardRenameDraftOpen, setDiscardRenameDraftOpen] = useState(false);
  useEffect(() => {
    if (!newFolderOpen) setDiscardFolderDraftOpen(false);
  }, [newFolderOpen]);
  useEffect(() => {
    if (!renameFolderTarget) setDiscardRenameDraftOpen(false);
  }, [renameFolderTarget]);

  const requestCloseFolderDraft = (): void => {
    if (newFolderRequestRef.current) return;
    if (newFolderName.trim()) {
      setDiscardFolderDraftOpen(true);
      return;
    }
    setNewFolderOpen(false);
  };
  const renameFolderDirty = Boolean(
    renameFolderTarget && renameFolderName.trim() !== renameFolderTarget.name,
  );
  const requestCloseRename = (): void => {
    if (renameFolderBusy) return;
    if (renameFolderDirty) {
      setDiscardRenameDraftOpen(true);
      return;
    }
    setRenameFolderName("");
    setRenameFolderTarget(null);
  };

  return (
    <>
      {quickLookAsset ? (
        <LibraryQuickLook
          asset={quickLookAsset}
          usage={quickLookUsage}
          usageState={quickLookUsageState}
          usageError={quickLookUsageError}
          index={quickLookIndex}
          total={totalAssets}
          onPrev={onQuickLookPrev}
          onNext={onQuickLookNext}
          onClose={closeQuickLook}
          onAltTextChanged={onAltTextChanged}
          onTagsChanged={(id, tags, version) => {
            setRows((previous) =>
              previous
                ? previous.map((asset) =>
                    asset.id === id ? { ...asset, tags, version } : asset,
                  )
                : previous,
            );
            void reloadTags();
          }}
          folders={folders}
          onFolderChanged={(id, folderId, version) => {
            setRows((previous) =>
              previous
                ? previous.map((asset) =>
                    asset.id === id ? { ...asset, folderId, version } : asset,
                  )
                : previous,
            );
            void reloadFolders();
          }}
          onRequestDelete={() => void performDelete([quickLookAsset.id], false)}
        />
      ) : null}
      <DeleteAssetConfirmModal
        confirm={deleteConfirm}
        onClose={() => setDeleteConfirm(null)}
        onConfirm={(ids) => {
          setDeleteConfirm(null);
          void performDelete(ids, true);
        }}
      />
      <Modal
        open={newFolderOpen}
        onClose={requestCloseFolderDraft}
        title="New folder"
        description="Folders organize your library — drop assets into one folder at a time."
      >
        <label className="field">
          <span>Folder name</span>
          <input
            type="text"
            className="input"
            maxLength={128}
            placeholder="For example: Spring sale, Logos, Hero images"
            value={newFolderName}
            onChange={(event) => setNewFolderName(event.target.value)}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                newFolderName.trim() &&
                !newFolderBusy
              ) {
                event.preventDefault();
                void createFolder();
              }
            }}
            disabled={newFolderBusy}
            style={{ width: "100%" }}
          />
        </label>
        <ModalFooter>
          <button
            type="button"
            className="btn"
            onClick={requestCloseFolderDraft}
            disabled={newFolderBusy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={newFolderBusy || !newFolderName.trim()}
            onClick={() => void createFolder()}
          >
            {newFolderBusy ? "Creating…" : "Create"}
          </button>
        </ModalFooter>
      </Modal>
      <ConfirmModal
        open={discardFolderDraftOpen}
        title="Discard this folder draft?"
        description={`The folder name “${newFolderName.trim()}” has not been created.`}
        confirmLabel="Discard draft"
        danger
        onClose={() => setDiscardFolderDraftOpen(false)}
        onConfirm={() => {
          setDiscardFolderDraftOpen(false);
          setNewFolderName("");
          setNewFolderOpen(false);
        }}
      />
      <Modal
        open={!!renameFolderTarget}
        onClose={requestCloseRename}
        title="Rename folder"
        description={
          renameFolderTarget
            ? `Update the label for “${renameFolderTarget.name}”. Assets stay filed in this folder.`
            : undefined
        }
        closeOnBackdrop={!renameFolderBusy}
        closeOnEscape={!renameFolderBusy}
        closeDisabled={renameFolderBusy}
      >
        <label className="field">
          <span>Folder name</span>
          <input
            type="text"
            className="input"
            maxLength={128}
            value={renameFolderName}
            onChange={(event) => setRenameFolderName(event.target.value)}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                canMutate &&
                renameFolderName.trim() &&
                renameFolderDirty &&
                !renameFolderBusy
              ) {
                event.preventDefault();
                void renameFolder();
              }
            }}
            disabled={renameFolderBusy || !canMutate}
            aria-label="Rename folder name"
          />
        </label>
        {!canMutate ? (
          <p className="notice" role="alert">
            Your current role can view folders but can&apos;t rename them.
          </p>
        ) : null}
        <ModalFooter>
          <button
            type="button"
            className="btn"
            onClick={requestCloseRename}
            disabled={renameFolderBusy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={
              renameFolderBusy ||
              !canMutate ||
              !renameFolderName.trim() ||
              !renameFolderDirty
            }
            onClick={() => void renameFolder()}
            aria-busy={renameFolderBusy ? "true" : undefined}
          >
            {renameFolderBusy ? "Renaming…" : "Save name"}
          </button>
        </ModalFooter>
      </Modal>
      <ConfirmModal
        open={!!deleteFolderTarget}
        title="Delete folder?"
        description={
          deleteFolderTarget
            ? `Review what happens to “${deleteFolderTarget.name}”.`
            : undefined
        }
        confirmLabel="Delete folder"
        danger
        busy={deleteFolderBusy}
        confirmDisabled={!canMutate}
        onClose={() => {
          if (!deleteFolderBusy) setDeleteFolderTarget(null);
        }}
        onConfirm={deleteFolder}
      >
        {deleteFolderTarget ? (
          <div className="lib-folder-review">
            <div className="lib-folder-review-summary">
              <span>
                <strong>{deleteFolderTarget.name}</strong>
                <br />
                <span className="muted small">Selected library folder</span>
              </span>
              <span className="lib-folder-review-count">
                {deleteFolderTarget.assetCount.toLocaleString()} asset
                {deleteFolderTarget.assetCount === 1 ? "" : "s"}
              </span>
            </div>
            <p className="muted small">
              The folder itself will be removed. Its contained images are moved
              to <strong>Uncategorised</strong> and are never deleted by this
              action.
            </p>
            {!canMutate ? (
              <p className="notice" role="alert">
                Your current role can view folders but can&apos;t delete them.
              </p>
            ) : null}
          </div>
        ) : null}
      </ConfirmModal>
      <ConfirmModal
        open={discardRenameDraftOpen}
        title="Discard the new folder name?"
        description={
          renameFolderTarget
            ? `“${renameFolderTarget.name}” will keep its current name.`
            : undefined
        }
        confirmLabel="Discard changes"
        danger
        onClose={() => setDiscardRenameDraftOpen(false)}
        onConfirm={() => {
          setDiscardRenameDraftOpen(false);
          setRenameFolderName("");
          setRenameFolderTarget(null);
        }}
      />
    </>
  );
}

export function Assets(): ReactElement {
  const me = useMe();
  const identityScope = desktopRouteIdentityScope(me?.user, me?.tenant);
  return (
    <AssetsWorkspace
      key={identityScope === null ? "anonymous" : `identity:${identityScope}`}
    />
  );
}

function AssetsWorkspace(): ReactElement {
  const me = useMe();
  const canMutate = useCanWrite();
  const workspaceKey = me?.tenant ?? null;
  const identityScope = desktopRouteIdentityScope(me?.user, me?.tenant);

  /* persisted prefs (per-workspace) */
  const [viewMode, setViewMode] = useState<ViewMode>(() =>
    readPref(
      assetPreferenceKey(identityScope, "viewMode"),
      workspaceKey,
      "viewMode",
      ["grid", "list"],
      "grid",
    ),
  );
  const [density, setDensity] = useState<Density>(() =>
    readPref(
      assetPreferenceKey(identityScope, "density"),
      workspaceKey,
      "density",
      ["comfortable", "cozy", "compact"],
      "cozy",
    ),
  );

  /* toolbar state */
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<AssetSort>("newest");
  const [filter, setFilter] = useState<AssetFilter>("all");
  // Workstream 4 (Mailchimp parity polish): the tag chip row sits
  // between the smart-filter chips and the grid. Active tag is sent
  // server-side; tag list refreshes after add/remove operations.
  const [activeTag, setActiveTag] = useState<string>("");

  // Mailchimp-parity follow-up: folder chip row sits above the tag
  // row. activeFolder is one of:
  //   ""        → no folder filter (every asset)
  //   "root"    → Uncategorised bucket only (folder_id IS NULL)
  //   "<uuid>"  → assets in that folder only
  // Sent server-side so paging + counts stay consistent with the
  // existing list-with-counts contract.
  const [activeFolder, setActiveFolder] = useState<string>("");
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [newFolderBusy, setNewFolderBusy] = useState(false);
  const newFolderRequestRef = useRef<Promise<void> | null>(null);
  const [renameFolderTarget, setRenameFolderTarget] =
    useState<AssetFolder | null>(null);
  const [renameFolderName, setRenameFolderName] = useState("");
  const [renameFolderBusy, setRenameFolderBusy] = useState(false);
  const renameFolderRequestRef = useRef<Promise<void> | null>(null);
  const [deleteFolderTarget, setDeleteFolderTarget] =
    useState<AssetFolder | null>(null);
  const [deleteFolderBusy, setDeleteFolderBusy] = useState(false);
  const deleteFolderRequestRef = useRef<Promise<void> | null>(null);

  /* Quick Look */
  const [quickLookId, setQuickLookId] = useState<string | null>(null);
  const {
    counts,
    error,
    folderLoadError,
    folders,
    gridCols,
    gridWrapRef,
    hasMore,
    load,
    loadMore,
    loading,
    loadingMore,
    quickLookUsage,
    quickLookUsageError,
    quickLookUsageState,
    reloadFolders,
    reloadTags,
    rows,
    setFolders,
    setRows,
    tagCounts,
    tagLoadError,
  } = useAssetCatalog({
    workspaceKey,
    query,
    sort,
    filter,
    activeTag,
    activeFolder,
    setActiveFolder,
    density,
    viewMode,
    quickLookId,
  });
  const refreshAssets = useCallback((): void => {
    void load({
      q: query.trim(),
      sort,
      filter,
      tag: activeTag,
      folder: activeFolder,
    });
  }, [load, query, sort, filter, activeTag, activeFolder]);
  const {
    handleFiles,
    onUploadButtonClick,
    setUploads,
    releaseObjectUrl,
    startUpload,
    uploads,
  } = useAssetUploads({ canMutate, refreshAssets });

  /* persist prefs */
  useEffect(() => {
    purgeLegacyAssetPreference(workspaceKey, "viewMode");
    writePref(assetPreferenceKey(identityScope, "viewMode"), viewMode);
  }, [identityScope, viewMode, workspaceKey]);
  useEffect(() => {
    purgeLegacyAssetPreference(workspaceKey, "density");
    writePref(assetPreferenceKey(identityScope, "density"), density);
  }, [density, identityScope, workspaceKey]);

  const createFolder = useCallback(async (): Promise<void> => {
    const name = newFolderName.trim();
    if (!name || newFolderRequestRef.current) return;
    const request = (async (): Promise<void> => {
      setNewFolderBusy(true);
      try {
        const res = await api.createAssetFolder(name);
        if (res.error) {
          toast.error(`Couldn't create folder: ${res.error.message}`);
          return;
        }
        const decoded = decodeAssetFolders({ folders: [res.data] });
        if (!decoded.ok) {
          toast.error(`Couldn't verify the created folder: ${decoded.error}`);
          return;
        }
        const created = decoded.value[0]!;
        setNewFolderOpen(false);
        setNewFolderName("");
        await reloadFolders();
        setActiveFolder(created.id);
        toast.success(`Folder "${created.name}" created`);
      } catch (folderError) {
        toast.error(
          `Couldn't create folder: ${
            folderError instanceof Error && folderError.message.trim()
              ? folderError.message
              : "The create-folder request failed."
          }`,
        );
      } finally {
        setNewFolderBusy(false);
      }
    })();
    newFolderRequestRef.current = request;
    try {
      await request;
    } finally {
      if (newFolderRequestRef.current === request) {
        newFolderRequestRef.current = null;
      }
    }
  }, [newFolderName, reloadFolders]);

  const renameFolder = useCallback(async (): Promise<void> => {
    const target = renameFolderTarget;
    const name = renameFolderName.trim();
    if (
      !target ||
      !name ||
      name === target.name ||
      renameFolderRequestRef.current
    ) {
      return;
    }
    if (!canMutate) {
      toast.error("Your current role can't rename asset folders.");
      return;
    }
    const request = (async (): Promise<void> => {
      setRenameFolderBusy(true);
      try {
        const res = await api.renameAssetFolder(
          target.id,
          name,
          target.version,
        );
        if (res.error) {
          toast.error(`Couldn't rename folder: ${res.error.message}`);
          return;
        }
        const decoded = decodeAssetFolders({ folders: [res.data] });
        if (!decoded.ok) {
          toast.error(`Couldn't verify the renamed folder: ${decoded.error}`);
          return;
        }
        const renamed = decoded.value[0]!;
        if (
          renamed.id !== target.id ||
          renamed.name !== name ||
          renamed.version <= target.version
        ) {
          toast.error(
            "Couldn't verify the renamed folder: the server returned a different folder or name.",
          );
          return;
        }
        setFolders((previous) =>
          previous.map((folder) =>
            folder.id === renamed.id ? renamed : folder,
          ),
        );
        setRenameFolderName("");
        setRenameFolderTarget(null);
        toast.success(`Folder renamed to “${renamed.name}”`);
      } catch (folderError) {
        toast.error(
          `Couldn't rename folder: ${
            folderError instanceof Error && folderError.message.trim()
              ? folderError.message
              : "The rename-folder request failed."
          }`,
        );
      } finally {
        setRenameFolderBusy(false);
      }
    })();
    renameFolderRequestRef.current = request;
    try {
      await request;
    } finally {
      if (renameFolderRequestRef.current === request) {
        renameFolderRequestRef.current = null;
      }
    }
  }, [canMutate, renameFolderName, renameFolderTarget, setFolders]);

  const deleteFolder = useCallback(async (): Promise<void> => {
    const target = deleteFolderTarget;
    if (!target || deleteFolderRequestRef.current) return;
    if (!canMutate) {
      toast.error("Your current role can't delete asset folders.");
      return;
    }
    const request = (async (): Promise<void> => {
      setDeleteFolderBusy(true);
      try {
        const res = await api.deleteAssetFolder(target.id, target.version);
        if (res.error) {
          toast.error(`Couldn't delete folder: ${res.error.message}`);
          return;
        }
        const acknowledged = decodeMutationReceipt(res.data);
        if (!acknowledged.ok) {
          toast.error(
            `Couldn't verify the deleted folder: ${acknowledged.error}`,
          );
          return;
        }
        if (
          acknowledged.value.id !== target.id ||
          acknowledged.value.version <= target.version
        ) {
          toast.error(
            "Couldn't verify the deleted folder: the receipt did not advance the reviewed folder version.",
          );
          return;
        }
        setFolders((previous) =>
          previous.filter((folder) => folder.id !== target.id),
        );
        setDeleteFolderTarget(null);
        setActiveFolder("root");
        setRows(null);
        void load({
          q: query.trim(),
          sort,
          filter,
          tag: activeTag,
          folder: "root",
        });
        toast.success(
          `Folder “${target.name}” deleted; its assets are now Uncategorised`,
        );
      } catch (folderError) {
        toast.error(
          `Couldn't delete folder: ${
            folderError instanceof Error && folderError.message.trim()
              ? folderError.message
              : "The delete-folder request failed."
          }`,
        );
      } finally {
        setDeleteFolderBusy(false);
      }
    })();
    deleteFolderRequestRef.current = request;
    try {
      await request;
    } finally {
      if (deleteFolderRequestRef.current === request) {
        deleteFolderRequestRef.current = null;
      }
    }
  }, [
    activeTag,
    canMutate,
    deleteFolderTarget,
    filter,
    load,
    query,
    setFolders,
    setRows,
    sort,
  ]);

  useEffect(() => {
    if (!newFolderOpen) return;
    return registerLifecycleGuard({
      id: "asset-new-folder-draft",
      label: "Asset folder draft",
      inspect: () =>
        newFolderBusy
          ? {
              level: "blocking",
              detail: "A new asset folder is still being created.",
              canDiscard: false,
              canRecover: false,
            }
          : newFolderName.trim()
            ? {
                level: "warning",
                detail: `The folder draft “${newFolderName.trim()}” has not been created.`,
              }
            : null,
      discard: () => {
        if (newFolderBusy) return;
        setNewFolderName("");
        setNewFolderOpen(false);
      },
    });
  }, [newFolderBusy, newFolderName, newFolderOpen]);

  useEffect(() => {
    if (!renameFolderTarget && !deleteFolderBusy) return;
    return registerLifecycleGuard({
      id: "asset-folder-management",
      label: renameFolderTarget
        ? "Asset folder rename"
        : "Asset folder deletion",
      inspect: () =>
        renameFolderBusy || deleteFolderBusy
          ? {
              level: "blocking",
              detail: renameFolderBusy
                ? "An asset folder rename is still being saved."
                : "An asset folder deletion is still being completed.",
              canDiscard: false,
              canRecover: false,
            }
          : renameFolderTarget &&
              renameFolderName.trim() !== renameFolderTarget.name
            ? {
                level: "warning",
                detail: `The folder name “${renameFolderName.trim()}” has not been saved.`,
              }
            : null,
      discard: () => {
        if (renameFolderBusy || deleteFolderBusy) return;
        setRenameFolderName("");
        setRenameFolderTarget(null);
      },
    });
  }, [
    deleteFolderBusy,
    renameFolderBusy,
    renameFolderName,
    renameFolderTarget,
  ]);

  /* derive ordered ids for selection / arrow nav */
  const orderedRows = useMemo(() => {
    if (!rows) return [];
    // Server already sorts; client-side sort just reapplies when the
    // user toggles between server-supported sorts and offline reorders.
    // sortAssets is idempotent w.r.t. the same mode.
    return sortAssets(rows, sort);
  }, [rows, sort]);

  const {
    closeQuickLook,
    deleteConfirm,
    deleteBusy,
    handleSelection,
    onAltTextChanged,
    onBulkCopyUrls,
    onBulkDelete,
    onQuickLookNext,
    onQuickLookPrev,
    onTileCopyUrl,
    onTileDelete,
    openQuickLook,
    performDelete,
    quickLookAsset,
    quickLookIndex,
    selection,
    copyBusy,
    setDeleteConfirm,
    setSelection,
    visibleIdsArr,
  } = useAssetInteractions({
    rows,
    setRows,
    orderedRows,
    canMutate,
    refreshAssets,
    quickLookId,
    setQuickLookId,
  });

  useEffect(() => {
    setSelection((current) => ({
      selected: new Set(),
      focusId: current.focusId,
    }));
  }, [query, filter, activeTag, activeFolder, setSelection]);

  useEffect(() => {
    const visible = new Set(visibleIdsArr);
    setSelection((current) => {
      const selected = new Set(
        [...current.selected].filter((id) => visible.has(id)),
      );
      const focusId =
        current.focusId && visible.has(current.focusId)
          ? current.focusId
          : null;
      if (
        selected.size === current.selected.size &&
        [...selected].every((id) => current.selected.has(id)) &&
        focusId === current.focusId
      ) {
        return current;
      }
      return { selected, focusId };
    });
  }, [setSelection, visibleIdsArr]);

  const hasRows = !!rows && rows.length > 0;

  /* Stat-strip cells: only meaningful once a fetch has returned. The
   * totalBytes value is computed off the *visible* rows because the
   * server doesn't yet return a workspace-wide size aggregate; once it
   * does, swap counts in here. */
  const totalBytes = useMemo(
    () => (rows ?? []).reduce((sum, a) => sum + (a.bytes || 0), 0),
    [rows],
  );
  const stats: StatCell[] = useMemo(() => {
    const all = counts?.all;
    const unused = counts?.unused;
    const inUse = counts?.inUse;
    return [
      {
        label: "Total assets",
        value: typeof all === "number" ? all.toLocaleString() : "—",
        hint: "Every image stored in your workspace library, regardless of usage.",
      },
      {
        label: "Visible size",
        value: rows && rows.length > 0 ? fmtBytes(totalBytes) : "—",
        hint: "Combined size of the assets currently shown. Filter to narrow down.",
      },
      {
        label: "No reported use",
        value: typeof unused === "number" ? unused.toLocaleString() : "—",
        hint: "No current campaign, template, or form references were reported. Review before deleting because usage can change.",
        onClick:
          typeof unused === "number" && unused > 0
            ? () => setFilter("unused")
            : undefined,
        ariaLabel: "Filter to assets with no reported use",
      },
      {
        label: "Reported uses",
        value: typeof inUse === "number" ? inUse.toLocaleString() : "—",
        hint: "Assets with a reported reference from a current campaign, tenant template, or draft/published form.",
        onClick:
          typeof inUse === "number" && inUse > 0
            ? () => setFilter("in-use")
            : undefined,
        ariaLabel: "Filter to assets with reported uses",
      },
    ];
  }, [counts, rows, totalBytes]);

  const subtitleText =
    loading && !rows
      ? "Loading your image library…"
      : rows
        ? `${rows.length.toLocaleString()} of ${
            counts?.all.toLocaleString() ?? "?"
          } image${rows.length === 1 ? "" : "s"} shown${loading ? "; refreshing verified results…" : "."}${canMutate ? " Upload PNG, JPEG, GIF, or WebP files." : ""}`
        : "—";

  return (
    <>
      <AssetsContent
        subtitleText={subtitleText}
        canMutate={canMutate}
        hasRows={hasRows}
        counts={counts}
        stats={stats}
        query={query}
        setQuery={setQuery}
        sort={sort}
        setSort={setSort}
        viewMode={viewMode}
        setViewMode={setViewMode}
        density={density}
        setDensity={setDensity}
        onUpload={onUploadButtonClick}
        filter={filter}
        setFilter={setFilter}
        activeFolder={activeFolder}
        folders={folders}
        setActiveFolder={setActiveFolder}
        onCreateFolder={() => {
          setNewFolderName("");
          setNewFolderOpen(true);
        }}
        onRenameFolder={(folder) => {
          if (!canMutate) {
            toast.error("Your current role can't rename asset folders.");
            return;
          }
          setRenameFolderName(folder.name);
          setRenameFolderTarget(folder);
        }}
        onDeleteFolder={(folder) => {
          if (!canMutate) {
            toast.error("Your current role can't delete asset folders.");
            return;
          }
          setDeleteFolderTarget(folder);
        }}
        activeTag={activeTag}
        tagCounts={tagCounts}
        setActiveTag={setActiveTag}
        filterLoadError={folderLoadError ?? tagLoadError}
        onRetryFilters={() => {
          if (folderLoadError) void reloadFolders();
          if (tagLoadError) void reloadTags();
        }}
        error={error}
        onRetryLoad={refreshAssets}
        loading={loading}
        orderedRows={orderedRows}
        selection={selection}
        onSelection={handleSelection}
        onOpenQuickLook={openQuickLook}
        onCopyUrl={(id) => void onTileCopyUrl(id)}
        onDelete={canMutate ? onTileDelete : undefined}
        gridWrapRef={gridWrapRef}
        gridCols={gridCols}
        hasMore={hasMore}
        loadingMore={loadingMore}
        onLoadMore={() => void loadMore()}
        onBulkCopyUrls={() => void onBulkCopyUrls()}
        onBulkDelete={onBulkDelete}
        onClearSelection={() =>
          setSelection({ selected: new Set(), focusId: selection.focusId })
        }
        onFiles={handleFiles}
        uploads={uploads}
        setUploads={setUploads}
        onRetryUpload={(file) => void startUpload(file)}
        releaseUploadPreview={releaseObjectUrl}
        operationBusy={deleteBusy || copyBusy}
        onResetFilters={() => {
          setQuery("");
          setFilter("all");
          setSort("newest");
          setActiveTag("");
          setActiveFolder("");
        }}
      />

      <AssetsOverlays
        canMutate={canMutate}
        quickLookAsset={quickLookAsset}
        quickLookUsage={quickLookUsage}
        quickLookUsageState={quickLookUsageState}
        quickLookUsageError={quickLookUsageError}
        quickLookIndex={quickLookIndex}
        totalAssets={visibleIdsArr.length}
        onQuickLookPrev={onQuickLookPrev}
        onQuickLookNext={onQuickLookNext}
        closeQuickLook={closeQuickLook}
        onAltTextChanged={onAltTextChanged}
        setRows={setRows}
        reloadTags={reloadTags}
        folders={folders}
        reloadFolders={reloadFolders}
        performDelete={performDelete}
        deleteConfirm={deleteConfirm}
        setDeleteConfirm={setDeleteConfirm}
        newFolderOpen={newFolderOpen}
        setNewFolderOpen={setNewFolderOpen}
        newFolderRequestRef={newFolderRequestRef}
        newFolderName={newFolderName}
        setNewFolderName={setNewFolderName}
        newFolderBusy={newFolderBusy}
        createFolder={createFolder}
        renameFolderTarget={renameFolderTarget}
        setRenameFolderTarget={setRenameFolderTarget}
        renameFolderName={renameFolderName}
        setRenameFolderName={setRenameFolderName}
        renameFolderBusy={renameFolderBusy}
        renameFolder={renameFolder}
        deleteFolderTarget={deleteFolderTarget}
        setDeleteFolderTarget={setDeleteFolderTarget}
        deleteFolderBusy={deleteFolderBusy}
        deleteFolder={deleteFolder}
      />
    </>
  );
}
