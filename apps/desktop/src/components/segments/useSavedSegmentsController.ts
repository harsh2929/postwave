import {
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  type SavedSegment,
  type SavedSegmentPatch,
  type SavedSegmentScope,
  type SegmentFolder,
  createSegmentFolder,
  deleteSegmentFolder,
  listSavedSegments,
  listSegmentFolders,
  patchSavedSegment,
  patchSegmentFolder,
  previewSavedSegmentDetail,
} from "../../lib/api-client";
import { toast } from "../Toast";
import { usePersistentLifecycleOperation } from "../../hooks/usePersistentLifecycleOperation";
import {
  lifecycleOperationError,
  useDiscardOnlyDraftLifecycle,
  useExistingSettingLifecycle,
} from "../../hooks/useSettingsDraftLifecycle";
import { remoteFailureFromError } from "../../lib/remote-resource";

export const UNFILED = "__unfiled__";

export interface SavedSegmentGroup {
  key: string;
  label: string;
  rows: SavedSegment[];
}

function failureDetail(reason: unknown): string {
  return reason instanceof Error && reason.message.trim()
    ? reason.message
    : "Unexpected saved-segment service failure.";
}

function sortedFolders(items: SegmentFolder[]): SegmentFolder[] {
  return [...items].sort((left, right) =>
    left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
  );
}

function validMemberCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validAggregatePreview(
  value: Awaited<ReturnType<typeof previewSavedSegmentDetail>>["data"],
  segmentId: string,
): boolean {
  return Boolean(
    value &&
    value.id === segmentId &&
    validMemberCount(value.count) &&
    validMemberCount(value.workspace_total) &&
    value.count <= value.workspace_total &&
    typeof value.generated_at === "string" &&
    !Number.isNaN(Date.parse(value.generated_at)),
  );
}

function pinnedSegments(items: SavedSegment[] | null): SavedSegment[] {
  return [...(items ?? [])]
    .filter((segment) => segment.is_pinned)
    .sort((left, right) => {
      const leftOrder = left.pin_order ?? Number.MAX_SAFE_INTEGER;
      const rightOrder = right.pin_order ?? Number.MAX_SAFE_INTEGER;
      if (leftOrder !== rightOrder) return leftOrder - rightOrder;
      return right.updated_at.localeCompare(left.updated_at);
    });
}

function groupedSegments(
  segments: SavedSegment[] | null,
  folders: SegmentFolder[],
): SavedSegmentGroup[] {
  const unpinned = (segments ?? []).filter((segment) => !segment.is_pinned);
  const groups: SavedSegmentGroup[] = [];
  for (const folder of folders) {
    const rows = unpinned.filter((segment) => segment.folder_id === folder.id);
    if (rows.length > 0) {
      groups.push({ key: folder.id, label: folder.name, rows });
    }
  }
  const knownFolders = new Set(folders.map((folder) => folder.id));
  const unfiled = unpinned.filter(
    (segment) => !segment.folder_id || !knownFolders.has(segment.folder_id),
  );
  if (unfiled.length > 0) {
    groups.push({ key: UNFILED, label: "Unfiled", rows: unfiled });
  }
  return groups;
}

type SegmentSetter = Dispatch<SetStateAction<SavedSegment[] | null>>;
type FolderSetter = Dispatch<SetStateAction<SegmentFolder[]>>;
type Reload = (options?: { supersede?: boolean }) => Promise<void>;

interface SharedActionsContext {
  activeRef: MutableRefObject<boolean>;
  canMutateRef: MutableRefObject<boolean>;
  canManageFoldersRef: MutableRefObject<boolean>;
  canManageFolders: boolean;
  dataRevisionRef: MutableRefObject<number>;
  segments: SavedSegment[] | null;
  segmentsRef: MutableRefObject<SavedSegment[] | null>;
  folders: SegmentFolder[];
  setSegments: SegmentSetter;
  setFolders: FolderSetter;
  reload: Reload;
}

