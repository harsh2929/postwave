import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  type Collection,
  type CollectionType,
  api,
} from "../../lib/api-client";
import {
  decodeCollectionDetail,
  decodeCollectionPage,
  decodeDeleteAcknowledgement,
} from "../../lib/collections/collection-contract";
import {
  COLLECTION_IMPORT_FILE_MAX_BYTES,
  type ParsedCollectionUpload,
  parseCollectionUpload,
} from "../../lib/collections/collection-import";
import {
  collectionNameFromFile,
  validateCollectionName,
  validateCollectionQuery,
} from "../../lib/collections/collection-validation";
import { registerLifecycleGuard } from "../../lib/lifecycle-coordinator";
import { toast } from "../Toast";

const COLLECTION_PAGE_SIZE = 50;

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : fallback;
}

function detailErrorText(error: { code?: string; message: string }): string {
  if (error.code === "response_too_large") {
    return "These stored rows exceed the desktop’s safe read limit. The collection remains on the server, but its values cannot be inspected or edited here. Use the API to split or replace it.";
  }
  return error.message;
}

function asSummary(collection: Collection): Collection {
  return { ...collection, data: [] };
}

function useCollectionCatalog({
  identityScope,
  workspaceTenantId,
}: {
  identityScope: string | null;
  workspaceTenantId: string | null;
}) {
  const [items, setItems] = useState<Collection[]>([]);
  const [total, setTotal] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(identityScope !== null);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const [searchDraft, setSearchDraft] = useState("");
  const [query, setQuery] = useState("");
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchComposing, setSearchComposing] = useState(false);
  const [typeFilter, setTypeFilter] = useState<CollectionType | "all">("all");
  const abortRef = useRef<AbortController | null>(null);
  const requestRef = useRef(0);
  const itemsRef = useRef<Collection[]>([]);

  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  const loadPage = useCallback(
    async (mode: "clear" | "refresh" | "append", cursor?: string) => {
      if (!identityScope) return;
      const request = ++requestRef.current;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      if (mode === "clear") {
        setItems([]);
        setTotal(0);
        setNextCursor(null);
        setLoading(true);
      } else if (mode === "refresh") {
        setRefreshing(true);
      } else {
        setLoadingMore(true);
      }
      if (mode === "append") {
        setLoadMoreError(null);
      } else {
        setLoadError(null);
        setLoadMoreError(null);
      }
      try {
        const response = await api.listCollections({
          includeData: false,
          limit: COLLECTION_PAGE_SIZE,
          ...(cursor ? { cursor } : {}),
          ...(query ? { query } : {}),
          ...(typeFilter === "all" ? {} : { collectionType: typeFilter }),
          ...(workspaceTenantId ? { workspaceId: workspaceTenantId } : {}),
          signal: controller.signal,
        });
        if (request !== requestRef.current || controller.signal.aborted) return;
        if (response.error) {
          if (mode === "append") setLoadMoreError(response.error.message);
          else setLoadError(response.error.message);
          return;
        }
        const page = decodeCollectionPage(response.data, workspaceTenantId);
        if (!page) {
          const message =
            "The collection service returned an invalid metadata page. Verified results were kept; retry the request.";
          if (mode === "append") setLoadMoreError(message);
          else setLoadError(message);
          return;
        }
        if (mode === "append") {
          const ids = new Set(itemsRef.current.map((item) => item.id));
          if (
            page.items.some((item) => ids.has(item.id)) ||
            page.next_cursor === cursor ||
            (page.items.length === 0 && page.next_cursor)
          ) {
            setLoadMoreError(
              "The next page was not a safe continuation of the verified catalog. Pagination stopped without advancing the cursor.",
            );
            return;
          }
        }
        const prospectiveCount =
          mode === "append"
            ? itemsRef.current.length + page.items.length
            : page.items.length;
        const cursorCoherent = page.next_cursor
          ? prospectiveCount < page.total
          : prospectiveCount === page.total;
        if (prospectiveCount > page.total || !cursorCoherent) {
          const message =
            "The collection page count and continuation cursor disagreed. Pagination stopped without replacing verified metadata.";
          if (mode === "append") setLoadMoreError(message);
          else setLoadError(message);
          return;
        }
        if (mode === "append") {
          setItems([...itemsRef.current, ...page.items]);
        } else {
          setItems(page.items);
        }
        setTotal(page.total);
        setNextCursor(page.next_cursor ?? null);
      } catch (error) {
        if (request !== requestRef.current || controller.signal.aborted) return;
        const message = errorText(
          error,
          "Couldn't load reference collections.",
        );
        if (mode === "append") setLoadMoreError(message);
        else setLoadError(message);
      } finally {
        if (request === requestRef.current) {
          setLoading(false);
          setRefreshing(false);
          setLoadingMore(false);
        }
      }
    },
    [identityScope, query, typeFilter, workspaceTenantId],
  );

  useEffect(() => {
    if (!identityScope) return;
    void loadPage("clear");
    return () => abortRef.current?.abort();
  }, [identityScope, loadPage]);

  const commitSearch = useCallback((value: string): void => {
    const validation = validateCollectionQuery(value);
    setSearchError(validation);
    if (!validation) setQuery(value.trim());
  }, []);

  useEffect(() => {
    if (searchComposing) return;
    const timer = window.setTimeout(() => commitSearch(searchDraft), 300);
    return () => window.clearTimeout(timer);
  }, [commitSearch, searchComposing, searchDraft]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const clearFilters = useCallback(() => {
    setSearchDraft("");
    setSearchError(null);
    setQuery("");
    setTypeFilter("all");
  }, []);
  const refresh = useCallback(() => loadPage("refresh"), [loadPage]);
  const reload = useCallback(() => loadPage("clear"), [loadPage]);
  const loadMore = useCallback(
    () => (nextCursor ? loadPage("append", nextCursor) : Promise.resolve()),
    [loadPage, nextCursor],
  );
  const replaceSummary = useCallback((collection: Collection) => {
    setItems((current) =>
      current.map((item) =>
        item.id === collection.id ? asSummary(collection) : item,
      ),
    );
  }, []);
  const removeSummary = useCallback((id: string) => {
    setItems((current) => current.filter((item) => item.id !== id));
    setTotal((current) => Math.max(0, current - 1));
  }, []);

  return {
    items,
    total,
    nextCursor,
    loading,
    refreshing,
    loadingMore,
    loadError,
    loadMoreError,
    searchDraft,
    query,
    searchError,
    searchComposing,
    typeFilter,
    setSearchDraft,
    setSearchComposing,
    setTypeFilter,
    commitSearch,
    clearFilters,
    refresh,
    reload,
    loadMore,
    replaceSummary,
    removeSummary,
  };
}

