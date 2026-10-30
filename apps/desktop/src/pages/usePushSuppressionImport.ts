import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

import { toast } from "../components/Toast";
import { pushSuppressionsApi } from "../lib/api-client";
import { pickImportFiles } from "../lib/file-transfer";
import {
  parsePushSuppressionImportCsv,
  type PushSuppressionImportItem,
} from "./push-suppression-model";

const IMPORT_POLICY = {
  label: "Push suppression CSV",
  privacy: "confidential" as const,
  extensions: ["csv"],
  mimeTypes: ["text/csv", "text/plain", "application/vnd.ms-excel"],
  maxBytes: 512 * 1024,
  maxFiles: 1,
  maxTotalBytes: 512 * 1024,
};

export interface PushSuppressionImportState {
  open: boolean;
  picking: boolean;
  busy: boolean;
  count: number;
  platformCounts: { apns: number; fcm: number; web: number };
  requestError: string | null;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
}

export interface PushSuppressionImportController {
  state: PushSuppressionImportState;
  chooseFile: (trigger?: HTMLButtonElement | null) => Promise<void>;
  close: () => void;
  submit: () => Promise<void>;
}

export function usePushSuppressionImport({
  canAdmin,
  authorityCurrent,
  refresh,
}: {
  canAdmin: boolean;
  authorityCurrent: boolean;
  refresh: () => Promise<boolean>;
}): PushSuppressionImportController {
  const mountedRef = useRef(true);
  const abortRef = useRef<AbortController | null>(null);
  const pickingRef = useRef(false);
  const submittingRef = useRef(false);
  const returnFocusRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [items, setItems] = useState<PushSuppressionImportItem[]>([]);
  const [platformCounts, setPlatformCounts] = useState({
    apns: 0,
    fcm: 0,
    web: 0,
  });
  const [requestError, setRequestError] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  const clearPrivateState = useCallback((): void => {
    setItems([]);
    setPlatformCounts({ apns: 0, fcm: 0, web: 0 });
  }, []);

  const close = useCallback((): void => {
    if (pickingRef.current || submittingRef.current) return;
    clearPrivateState();
    setRequestError(null);
    setOpen(false);
  }, [clearPrivateState]);

  const chooseFile = useCallback(
    async (trigger?: HTMLButtonElement | null): Promise<void> => {
      if (!canAdmin || !authorityCurrent || pickingRef.current) return;
      pickingRef.current = true;
      setPicking(true);
      setRequestError(null);
      returnFocusRef.current = trigger ?? returnFocusRef.current;
      try {
        const picked = await pickImportFiles(IMPORT_POLICY);
        if (!mountedRef.current || !authorityCurrent) return;
        if (!picked.ok) {
          toast.error(picked.message);
          return;
        }
        if ("cancelled" in picked && picked.cancelled) return;
        const file = picked.files[0];
        if (!file) return;
        const parsed = parsePushSuppressionImportCsv(await file.text());
        if (!parsed.ok) {
          toast.error(parsed.message);
          return;
        }
        setItems(parsed.items);
        setPlatformCounts(parsed.platformCounts);
        setOpen(true);
      } catch {
        if (mountedRef.current) {
          toast.error("The selected CSV could not be read safely.");
        }
      } finally {
        pickingRef.current = false;
        if (mountedRef.current) setPicking(false);
      }
    },
    [authorityCurrent, canAdmin],
  );

  const submit = useCallback(async (): Promise<void> => {
    if (
      !canAdmin ||
      !authorityCurrent ||
      items.length === 0 ||
      submittingRef.current
    ) {
      return;
    }
    submittingRef.current = true;
    setBusy(true);
    setRequestError(null);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const result = await pushSuppressionsApi.bulkImport(items, {
        signal: controller.signal,
      });
      if (!mountedRef.current || controller.signal.aborted) return;
      if ("error" in result && result.error) {
        clearPrivateState();
        setRequestError(
          "The registry did not confirm how many rows were imported. Raw tokens were cleared; close this review and verify the registry before importing again.",
        );
        return;
      }
      clearPrivateState();
      setOpen(false);
      toast.success(
        `${result.data.created.toLocaleString()} created · ${result.data.existing.toLocaleString()} already suppressed.`,
      );
      await refresh();
    } catch {
      if (mountedRef.current && !controller.signal.aborted) {
        clearPrivateState();
        setRequestError(
          "The registry did not confirm how many rows were imported. Raw tokens were cleared; close this review and verify the registry before importing again.",
        );
      }
    } finally {
      submittingRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  }, [authorityCurrent, canAdmin, clearPrivateState, items, refresh]);

  return {
    state: {
      open,
      picking,
      busy,
      count: items.length,
      platformCounts,
      requestError,
      returnFocusRef,
    },
    chooseFile,
    close,
    submit,
  };
}
