import { useCallback, useEffect, useRef, useState } from "react";

import { toast } from "../components/Toast";
import type { PushSuppressionRow } from "../lib/api/push-suppressions";
import { saveFile } from "../lib/file-transfer";
import { buildPushSuppressionCsv } from "./push-suppression-model";

export interface PushSuppressionExportController {
  busy: boolean;
  saveCurrentPage: () => Promise<void>;
}

export function usePushSuppressionExport({
  authorityCurrent,
  rows,
  pageIndex,
}: {
  authorityCurrent: boolean;
  rows: readonly PushSuppressionRow[];
  pageIndex: number;
}): PushSuppressionExportController {
  const mountedRef = useRef(true);
  const exportingRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  const saveCurrentPage = useCallback(async (): Promise<void> => {
    if (exportingRef.current || !authorityCurrent || rows.length === 0) return;
    exportingRef.current = true;
    setBusy(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const result = await saveFile({
        data: buildPushSuppressionCsv(rows),
        suggestedName: `push-suppressions-fingerprints-page-${pageIndex + 1}-${new Date()
          .toISOString()
          .slice(0, 10)}.csv`,
        label: "Push suppression fingerprint export",
        privacy: "confidential",
        mimeType: "text/csv;charset=utf-8",
        filters: [{ name: "CSV", extensions: ["csv"] }],
        signal: controller.signal,
      });
      if (!mountedRef.current || controller.signal.aborted) return;
      if (!result.ok) throw new Error("save_failed");
      if (result.status !== "cancelled") {
        toast.success("Current verified page exported with fingerprints only.");
      }
    } catch {
      if (mountedRef.current && !controller.signal.aborted) {
        toast.error("The current verified page could not be exported.");
      }
    } finally {
      exportingRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  }, [authorityCurrent, pageIndex, rows]);

  return { busy, saveCurrentPage };
}
