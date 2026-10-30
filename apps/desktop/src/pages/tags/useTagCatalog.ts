import { useCallback, useEffect, useRef, useState } from "react";

import { toast } from "../../components/Toast";
import {
  type Tag,
  type TagGroup,
  type TagUsage,
  api,
} from "../../lib/api-client";
import { lifecycleOperationError } from "../../hooks/useSettingsDraftLifecycle";
import {
  isTag,
  isTagGroup,
  isTagUsage,
} from "../../components/tags/tagRemoteValidation";
import {
  readTagCollection,
  tagUsageMap,
  validTagGroups,
  validTags,
  validTagUsage,
} from "./tagCatalogContracts";
import { useTagCatalogDeepLink } from "./useTagCatalogDeepLink";

export { isTag, isTagGroup, isTagUsage };

export interface TagCatalogLoadOptions {
  /** Guarantee a request starts after this invalidation, even if one is active. */
  forceFresh?: boolean;
}

export interface TagRemoteStatus {
  loading: boolean;
  error: string | null;
  lastVerifiedAt: number | null;
  stale: boolean;
}

export function useTagCatalog() {
  const [rows, setRows] = useState<Tag[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [groupError, setGroupError] = useState<string | null>(null);
  const [taxonomyError, setTaxonomyError] = useState<string | null>(null);
  const [groupLoading, setGroupLoading] = useState(true);
  const [taxonomyLoading, setTaxonomyLoading] = useState(true);
  const [catalogVerifiedAt, setCatalogVerifiedAt] = useState<number | null>(
    null,
  );
  const [groupsVerifiedAt, setGroupsVerifiedAt] = useState<number | null>(null);
  const [taxonomyVerifiedAt, setTaxonomyVerifiedAt] = useState<number | null>(
    null,
  );
  const [groups, setGroups] = useState<TagGroup[]>([]);
  const [usageByName, setUsageByName] = useState<Record<string, TagUsage>>({});
  const [detailTag, setDetailTag] = useState<Tag | null>(null);
  const mountedRef = useRef(true);
  const loadRequestRef = useRef<Promise<void> | null>(null);
  const loadInvalidationRef = useRef(0);
  const completedInvalidationRef = useRef(0);
  const groupRequestSequence = useRef(0);
  const taxonomyRequestSequence = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      groupRequestSequence.current += 1;
      taxonomyRequestSequence.current += 1;
    };
  }, []);

  const runCatalogRequest = useCallback(async (): Promise<void> => {
    setCatalogError(null);
    try {
      const result = await api.listTags();
      if (!mountedRef.current) return;
      if (result.error) {
        setCatalogError(result.error.message);
        return;
      }
      const list = readTagCollection(result.data, ["items", "results", "data"]);
      if (!validTags(list)) {
        setCatalogError("The server returned an invalid tag catalogue.");
        return;
      }
      setRows(list);
      setCatalogVerifiedAt(Date.now());
    } catch (caught) {
      if (!mountedRef.current) return;
      setCatalogError(
        lifecycleOperationError(caught, "The tags request failed."),
      );
    }
  }, []);

  const startLoadRunner = useCallback((): Promise<void> => {
    const existing = loadRequestRef.current;
    if (existing) return existing;
    if (!mountedRef.current) return Promise.resolve();

    const request = (async (): Promise<void> => {
      setLoading(true);
      try {
        do {
          const requestInvalidation = loadInvalidationRef.current;
          await runCatalogRequest();
          completedInvalidationRef.current = Math.max(
            completedInvalidationRef.current,
            requestInvalidation,
          );
        } while (
          mountedRef.current &&
          loadInvalidationRef.current > completedInvalidationRef.current
        );
      } finally {
        if (mountedRef.current) setLoading(false);
      }
    })();
    loadRequestRef.current = request;
    void request.finally(() => {
      if (loadRequestRef.current === request) loadRequestRef.current = null;
    });
    return request;
  }, [runCatalogRequest]);

  const load = useCallback(
    async (options: TagCatalogLoadOptions = {}): Promise<void> => {
      if (!options.forceFresh) {
        await startLoadRunner();
        return;
      }
      const targetInvalidation = ++loadInvalidationRef.current;
      while (
        mountedRef.current &&
        completedInvalidationRef.current < targetInvalidation
      ) {
        await startLoadRunner();
      }
    },
    [startLoadRunner],
  );

  const loadGroups = useCallback(async (): Promise<void> => {
    const requestSequence = ++groupRequestSequence.current;
    setGroupLoading(true);
    setGroupError(null);
    try {
      const result = await api.listTagGroups();
      if (
        !mountedRef.current ||
        requestSequence !== groupRequestSequence.current
      ) {
        return;
      }
      if (result.error) {
        setGroupError(result.error.message);
        return;
      }
      const items = readTagCollection(result.data, ["items"]);
      if (!validTagGroups(items)) {
        setGroupError("The server returned invalid tag groups.");
        return;
      }
      setGroups(items);
      setGroupsVerifiedAt(Date.now());
    } catch (caught) {
      if (
        !mountedRef.current ||
        requestSequence !== groupRequestSequence.current
      ) {
        return;
      }
      setGroupError(
        lifecycleOperationError(caught, "The tag groups request failed."),
      );
    } finally {
      if (
        mountedRef.current &&
        requestSequence === groupRequestSequence.current
      ) {
        setGroupLoading(false);
      }
    }
  }, []);

  const reloadTaxonomy = useCallback(async (): Promise<void> => {
    const requestSequence = ++taxonomyRequestSequence.current;
    setTaxonomyLoading(true);
    setTaxonomyError(null);
    try {
      const result = await api.listTagTaxonomy();
      if (
        !mountedRef.current ||
        requestSequence !== taxonomyRequestSequence.current
      ) {
        return;
      }
      if (result?.error) {
        setTaxonomyError(result.error.message);
        toast.error({
          message: "Couldn't refresh tag counts",
          detail: result.error.code
            ? `[${result.error.code}] ${result.error.message}`
            : result.error.message,
        });
        return;
      }
      const items = readTagCollection(result?.data, ["items", "tags"]);
      if (!validTagUsage(items)) {
        const detail = "The server returned invalid tag usage data.";
        setTaxonomyError(detail);
        toast.error({ message: "Couldn't refresh tag counts", detail });
        return;
      }
      setUsageByName(tagUsageMap(items));
      setTaxonomyVerifiedAt(Date.now());
    } catch (caught) {
      if (
        !mountedRef.current ||
        requestSequence !== taxonomyRequestSequence.current
      ) {
        return;
      }
      const detail = lifecycleOperationError(
        caught,
        "The tag counts request failed.",
      );
      setTaxonomyError(detail);
      toast.error({ message: "Couldn't refresh tag counts", detail });
    } finally {
      if (
        mountedRef.current &&
        requestSequence === taxonomyRequestSequence.current
      ) {
        setTaxonomyLoading(false);
      }
    }
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    await Promise.all([load(), loadGroups(), reloadTaxonomy()]);
  }, [load, loadGroups, reloadTaxonomy]);

  useEffect(() => {
    void load();
    void loadGroups();
    void reloadTaxonomy();
  }, [load, loadGroups, reloadTaxonomy]);

  useTagCatalogDeepLink(rows);

  return {
    rows,
    setRows,
    loading,
    error: catalogError ?? groupError ?? taxonomyError,
    catalogStatus: {
      loading,
      error: catalogError,
      lastVerifiedAt: catalogVerifiedAt,
      stale: catalogError !== null && catalogVerifiedAt !== null,
    } satisfies TagRemoteStatus,
    groupStatus: {
      loading: groupLoading,
      error: groupError,
      lastVerifiedAt: groupsVerifiedAt,
      stale: groupError !== null && groupsVerifiedAt !== null,
    } satisfies TagRemoteStatus,
    taxonomyStatus: {
      loading: taxonomyLoading,
      error: taxonomyError,
      lastVerifiedAt: taxonomyVerifiedAt,
      stale: taxonomyError !== null && taxonomyVerifiedAt !== null,
    } satisfies TagRemoteStatus,
    groups,
    usageByName,
    detailTag,
    setDetailTag,
    load,
    loadGroups,
    reloadTaxonomy,
    refresh,
  };
}

export type TagCatalogController = ReturnType<typeof useTagCatalog>;
