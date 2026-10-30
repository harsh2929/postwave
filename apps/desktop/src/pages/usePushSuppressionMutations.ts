import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";

import { toast } from "../components/Toast";
import { pushSuppressionsApi } from "../lib/api-client";
import type {
  PushSuppressionPlatform,
  PushSuppressionRow,
} from "../lib/api/push-suppressions";
import {
  isConflictError,
  rowCanBeRemoved,
  validateRawPushToken,
} from "./push-suppression-model";

export interface PushSuppressionAddState {
  open: boolean;
  platform: PushSuppressionPlatform;
  token: string;
  tokenError: string | null;
  requestError: string | null;
  busy: boolean;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
}

export interface PushSuppressionRemoveState {
  target: PushSuppressionRow | null;
  error: string | null;
  busy: boolean;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
}

export interface PushSuppressionMutationController {
  add: PushSuppressionAddState;
  remove: PushSuppressionRemoveState;
  openAdd: (trigger?: HTMLButtonElement | null) => void;
  closeAdd: () => void;
  setAddPlatform: (value: PushSuppressionPlatform) => void;
  setAddToken: (value: string) => void;
  submitAdd: () => Promise<void>;
  requestRemove: (
    row: PushSuppressionRow,
    trigger?: HTMLButtonElement | null,
  ) => void;
  closeRemove: () => void;
  confirmRemove: () => Promise<void>;
}

export function usePushSuppressionMutations({
  canAdmin,
  authorityCurrent,
  rows,
  refresh,
}: {
  canAdmin: boolean;
  authorityCurrent: boolean;
  rows: PushSuppressionRow[] | null;
  refresh: () => Promise<boolean>;
}): PushSuppressionMutationController {
  const mountedRef = useRef(true);
  const mutationAbortRef = useRef<AbortController | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [addPlatform, setAddPlatformState] =
    useState<PushSuppressionPlatform>("apns");
  const [addToken, setAddTokenState] = useState("");
  const [addTokenError, setAddTokenError] = useState<string | null>(null);
  const [addRequestError, setAddRequestError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const addingRef = useRef(false);
  const addReturnFocusRef = useRef<HTMLButtonElement | null>(null);
  const [removeTarget, setRemoveTarget] = useState<PushSuppressionRow | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const removingRef = useRef(false);
  const removeReturnFocusRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
      mutationAbortRef.current?.abort();
    };
  }, []);

  const openAdd = useCallback(
    (trigger?: HTMLButtonElement | null): void => {
      if (!authorityCurrent) return;
      addReturnFocusRef.current = trigger ?? addReturnFocusRef.current;
      setAddRequestError(null);
      setAddTokenError(null);
      setAddOpen(true);
    },
    [authorityCurrent],
  );
  const closeAdd = useCallback((): void => {
    if (addingRef.current) return;
    setAddOpen(false);
    setAddTokenState("");
    setAddTokenError(null);
    setAddRequestError(null);
  }, []);
  const submitAdd = useCallback(async (): Promise<void> => {
    if (!canAdmin || !authorityCurrent || addingRef.current) return;
    const validation = validateRawPushToken(addToken, addPlatform);
    setAddTokenError(validation);
    if (validation) return;
    addingRef.current = true;
    setAdding(true);
    setAddRequestError(null);
    const controller = new AbortController();
    mutationAbortRef.current = controller;
    try {
      const result = await pushSuppressionsApi.add(
        { device_token: addToken, platform: addPlatform, reason: "manual" },
        { signal: controller.signal },
      );
      if (!mountedRef.current || controller.signal.aborted) return;
      if ("error" in result && result.error) {
        setAddTokenState("");
        setAddRequestError(
          result.error.status === 401 || result.error.status === 403
            ? "Admin authority could not be confirmed. Nothing else was submitted from this dialog."
            : "The registry did not confirm whether this token was added. Verify the list before retrying to avoid an unknown outcome.",
        );
        return;
      }
      setAddTokenState("");
      setAddOpen(false);
      toast.success("Manual push suppression added.");
      await refresh();
    } catch {
      if (mountedRef.current && !controller.signal.aborted) {
        setAddTokenState("");
        setAddRequestError(
          "The registry did not confirm whether this token was added. Verify the list before retrying to avoid an unknown outcome.",
        );
      }
    } finally {
      if (mountedRef.current) setAdding(false);
      addingRef.current = false;
    }
  }, [addPlatform, addToken, authorityCurrent, canAdmin, refresh]);

  const requestRemove = useCallback(
    (row: PushSuppressionRow, trigger?: HTMLButtonElement | null): void => {
      if (!authorityCurrent || !rowCanBeRemoved(row)) return;
      const current = rows?.find((candidate) => candidate.id === row.id);
      if (!current || current.version !== row.version) return;
      removeReturnFocusRef.current = trigger ?? null;
      setRemoveError(null);
      setRemoveTarget(current);
    },
    [authorityCurrent, rows],
  );
  const closeRemove = useCallback((): void => {
    if (removingRef.current) return;
    setRemoveTarget(null);
    setRemoveError(null);
  }, []);
  const confirmRemove = useCallback(async (): Promise<void> => {
    if (!canAdmin || !authorityCurrent || !removeTarget || removingRef.current) return;
    const current = rows?.find((row) => row.id === removeTarget.id);
    if (!current || current.version !== removeTarget.version || !rowCanBeRemoved(current)) {
      setRemoveError("This row changed after review. Refresh before confirming removal.");
      return;
    }
    removingRef.current = true;
    setRemoving(true);
    setRemoveError(null);
    const controller = new AbortController();
    mutationAbortRef.current = controller;
    try {
      const result = await pushSuppressionsApi.remove(
        current.id,
        { expected_version: current.version },
        { signal: controller.signal },
      );
      if (!mountedRef.current || controller.signal.aborted) return;
      if ("error" in result && result.error) {
        if (isConflictError(result.error)) {
          setRemoveTarget(null);
          toast.info("The row changed before removal. The registry is being refreshed.");
          await refresh();
        } else {
          setRemoveError(
            "The registry did not confirm whether removal completed. Verify the row before retrying.",
          );
        }
        return;
      }
      setRemoveTarget(null);
      toast.success(
        result.data.stillSuppressed
          ? "Manual authority removed; another authority still suppresses this token."
          : "Manual push suppression removed.",
      );
      await refresh();
    } catch {
      if (mountedRef.current && !controller.signal.aborted) {
        setRemoveError(
          "The registry did not confirm whether removal completed. Verify the row before retrying.",
        );
      }
    } finally {
      if (mountedRef.current) setRemoving(false);
      removingRef.current = false;
    }
  }, [authorityCurrent, canAdmin, refresh, removeTarget, rows]);

  return {
    add: {
      open: addOpen,
      platform: addPlatform,
      token: addToken,
      tokenError: addTokenError,
      requestError: addRequestError,
      busy: adding,
      returnFocusRef: addReturnFocusRef,
    },
    remove: {
      target: removeTarget,
      error: removeError,
      busy: removing,
      returnFocusRef: removeReturnFocusRef,
    },
    openAdd,
    closeAdd,
    setAddPlatform: (value) => {
      setAddPlatformState(value);
      setAddTokenError(null);
    },
    setAddToken: (value) => {
      setAddTokenState(value);
      setAddTokenError(null);
      setAddRequestError(null);
    },
    submitAdd,
    requestRemove,
    closeRemove,
    confirmRemove,
  };
}