function useSavedSegmentActions(context: SharedActionsContext) {
  const {
    activeRef,
    canMutateRef,
    canManageFoldersRef,
    dataRevisionRef,
    segmentsRef,
    folders,
    setSegments,
    reload,
  } = context;
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [countingIds, setCountingIds] = useState<Set<string>>(new Set());
  const writeLocksRef = useRef<Set<string>>(new Set());
  const countLocksRef = useRef<Set<string>>(new Set());
  const dragIdRef = useRef<string | null>(null);

  const markIds = useCallback(
    (
      setter: Dispatch<SetStateAction<Set<string>>>,
      ids: readonly string[],
      on: boolean,
    ): void => {
      if (!activeRef.current) return;
      setter((previous) => {
        const next = new Set(previous);
        for (const id of ids) {
          if (on) next.add(id);
          else next.delete(id);
        }
        return next;
      });
    },
    [activeRef],
  );

  const beginWrite = useCallback(
    (ids: readonly string[]): boolean => {
      if (!activeRef.current || !canMutateRef.current) return false;
      if (ids.some((id) => writeLocksRef.current.has(id))) return false;
      ids.forEach((id) => writeLocksRef.current.add(id));
      markIds(setBusyIds, ids, true);
      dataRevisionRef.current += 1;
      return true;
    },
    [activeRef, canMutateRef, dataRevisionRef, markIds],
  );

  const endWrite = useCallback(
    (ids: readonly string[]): void => {
      ids.forEach((id) => writeLocksRef.current.delete(id));
      markIds(setBusyIds, ids, false);
    },
    [markIds],
  );

  const replaceSegment = useCallback(
    (next: SavedSegment): void => {
      setSegments(
        (previous) =>
          previous?.map((row) => (row.id === next.id ? next : row)) ?? previous,
      );
    },
    [setSegments],
  );

  const patchRow = useCallback(
    async (
      segment: SavedSegment,
      patch: SavedSegmentPatch,
      message: string,
    ): Promise<void> => {
      if (!beginWrite([segment.id])) return;
      try {
        const result = await patchSavedSegment(segment.id, patch);
        if (!activeRef.current) return;
        if (result.error || !result.data) {
          toast.error({ message, detail: result.error?.message });
          return;
        }
        dataRevisionRef.current += 1;
        replaceSegment(result.data);
      } catch (reason) {
        if (activeRef.current) {
          toast.error({ message, detail: failureDetail(reason) });
        }
      } finally {
        endWrite([segment.id]);
      }
    },
    [activeRef, beginWrite, dataRevisionRef, endWrite, replaceSegment],
  );

  const refreshCount = useCallback(
    async (segment: SavedSegment): Promise<void> => {
      if (!activeRef.current || countLocksRef.current.has(segment.id)) return;
      countLocksRef.current.add(segment.id);
      markIds(setCountingIds, [segment.id], true);
      dataRevisionRef.current += 1;
      try {
        const result = await previewSavedSegmentDetail(segment.id);
        if (!activeRef.current) return;
        if (result.error || !validAggregatePreview(result.data, segment.id)) {
          toast.error({
            message: "Couldn't refresh count",
            detail: result.error
              ? remoteFailureFromError(result.error).message
              : "The server returned an invalid aggregate count.",
          });
          return;
        }
        dataRevisionRef.current += 1;
        setSegments(
          (previous) =>
            previous?.map((row) =>
              row.id === segment.id
                ? {
                    ...row,
                    last_count: result.data!.count,
                    last_evaluated_at: result.data!.generated_at,
                  }
                : row,
            ) ?? previous,
        );
      } catch {
        if (activeRef.current) {
          toast.error({
            message: "Couldn't refresh count",
            detail: "The saved-segment service could not be reached.",
          });
        }
      } finally {
        countLocksRef.current.delete(segment.id);
        markIds(setCountingIds, [segment.id], false);
      }
    },
    [activeRef, dataRevisionRef, markIds, setSegments],
  );

  const persistPinOrder = useCallback(
    async (ordered: SavedSegment[]): Promise<void> => {
      const updates = ordered
        .map((segment, index) => ({ segment, index }))
        .filter(({ segment, index }) => segment.pin_order !== index);
      const ids = updates.map(({ segment }) => segment.id);
      if (updates.length === 0 || !beginWrite(ids)) return;
      setSegments((previous) => {
        if (!previous) return previous;
        const orderById = new Map(
          ordered.map((segment, index) => [segment.id, index]),
        );
        return previous.map((segment) =>
          orderById.has(segment.id)
            ? { ...segment, pin_order: orderById.get(segment.id) }
            : segment,
        );
      });
      try {
        const results = await Promise.all(
          updates.map(({ segment, index }) =>
            patchSavedSegment(segment.id, { pin_order: index }),
          ),
        );
        if (!activeRef.current) return;
        if (results.some((result) => result.error || !result.data)) {
          toast.error({ message: "Couldn't save the new order" });
          await reload({ supersede: true });
          return;
        }
        dataRevisionRef.current += 1;
        results.forEach((result) => {
          if (result.data) replaceSegment(result.data);
        });
      } catch (reason) {
        if (activeRef.current) {
          toast.error({
            message: "Couldn't save the new order",
            detail: failureDetail(reason),
          });
          await reload({ supersede: true });
        }
      } finally {
        endWrite(ids);
      }
    },
    [
      activeRef,
      beginWrite,
      dataRevisionRef,
      endWrite,
      reload,
      replaceSegment,
      setSegments,
    ],
  );

  const dropOn = useCallback(
    (targetId: string): void => {
      const sourceId = dragIdRef.current;
      dragIdRef.current = null;
      if (!sourceId || sourceId === targetId) return;
      const currentPinned = pinnedSegments(segmentsRef.current);
      const from = currentPinned.findIndex(
        (segment) => segment.id === sourceId,
      );
      const to = currentPinned.findIndex((segment) => segment.id === targetId);
      if (from < 0 || to < 0) return;
      const next = [...currentPinned];
      const [moved] = next.splice(from, 1);
      if (!moved) return;
      next.splice(to, 0, moved);
      void persistPinOrder(next);
    },
    [persistPinOrder, segmentsRef],
  );

  const movePinned = useCallback(
    (id: string, direction: -1 | 1): void => {
      const currentPinned = pinnedSegments(segmentsRef.current);
      const index = currentPinned.findIndex((segment) => segment.id === id);
      const target = currentPinned[index + direction];
      if (index < 0 || !target) return;
      dragIdRef.current = id;
      dropOn(target.id);
    },
    [dropOn, segmentsRef],
  );

  useEffect(
    () => () => {
      writeLocksRef.current.clear();
      countLocksRef.current.clear();
      dragIdRef.current = null;
    },
    [],
  );

  return {
    busyIds,
    countingIds,
    refreshCount,
    togglePin: (segment: SavedSegment) =>
      patchRow(
        segment,
        { is_pinned: !segment.is_pinned },
        "Couldn't update pin",
      ),
    setScope: (segment: SavedSegment, scope: string) => {
      if (scope !== "personal" && scope !== "workspace")
        return Promise.resolve();
      if (scope === segment.visibility_scope) return Promise.resolve();
      return patchRow(
        segment,
        { visibility_scope: scope as SavedSegmentScope },
        "Couldn't update sharing",
      );
    },
    setFolder: (segment: SavedSegment, selection: string) => {
      if (!canManageFoldersRef.current) return Promise.resolve();
      if (
        selection !== UNFILED &&
        !folders.some((folder) => folder.id === selection)
      ) {
        return Promise.resolve();
      }
      return patchRow(
        segment,
        { folder_id: selection === UNFILED ? "" : selection },
        "Couldn't move segment",
      );
    },
    startDrag: (id: string) => {
      if (canMutateRef.current) dragIdRef.current = id;
    },
    endDrag: () => {
      dragIdRef.current = null;
    },
    dropOn,
    movePinned,
  };
}