function useCollectionImport({
  canWrite,
  reload,
  refresh,
  workspaceTenantId,
}: {
  canWrite: boolean;
  reload: () => Promise<void>;
  refresh: () => Promise<void>;
  workspaceTenantId: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [type, setType] = useState<CollectionType>("content");
  const [parsed, setParsed] = useState<ParsedCollectionUpload | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [parsing, setParsing] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [saving, setSaving] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const parseRequestRef = useRef(0);
  const saveAbortRef = useRef<AbortController | null>(null);
  const parsingRef = useRef(false);
  const savingRef = useRef(false);
  const nameRef = useRef(name);
  const canWriteRef = useRef(canWrite);
  canWriteRef.current = canWrite;
  nameRef.current = name;
  const nameValidation = useMemo(() => validateCollectionName(name), [name]);
  const nameError = nameTouched ? nameValidation : null;
  const draft =
    open && (name.length > 0 || parsed !== null || type !== "content");

  const closeNow = useCallback(() => {
    parseRequestRef.current += 1;
    parsingRef.current = false;
    nameRef.current = "";
    setOpen(false);
    setName("");
    setNameTouched(false);
    setType("content");
    setParsed(null);
    setFileName(null);
    setParseError(null);
    setParsing(false);
    setDragOver(false);
    setDiscardOpen(false);
  }, []);

  useEffect(() => {
    if (!canWrite) {
      const interrupted = savingRef.current;
      parseRequestRef.current += 1;
      parsingRef.current = false;
      setParsing(false);
      setDragOver(false);
      saveAbortRef.current?.abort();
      if (interrupted) void refresh();
    }
  }, [canWrite, refresh]);
  useEffect(
    () => () => {
      saveAbortRef.current?.abort();
      parseRequestRef.current += 1;
    },
    [],
  );

  const handleFile = async (file: File): Promise<void> => {
    if (!canWriteRef.current || savingRef.current || parsingRef.current) {
      return;
    }
    const request = ++parseRequestRef.current;
    setParsed(null);
    setFileName(file.name);
    setParseError(null);
    if (file.size === 0 || file.size > COLLECTION_IMPORT_FILE_MAX_BYTES) {
      setParseError(
        file.size === 0
          ? "The selected file is empty."
          : "Choose a CSV or JSON file no larger than 1 MiB.",
      );
      return;
    }
    parsingRef.current = true;
    setParsing(true);
    try {
      const buffer = await file.arrayBuffer();
      if (request !== parseRequestRef.current) return;
      const text = new TextDecoder("utf-8", { fatal: true })
        .decode(buffer)
        .replace(/^\uFEFF/u, "");
      const result = parseCollectionUpload(file.name, text);
      if (request !== parseRequestRef.current) return;
      setParsed(result);
      if (nameRef.current.length === 0) {
        const derivedName = collectionNameFromFile(file.name);
        nameRef.current = derivedName;
        setName(derivedName);
        setNameTouched(true);
      }
    } catch (error) {
      if (request === parseRequestRef.current) {
        setParseError(
          errorText(
            error,
            "The file is not valid UTF-8 or could not be parsed safely.",
          ),
        );
      }
    } finally {
      if (request === parseRequestRef.current) {
        parsingRef.current = false;
        setParsing(false);
      }
    }
  };

  const create = async (): Promise<void> => {
    if (
      savingRef.current ||
      !canWriteRef.current ||
      nameValidation ||
      !parsed
    ) {
      setNameTouched(true);
      return;
    }
    savingRef.current = true;
    setSaving(true);
    const controller = new AbortController();
    saveAbortRef.current = controller;
    try {
      const response = await api.createCollection(
        {
          name,
          collection_type: type,
          source_type: parsed.sourceType,
          data: parsed.rows,
        },
        { signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      if (response.error) {
        if (response.error.code === "collection_name_conflict") {
          toast.error(
            "A reference collection with this name already exists. Your draft was kept so you can rename it or inspect the existing record.",
          );
          await refresh();
          return;
        }
        toast.error(`Couldn't create collection: ${response.error.message}`);
        return;
      }
      const created = decodeCollectionDetail(response.data, workspaceTenantId);
      if (!created) {
        toast.error(
          "The collection may have been created, but the response could not be verified. Your draft was kept while the catalog refreshes.",
        );
        await refresh();
        return;
      }
      toast.success(`Created “${created.name}”`);
      closeNow();
      await reload();
    } catch (error) {
      if (!controller.signal.aborted) {
        toast.error(errorText(error, "Couldn't create the collection."));
      }
    } finally {
      savingRef.current = false;
      if (saveAbortRef.current === controller) saveAbortRef.current = null;
      setSaving(false);
    }
  };

  return {
    open,
    name,
    nameError,
    type,
    parsed,
    fileName,
    parseError,
    parsing,
    dragOver,
    saving,
    discardOpen,
    draft,
    setName: (value: string) => {
      setNameTouched(true);
      nameRef.current = value;
      setName(value);
    },
    setType,
    setParseError,
    setDragOver,
    setDiscardOpen,
    openEditor: () => {
      if (canWriteRef.current) setOpen(true);
    },
    requestClose: () => {
      if (saving) return;
      if (draft) setDiscardOpen(true);
      else closeNow();
    },
    closeNow,
    handleFile,
    create,
  };
}

function useCollectionDetail({
  canWrite,
  refresh,
  replaceSummary,
  workspaceTenantId,
}: {
  canWrite: boolean;
  refresh: () => Promise<void>;
  replaceSummary: (collection: Collection) => void;
  workspaceTenantId: string | null;
}) {
  const [target, setTarget] = useState<Collection | null>(null);
  const [detail, setDetail] = useState<Collection | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [type, setType] = useState<CollectionType>("content");
  const [saving, setSaving] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const readAbortRef = useRef<AbortController | null>(null);
  const saveAbortRef = useRef<AbortController | null>(null);
  const requestRef = useRef(0);
  const savingRef = useRef(false);
  const canWriteRef = useRef(canWrite);
  canWriteRef.current = canWrite;
  const nameError = useMemo(() => validateCollectionName(name), [name]);
  const dirty =
    detail !== null &&
    (name !== detail.name || type !== detail.collection_type);

  const closeNow = useCallback(() => {
    readAbortRef.current?.abort();
    requestRef.current += 1;
    setTarget(null);
    setDetail(null);
    setError(null);
    setLoading(false);
    setName("");
    setType("content");
    setDiscardOpen(false);
  }, []);

  const openEditor = useCallback(
    async (summary: Collection): Promise<void> => {
      if (!canWriteRef.current) return;
      const request = ++requestRef.current;
      readAbortRef.current?.abort();
      const controller = new AbortController();
      readAbortRef.current = controller;
      setTarget(summary);
      setDetail(null);
      setError(null);
      setLoading(true);
      try {
        const response = await api.getCollection(summary.id, {
          signal: controller.signal,
        });
        if (
          request !== requestRef.current ||
          controller.signal.aborted ||
          !canWriteRef.current
        ) {
          return;
        }
        if (response.error) {
          setError(detailErrorText(response.error));
          return;
        }
        const decoded = decodeCollectionDetail(
          response.data,
          workspaceTenantId,
        );
        if (!decoded || decoded.id !== summary.id) {
          setError(
            "The collection service returned a mismatched or malformed record. No unverified row values were shown.",
          );
          return;
        }
        setDetail(decoded);
        setName(decoded.name);
        setType(decoded.collection_type);
      } catch (caught) {
        if (request === requestRef.current && !controller.signal.aborted) {
          setError(errorText(caught, "Couldn't load the collection rows."));
        }
      } finally {
        if (request === requestRef.current) setLoading(false);
      }
    },
    [workspaceTenantId],
  );

  const save = async (): Promise<void> => {
    if (
      !detail ||
      savingRef.current ||
      !canWriteRef.current ||
      !dirty ||
      nameError
    ) {
      return;
    }
    savingRef.current = true;
    setSaving(true);
    const controller = new AbortController();
    saveAbortRef.current = controller;
    try {
      const response = await api.updateCollection(
        detail.id,
        { name, collection_type: type },
        detail.version,
        { signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      if (response.error) {
        if (response.error.code === "collection_name_conflict") {
          toast.error(
            "Another reference collection already uses that name. Your changes were kept so you can choose a different name.",
          );
          await refresh();
          return;
        }
        toast.error(`Couldn't save: ${response.error.message}`);
        return;
      }
      const updated = decodeCollectionDetail(response.data, workspaceTenantId);
      if (!updated || updated.id !== detail.id) {
        toast.error(
          "The update response could not be verified. The catalog will refresh before any result is trusted.",
        );
        await refresh();
        return;
      }
      replaceSummary(updated);
      toast.success("Collection metadata updated");
      closeNow();
    } catch (caught) {
      if (!controller.signal.aborted) {
        toast.error(errorText(caught, "Couldn't save the collection."));
      }
    } finally {
      savingRef.current = false;
      if (saveAbortRef.current === controller) saveAbortRef.current = null;
      setSaving(false);
    }
  };

  useEffect(() => {
    if (canWrite) return;
    const interrupted = savingRef.current;
    readAbortRef.current?.abort();
    saveAbortRef.current?.abort();
    closeNow();
    if (interrupted) void refresh();
  }, [canWrite, closeNow, refresh]);
  useEffect(
    () => () => {
      readAbortRef.current?.abort();
      saveAbortRef.current?.abort();
    },
    [],
  );

  return {
    target,
    detail,
    loading,
    error,
    name,
    nameError,
    type,
    saving,
    discardOpen,
    dirty,
    setName,
    setType,
    setDiscardOpen,
    openEditor,
    retry: () => (target ? openEditor(target) : Promise.resolve()),
    requestClose: () => {
      if (saving) return;
      if (dirty) setDiscardOpen(true);
      else closeNow();
    },
    closeNow,
    save,
  };
}

function useCollectionDelete({
  canDelete,
  canWrite,
  refresh,
  removeSummary,
}: {
  canDelete: boolean;
  canWrite: boolean;
  refresh: () => Promise<void>;
  removeSummary: (id: string) => void;
}) {
  const [target, setTarget] = useState<Collection | null>(null);
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const busyRef = useRef(false);
  const canDeleteRef = useRef(canDelete);
  canDeleteRef.current = canDelete;

  useEffect(() => {
    if (!canWrite) {
      const interrupted = busyRef.current;
      abortRef.current?.abort();
      setTarget(null);
      if (interrupted) void refresh();
    } else if (!canDelete && !busyRef.current) {
      setTarget(null);
    }
  }, [canDelete, canWrite, refresh]);
  useEffect(() => () => abortRef.current?.abort(), []);

  const confirm = async (): Promise<void> => {
    if (!target || busyRef.current || !canDeleteRef.current) return;
    busyRef.current = true;
    setBusy(true);
    const deleting = target;
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const exactRead = await api.getCollection(deleting.id, {
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (exactRead.error) {
        toast.error(`Couldn't delete: ${exactRead.error.message}`);
        return;
      }
      const current = decodeCollectionDetail(exactRead.data);
      if (
        !current ||
        current.id !== deleting.id ||
        current.version !== deleting.version
      ) {
        toast.error(
          "The collection changed after it was selected. Nothing was deleted; refresh and review it again.",
        );
        await refresh();
        return;
      }
      const response = await api.deleteCollection(
        deleting.id,
        current.version,
        { signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      if (response.error) {
        toast.error(`Couldn't delete: ${response.error.message}`);
        return;
      }
      if (
        !decodeDeleteAcknowledgement(
          response.data,
          deleting.id,
          current.version,
        )
      ) {
        toast.error(
          "The delete acknowledgement could not be verified. The catalog will refresh before the result is trusted.",
        );
        await refresh();
        return;
      }
      removeSummary(deleting.id);
      setTarget(null);
      toast.success(`Deleted “${deleting.name}”`);
    } catch (error) {
      if (!controller.signal.aborted) {
        toast.error(errorText(error, "Couldn't delete the collection."));
      }
    } finally {
      busyRef.current = false;
      if (abortRef.current === controller) abortRef.current = null;
      setBusy(false);
    }
  };

  return {
    target,
    busy,
    open: (collection: Collection) => {
      if (canDeleteRef.current) setTarget(collection);
    },
    close: () => setTarget(null),
    confirm,
  };
}

export function useCollectionsController({
  canWrite,
  identityScope,
  workspaceTenantId,
}: {
  canWrite: boolean;
  identityScope: string | null;
  workspaceTenantId: string | null;
}) {
  const catalog = useCollectionCatalog({ identityScope, workspaceTenantId });
  const collectionImport = useCollectionImport({
    canWrite,
    reload: catalog.reload,
    refresh: catalog.refresh,
    workspaceTenantId,
  });
  const detail = useCollectionDetail({
    canWrite,
    refresh: catalog.refresh,
    replaceSummary: catalog.replaceSummary,
    workspaceTenantId,
  });
  const canDelete =
    canWrite &&
    !catalog.loading &&
    !catalog.refreshing &&
    !catalog.loadingMore &&
    !catalog.loadError;
  const deletion = useCollectionDelete({
    canDelete,
    canWrite,
    refresh: catalog.refresh,
    removeSummary: catalog.removeSummary,
  });

  useEffect(() => {
    if (
      !collectionImport.draft &&
      !detail.dirty &&
      !collectionImport.saving &&
      !detail.saving &&
      !deletion.busy
    ) {
      return;
    }
    return registerLifecycleGuard({
      id: "collections-editor",
      label: deletion.busy
        ? "Permanent collection deletion"
        : collectionImport.draft
          ? "New reference-data draft"
          : "Collection changes",
      inspect: (intent) =>
        intent.disposition === "hide"
          ? null
          : deletion.busy
            ? {
                level: "blocking",
                detail:
                  "A permanent collection deletion is waiting for server acknowledgement.",
                canDiscard: false,
              }
            : collectionImport.saving || detail.saving
              ? {
                  level: "blocking",
                  detail: "Reference-data changes are still being saved.",
                  canDiscard: false,
                }
              : {
                  level: "blocking",
                  detail:
                    "Parsed rows or metadata changes have not been saved.",
                },
      discard: () => {
        collectionImport.closeNow();
        detail.closeNow();
      },
    });
  }, [
    collectionImport.closeNow,
    collectionImport.draft,
    collectionImport.saving,
    detail.closeNow,
    detail.dirty,
    detail.saving,
    deletion.busy,
  ]);

  return { catalog, collectionImport, detail, deletion, canDelete };
}
