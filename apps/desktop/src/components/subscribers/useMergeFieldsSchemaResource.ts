import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import {
  type MergeFieldSchema,
  listMergeFieldSchema,
} from "../../lib/api-client";
import { isMergeFieldSchema } from "../../lib/api/audience-segmentation";

export interface MergeFieldsSchemaResource {
  rows: MergeFieldSchema[] | null;
  setRows: Dispatch<SetStateAction<MergeFieldSchema[] | null>>;
  loading: boolean;
  loadError: string | null;
  externalChangePending: boolean;
  load: () => Promise<void>;
  generation: () => number;
  isCurrentGeneration: (generation: number) => boolean;
  isMounted: () => boolean;
  markExternalChange: () => void;
}

export function useMergeFieldsSchemaResource(
  open: boolean,
  onLoadCommit: () => void,
): MergeFieldsSchemaResource {
  const [rows, setRows] = useState<MergeFieldSchema[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [externalChangePending, setExternalChangePending] = useState(false);
  const requestSequence = useRef(0);
  const mounted = useRef(true);
  const openRef = useRef(open);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      requestSequence.current += 1;
    };
  }, []);

  const load = useCallback(async (): Promise<void> => {
    const sequence = ++requestSequence.current;
    setLoading(true);
    try {
      const response = await listMergeFieldSchema();
      if (!mounted.current || sequence !== requestSequence.current) return;
      if (response.error) {
        setLoadError(response.error.message);
        return;
      }
      const items = response.data?.items;
      if (!Array.isArray(items) || !items.every(isMergeFieldSchema)) {
        setLoadError(
          "The server returned an incomplete schema contract. Editing is disabled until the service is upgraded.",
        );
        return;
      }
      const uniqueKeys = new Set(items.map((item) => item.key));
      const tenantIDs = new Set(items.map((item) => item.tenant_id));
      if (uniqueKeys.size !== items.length || tenantIDs.size > 1) {
        setLoadError(
          "The server returned an ambiguous schema. Editing is disabled to prevent a cross-workspace or duplicate-key update.",
        );
        return;
      }
      setRows(items);
      setLoadError(null);
      setExternalChangePending(false);
      onLoadCommit();
    } catch {
      if (!mounted.current || sequence !== requestSequence.current) return;
      setLoadError("The schema service couldn't be reached.");
    } finally {
      if (mounted.current && sequence === requestSequence.current) {
        setLoading(false);
      }
    }
  }, [onLoadCommit]);

  useEffect(() => {
    openRef.current = open;
    if (open) {
      void load();
      return;
    }
    requestSequence.current += 1;
  }, [load, open]);

  return {
    rows,
    setRows,
    loading,
    loadError,
    externalChangePending,
    load,
    generation: () => requestSequence.current,
    isCurrentGeneration: (generation: number) =>
      generation === requestSequence.current,
    isMounted: () => mounted.current,
    markExternalChange: () => {
      if (mounted.current && openRef.current) setExternalChangePending(true);
    },
  };
}