function useFolderActions(context: SharedActionsContext) {
  const {
    activeRef,
    canManageFolders,
    canManageFoldersRef,
    dataRevisionRef,
    setFolders,
    setSegments,
  } = context;
  const [newFolderName, setNewFolderName] = useState("");
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [renameTarget, setRenameTarget] = useState<SegmentFolder | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renamingFolder, setRenamingFolder] = useState(false);
  const [renameDiscardConfirmOpen, setRenameDiscardConfirmOpen] =
    useState(false);
  const [deleteTarget, setDeleteTarget] = useState<SegmentFolder | null>(null);
  const [deletingFolder, setDeletingFolder] = useState(false);
  const locksRef = useRef<Set<string>>(new Set());
  const operation = usePersistentLifecycleOperation({
    ownerId: "saved-segment-folders",
    label: "Saved-segment folder operation",
  });
  const createDirty = newFolderName !== "";
  const renameDirty =
    renameTarget !== null && renameValue !== renameTarget.name;

  const discardCreateDraft = useCallback((): void => {
    setNewFolderName("");
  }, []);

  const discardRenameDraft = useCallback((): void => {
    setRenameValue("");
    setRenameTarget(null);
    setRenameDiscardConfirmOpen(false);
  }, []);

  const begin = useCallback(
    (key: string): boolean => {
      if (
        !activeRef.current ||
        !canManageFoldersRef.current ||
        locksRef.current.has(key)
      ) {
        return false;
      }
      locksRef.current.add(key);
      dataRevisionRef.current += 1;
      return true;
    },
    [activeRef, canManageFoldersRef, dataRevisionRef],
  );

  const createFolder = useCallback(async (): Promise<void> => {
    const name = newFolderName.trim();
    if (!name || !begin("create")) return;
    setCreatingFolder(true);
    const pending = operation.run(() => createSegmentFolder(name));
    if (!pending) {
      locksRef.current.delete("create");
      if (activeRef.current) setCreatingFolder(false);
      return;
    }
    try {
      const result = await pending;
      if (!activeRef.current) return;
      if (result.error || !result.data) {
        toast.error({
          message: "Couldn't create folder",
          detail: result.error?.message,
        });
        return;
      }
      dataRevisionRef.current += 1;
      setFolders((previous) => sortedFolders([...previous, result.data!]));
      setNewFolderName("");
      toast.success(`Folder "${name}" created`);
    } catch (reason) {
      if (activeRef.current) {
        toast.error({
          message: "Couldn't create folder",
          detail: lifecycleOperationError(reason, failureDetail(reason)),
        });
      }
    } finally {
      locksRef.current.delete("create");
      if (activeRef.current) setCreatingFolder(false);
    }
  }, [activeRef, begin, dataRevisionRef, newFolderName, operation, setFolders]);

  const renameFolder = useCallback(async (): Promise<boolean> => {
    const target = renameTarget;
    const name = renameValue.trim();
    const key = target ? `rename:${target.id}` : "";
    if (!target || !name || !begin(key)) return false;
    setRenamingFolder(true);
    const pending = operation.run(() => patchSegmentFolder(target.id, name));
    if (!pending) {
      locksRef.current.delete(key);
      if (activeRef.current) setRenamingFolder(false);
      return false;
    }
    try {
      const result = await pending;
      if (!activeRef.current) return true;
      if (result.error || !result.data) {
        toast.error({
          message: "Couldn't rename folder",
          detail: result.error?.message,
        });
        return false;
      }
      dataRevisionRef.current += 1;
      setFolders((previous) =>
        sortedFolders(
          previous.map((folder) =>
            folder.id === result.data!.id ? result.data! : folder,
          ),
        ),
      );
      setRenameTarget(null);
      setRenameValue("");
      setRenameDiscardConfirmOpen(false);
      toast.success("Folder renamed");
      return true;
    } catch (reason) {
      if (activeRef.current) {
        toast.error({
          message: "Couldn't rename folder",
          detail: lifecycleOperationError(reason, failureDetail(reason)),
        });
      }
      return false;
    } finally {
      locksRef.current.delete(key);
      if (activeRef.current) setRenamingFolder(false);
    }
  }, [
    activeRef,
    begin,
    dataRevisionRef,
    renameTarget,
    renameValue,
    operation,
    setFolders,
  ]);

  useDiscardOnlyDraftLifecycle({
    ownerId: "saved-segment-folder-create",
    label: "New saved-segment folder draft",
    dirty: createDirty,
    operationRef: operation.promiseRef,
    discard: discardCreateDraft,
    detail:
      "This saved-segment folder name has not been created. Return to it or explicitly discard it.",
  });
  useExistingSettingLifecycle({
    ownerId: `saved-segment-folder-${renameTarget?.id ?? "none"}`,
    label: "Saved-segment folder rename",
    dirty: renameDirty,
    operationRef: operation.promiseRef,
    save: renameFolder,
    discard: discardRenameDraft,
    enabled: renameTarget !== null,
  });

  const deleteFolder = useCallback(async (): Promise<void> => {
    const target = deleteTarget;
    const key = target ? `delete:${target.id}` : "";
    if (!target || !begin(key)) return;
    setDeletingFolder(true);
    const pending = operation.run(() => deleteSegmentFolder(target.id));
    if (!pending) {
      locksRef.current.delete(key);
      if (activeRef.current) setDeletingFolder(false);
      return;
    }
    try {
      const result = await pending;
      if (!activeRef.current) return;
      if (result.error) {
        toast.error({
          message: "Couldn't delete folder",
          detail: result.error.message,
        });
        return;
      }
      dataRevisionRef.current += 1;
      setFolders((previous) =>
        previous.filter((folder) => folder.id !== target.id),
      );
      setSegments(
        (previous) =>
          previous?.map((segment) =>
            segment.folder_id === target.id
              ? { ...segment, folder_id: undefined }
              : segment,
          ) ?? previous,
      );
      setDeleteTarget(null);
      toast.success("Folder deleted — its segments were unfiled");
    } catch (reason) {
      if (activeRef.current) {
        toast.error({
          message: "Couldn't delete folder",
          detail: lifecycleOperationError(reason, failureDetail(reason)),
        });
      }
    } finally {
      locksRef.current.delete(key);
      if (activeRef.current) setDeletingFolder(false);
    }
  }, [
    activeRef,
    begin,
    dataRevisionRef,
    deleteTarget,
    operation,
    setFolders,
    setSegments,
  ]);

  useEffect(() => {
    if (canManageFolders) return;
    setDeleteTarget(null);
  }, [canManageFolders]);

  useEffect(
    () => () => {
      locksRef.current.clear();
    },
    [],
  );

  return {
    newFolderName,
    creatingFolder,
    renameTarget,
    renameValue,
    renamingFolder,
    renameDiscardConfirmOpen,
    deleteFolderTarget: deleteTarget,
    deletingFolder,
    setNewFolderName,
    createFolder,
    startRename: (folder: SegmentFolder): void => {
      if (!canManageFoldersRef.current) return;
      setRenameTarget(folder);
      setRenameValue(folder.name);
      setRenameDiscardConfirmOpen(false);
    },
    setRenameValue,
    closeRename: (): void => {
      if (operation.promiseRef.current) return;
      if (renameDirty) {
        setRenameDiscardConfirmOpen(true);
        return;
      }
      setRenameTarget(null);
      setRenameValue("");
    },
    closeRenameDiscard: (): void => setRenameDiscardConfirmOpen(false),
    discardRenameDraft,
    renameFolder,
    startDelete: (folder: SegmentFolder): void => {
      if (canManageFoldersRef.current) setDeleteTarget(folder);
    },
    closeDelete: (): void => {
      if (!deletingFolder) setDeleteTarget(null);
    },
    deleteFolder,
  };
}

export function useSavedSegmentsController(canMutate: boolean) {
  const [segments, setSegments] = useState<SavedSegment[] | null>(null);
  const [folders, setFolders] = useState<SegmentFolder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [folderError, setFolderError] = useState<string | null>(null);
  const [foldersReady, setFoldersReady] = useState(false);
  const activeRef = useRef(false);
  const canMutateRef = useRef(canMutate);
  const canManageFoldersRef = useRef(false);
  const segmentsRef = useRef<SavedSegment[] | null>(segments);
  const dataRevisionRef = useRef(0);
  const loadRequestRef = useRef(0);
  const loadingRef = useRef(false);
  canMutateRef.current = canMutate;
  segmentsRef.current = segments;
  const folderControlsEnabled =
    canMutate && foldersReady && folderError === null;
  canManageFoldersRef.current = folderControlsEnabled;

  const load = useCallback<Reload>(async (options = {}): Promise<void> => {
    if (!activeRef.current || (loadingRef.current && !options.supersede)) {
      return;
    }
    const requestId = ++loadRequestRef.current;
    const startRevision = dataRevisionRef.current;
    loadingRef.current = true;
    setLoading(true);
    setError(null);
    try {
      const [segmentResult, folderResult] = await Promise.all([
        listSavedSegments(),
        listSegmentFolders(),
      ]);
      if (
        !activeRef.current ||
        requestId !== loadRequestRef.current ||
        startRevision !== dataRevisionRef.current
      ) {
        return;
      }
      if (segmentResult.error) {
        setError(remoteFailureFromError(segmentResult.error).message);
      } else if (!Array.isArray(segmentResult.data?.items)) {
        setError(
          "Saved segments returned an invalid response. No empty state was assumed.",
        );
      } else {
        setSegments(segmentResult.data.items);
      }
      if (folderResult.error) {
        setFolderError(remoteFailureFromError(folderResult.error).message);
        setFoldersReady(false);
      } else if (!Array.isArray(folderResult.data?.items)) {
        setFolderError(
          "Saved-segment folders returned an invalid response. No empty state was assumed.",
        );
        setFoldersReady(false);
      } else {
        setFolders(sortedFolders(folderResult.data.items));
        setFolderError(null);
        setFoldersReady(true);
      }
    } catch {
      if (
        activeRef.current &&
        requestId === loadRequestRef.current &&
        startRevision === dataRevisionRef.current
      ) {
        const detail = "The saved-segment service could not be reached.";
        setError(detail);
        setFolderError(detail);
        setFoldersReady(false);
      }
    } finally {
      if (activeRef.current && requestId === loadRequestRef.current) {
        loadingRef.current = false;
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    activeRef.current = true;
    void load({ supersede: true });
    return () => {
      activeRef.current = false;
      loadRequestRef.current += 1;
      loadingRef.current = false;
    };
  }, [load]);

  const context: SharedActionsContext = {
    activeRef,
    canMutateRef,
    canManageFoldersRef,
    canManageFolders: folderControlsEnabled,
    dataRevisionRef,
    segments,
    segmentsRef,
    folders,
    setSegments,
    setFolders,
    reload: load,
  };
  const segmentActions = useSavedSegmentActions(context);
  const folderActions = useFolderActions(context);
  const pinned = useMemo(() => pinnedSegments(segments), [segments]);
  const groups = useMemo(
    () => groupedSegments(segments, folders),
    [folders, segments],
  );

  return {
    canMutate,
    folderControlsEnabled,
    segments,
    folders,
    pinned,
    groups,
    total: segments?.length ?? 0,
    loading,
    error,
    folderError,
    refresh: () => void load(),
    ...segmentActions,
    ...folderActions,
  };
}

export type SavedSegmentsController = ReturnType<
  typeof useSavedSegmentsController
>;
