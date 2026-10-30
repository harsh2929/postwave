// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import {
  Bookmark,
  ChevronDown,
  ChevronUp,
  Clock3,
  Columns3,
  FolderHeart,
  FolderPlus,
  Plus,
  RefreshCw,
  Save,
  Search,
  Trash2,
  X,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { RelativeTime } from "@/components/relative-time";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
import { Textarea } from "@/components/ui/textarea";
import { ApiError, apiErrorMessage } from "@/lib/api";
import {
  clearCampaignTemplateDiscoveryCreateRecovery,
  readCampaignTemplateDiscoveryCreateRecovery,
  writeCampaignTemplateDiscoveryCreateRecovery,
} from "@/lib/campaign-template-discovery-session";
import {
  campaignTemplateCapabilities,
  campaignTemplateCapabilityLabel,
  campaignTemplateDiscoveryIdempotencyKey,
  campaignTemplateThumbnailUrl,
  clearRecentCampaignTemplateViews,
  compareCampaignTemplates,
  createCampaignTemplateCollection,
  createCampaignTemplateSavedSearch,
  deleteCampaignTemplateCollection,
  deleteCampaignTemplateSavedSearch,
  getCampaignTemplateCollection,
  getCampaignTemplateSavedSearch,
  listCampaignTemplateCollections,
  listCampaignTemplateSavedSearches,
  listRecentCampaignTemplateViews,
  replaceCampaignTemplateCollectionItems,
  runCampaignTemplateSavedSearch,
  updateCampaignTemplateCollection,
  updateCampaignTemplateSavedSearch,
  type CampaignTemplateCollection,
  type CampaignTemplateCompareItem,
  type CampaignTemplateRecentView,
  type CampaignTemplateSavedSearch,
  type CampaignTemplateSavedSearchFilters,
  type CampaignTemplateSearchResponse,
  type CampaignTemplateSummary,
} from "@/lib/campaign-templates-api";
import { cn } from "@/lib/utils";

import { PreviewImage } from "./preview-image";

interface TemplateDiscoveryToolsProps {
  currentFilters: CampaignTemplateSavedSearchFilters;
  compareSelection: CampaignTemplateSummary[];
  organizerTemplate: CampaignTemplateSummary | null;
  onRemoveCompare: (id: string) => void;
  onClearCompare: () => void;
  onOrganizerTemplateChange: (template: CampaignTemplateSummary | null) => void;
  onApplySavedSearch: (filters: CampaignTemplateSavedSearchFilters) => void;
}

interface StableCreateAttempt {
  fingerprint: string;
  key: string;
}

function isAborted(error: unknown): boolean {
  return (
    (error instanceof ApiError && error.kind === "aborted") ||
    (error instanceof DOMException && error.name === "AbortError")
  );
}

function isPreconditionConflict(error: unknown): boolean {
  return error instanceof ApiError && [412, 428].includes(error.status);
}

function isPersonalStateAccessDenied(error: unknown): boolean {
  return error instanceof ApiError && [401, 403].includes(error.status);
}

function personalStateError(error: unknown, fallback: string): string {
  if (error instanceof ApiError && error.status === 401) {
    return "Your session expired. Sign in again to use your private library.";
  }
  if (error instanceof ApiError && error.status === 403) {
    return "You do not have permission to use personal library tools in this workspace.";
  }
  if (error instanceof ApiError && error.status === 503) {
    return "Personal library tools are temporarily unavailable. Your templates are unchanged.";
  }
  return apiErrorMessage(error, fallback);
}

function createAttemptKey(
  current: StableCreateAttempt | null,
  fingerprint: string,
  operation: "collection" | "saved-search",
): StableCreateAttempt {
  if (current?.fingerprint === fingerprint) return current;
  const stored = readCampaignTemplateDiscoveryCreateRecovery(operation);
  const attempt =
    stored?.fingerprint === fingerprint
      ? { fingerprint: stored.fingerprint, key: stored.key }
      : {
          fingerprint,
          key: campaignTemplateDiscoveryIdempotencyKey(operation),
        };
  writeCampaignTemplateDiscoveryCreateRecovery(operation, attempt);
  return attempt;
}

function replaceCollection(
  items: CampaignTemplateCollection[],
  collection: CampaignTemplateCollection,
): CampaignTemplateCollection[] {
  const found = items.some((candidate) => candidate.id === collection.id);
  return found
    ? items.map((candidate) =>
        candidate.id === collection.id ? collection : candidate,
      )
    : [collection, ...items];
}

function replaceSavedSearch(
  items: CampaignTemplateSavedSearch[],
  savedSearch: CampaignTemplateSavedSearch,
): CampaignTemplateSavedSearch[] {
  const found = items.some((candidate) => candidate.id === savedSearch.id);
  return found
    ? items.map((candidate) =>
        candidate.id === savedSearch.id ? savedSearch : candidate,
      )
    : [savedSearch, ...items];
}

function filterSummary(filters: CampaignTemplateSavedSearchFilters): string {
  const labels = [
    filters.q ? `“${filters.q}”` : "",
    filters.goal,
    filters.category,
    filters.style,
    filters.layout,
    filters.industry,
    filters.source && filters.source !== "all" ? filters.source : "",
    filters.provider ? `Provider: ${filters.provider}` : "",
    filters.kind ? `${humanizeDiscoveryValue(filters.kind)} designs` : "",
    filters.featured === true
      ? "Featured only"
      : filters.featured === false
        ? "Non-featured only"
        : "",
    filters.favorited === true
      ? "Favorites only"
      : filters.favorited === false
        ? "Any favorite status"
        : "",
    filters.archived === "all"
      ? "Active + archived"
      : filters.archived === "archived"
        ? "Archived only"
        : filters.archived === "active"
          ? "Active only"
          : "",
    filters.sort && filters.sort !== "recommended"
      ? `Sort: ${humanizeDiscoveryValue(filters.sort)}`
      : "",
    ...(filters.tags ?? []),
  ].filter(Boolean);
  return labels.length ? labels.join(" · ") : "All newsletter designs";
}

function obsoleteFilterSummary(
  savedSearch: CampaignTemplateSavedSearch,
): string {
  return (savedSearch.obsolete_filters ?? [])
    .map(
      (filter) => `${humanizeDiscoveryValue(filter.field)} “${filter.value}”`,
    )
    .join(", ");
}

export function removeObsoleteSavedSearchFilterPairs(
  filters: CampaignTemplateSavedSearchFilters,
  obsoleteFilters: readonly { field: string; value: string }[],
): CampaignTemplateSavedSearchFilters {
  const next: Record<string, unknown> = {
    ...filters,
    ...(filters.tags ? { tags: [...filters.tags] } : {}),
  };
  for (const obsolete of obsoleteFilters) {
    const current = next[obsolete.field];
    if (Array.isArray(current)) {
      const retained = current.filter(
        (value) => String(value) !== obsolete.value,
      );
      if (retained.length) next[obsolete.field] = retained;
      else delete next[obsolete.field];
      continue;
    }
    if (current !== undefined && String(current) === obsolete.value) {
      delete next[obsolete.field];
    }
  }
  return next as CampaignTemplateSavedSearchFilters;
}

function humanizeDiscoveryValue(value: string): string {
  return value
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

export function TemplateDiscoveryTools({
  currentFilters,
  compareSelection,
  organizerTemplate,
  onRemoveCompare,
  onClearCompare,
  onOrganizerTemplateChange,
  onApplySavedSearch,
}: TemplateDiscoveryToolsProps) {
  const [recentOpen, setRecentOpen] = useState(false);
  const [recent, setRecent] = useState<CampaignTemplateRecentView[]>([]);
  const [recentLoading, setRecentLoading] = useState(false);
  const [recentError, setRecentError] = useState<string | null>(null);
  const recentSequence = useRef(0);
  const recentController = useRef<AbortController | null>(null);

  const [collectionsOpen, setCollectionsOpen] = useState(false);
  const [collections, setCollections] = useState<CampaignTemplateCollection[]>(
    [],
  );
  const [collectionsLoading, setCollectionsLoading] = useState(false);
  const [collectionsError, setCollectionsError] = useState<string | null>(null);
  const [collectionsAccessDenied, setCollectionsAccessDenied] = useState(false);
  const [selectedCollection, setSelectedCollection] =
    useState<CampaignTemplateCollection | null>(null);
  const [collectionName, setCollectionName] = useState("");
  const [collectionDescription, setCollectionDescription] = useState("");
  const [collectionMutating, setCollectionMutating] = useState(false);
  const [editCollectionName, setEditCollectionName] = useState("");
  const [editCollectionDescription, setEditCollectionDescription] =
    useState("");
  const collectionCreateAttempt = useRef<StableCreateAttempt | null>(null);
  const collectionSequence = useRef(0);
  const collectionListController = useRef<AbortController | null>(null);
  const collectionDetailController = useRef<AbortController | null>(null);

  const [savedOpen, setSavedOpen] = useState(false);
  const [savedSearches, setSavedSearches] = useState<
    CampaignTemplateSavedSearch[]
  >([]);
  const [savedLoading, setSavedLoading] = useState(false);
  const [savedError, setSavedError] = useState<string | null>(null);
  const [savedAccessDenied, setSavedAccessDenied] = useState(false);
  const [savedName, setSavedName] = useState("");
  const [savedMutating, setSavedMutating] = useState(false);
  const [editingSaved, setEditingSaved] =
    useState<CampaignTemplateSavedSearch | null>(null);
  const [editSavedName, setEditSavedName] = useState("");
  const [runningSavedId, setRunningSavedId] = useState<string | null>(null);
  const [savedRun, setSavedRun] = useState<{
    id: string;
    result: CampaignTemplateSearchResponse;
  } | null>(null);
  const savedCreateAttempt = useRef<StableCreateAttempt | null>(null);
  const savedSequence = useRef(0);
  const savedListController = useRef<AbortController | null>(null);
  const savedRunController = useRef<AbortController | null>(null);

  const [compareOpen, setCompareOpen] = useState(false);
  const [compareLoading, setCompareLoading] = useState(false);
  const [compareError, setCompareError] = useState<string | null>(null);
  const [comparison, setComparison] = useState<CampaignTemplateCompareItem[]>(
    [],
  );
  const [compareUnavailable, setCompareUnavailable] = useState<{
    identifiers: string[];
    labels: string[];
  } | null>(null);
  const [compareCollectionsAvailable, setCompareCollectionsAvailable] =
    useState<boolean | null>(null);
  const compareController = useRef<AbortController | null>(null);

  const loadRecent = useCallback(async () => {
    const sequence = ++recentSequence.current;
    recentController.current?.abort();
    const controller = new AbortController();
    recentController.current = controller;
    setRecentLoading(true);
    setRecentError(null);
    try {
      const items = await listRecentCampaignTemplateViews(50, {
        signal: controller.signal,
      });
      if (sequence === recentSequence.current) setRecent(items);
    } catch (error) {
      if (!isAborted(error) && sequence === recentSequence.current) {
        setRecentError(
          personalStateError(
            error,
            "Recently viewed designs could not be loaded.",
          ),
        );
      }
    } finally {
      if (sequence === recentSequence.current) setRecentLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!recentOpen) return;
    void loadRecent();
    return () => {
      recentSequence.current += 1;
      recentController.current?.abort();
    };
  }, [loadRecent, recentOpen]);

  const loadCollections = useCallback(async () => {
    const sequence = ++collectionSequence.current;
    collectionListController.current?.abort();
    const controller = new AbortController();
    collectionListController.current = controller;
    setCollectionsLoading(true);
    setCollectionsError(null);
    try {
      const items = await listCampaignTemplateCollections({
        signal: controller.signal,
      });
      if (sequence !== collectionSequence.current) return;
      setCollections(items);
      setCollectionsAccessDenied(false);
      setSelectedCollection((current) => {
        if (!current) return null;
        return items.find((candidate) => candidate.id === current.id) ?? null;
      });
    } catch (error) {
      if (!isAborted(error) && sequence === collectionSequence.current) {
        setCollectionsAccessDenied(isPersonalStateAccessDenied(error));
        setCollectionsError(
          personalStateError(error, "Collections could not be loaded."),
        );
      }
    } finally {
      if (sequence === collectionSequence.current) setCollectionsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!collectionsOpen) return;
    void loadCollections();
    return () => {
      collectionSequence.current += 1;
      collectionListController.current?.abort();
      collectionDetailController.current?.abort();
    };
  }, [collectionsOpen, loadCollections]);

  useEffect(() => {
    if (organizerTemplate) setCollectionsOpen(true);
  }, [organizerTemplate]);

  useEffect(() => {
    const pending = collectionCreateAttempt.current;
    if (!pending) return;
    const name = collectionName.trim();
    const description = collectionDescription.trim();
    const fingerprint = JSON.stringify({
      name,
      ...(description ? { description } : {}),
      ...(organizerTemplate ? { template_ids: [organizerTemplate.id] } : {}),
    });
    if (pending.fingerprint !== fingerprint) {
      collectionCreateAttempt.current = null;
      clearCampaignTemplateDiscoveryCreateRecovery("collection");
    }
  }, [collectionDescription, collectionName, organizerTemplate]);

  const loadSavedSearches = useCallback(async () => {
    const sequence = ++savedSequence.current;
    savedListController.current?.abort();
    const controller = new AbortController();
    savedListController.current = controller;
    setSavedLoading(true);
    setSavedError(null);
    try {
      const items = await listCampaignTemplateSavedSearches({
        signal: controller.signal,
      });
      if (sequence === savedSequence.current) {
        setSavedSearches(items);
        setSavedAccessDenied(false);
      }
    } catch (error) {
      if (!isAborted(error) && sequence === savedSequence.current) {
        setSavedAccessDenied(isPersonalStateAccessDenied(error));
        setSavedError(
          personalStateError(error, "Saved searches could not be loaded."),
        );
      }
    } finally {
      if (sequence === savedSequence.current) setSavedLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!savedOpen) return;
    void loadSavedSearches();
    return () => {
      savedSequence.current += 1;
      savedListController.current?.abort();
      savedRunController.current?.abort();
    };
  }, [loadSavedSearches, savedOpen]);

  useEffect(() => {
    const pending = savedCreateAttempt.current;
    if (!pending) return;
    const fingerprint = JSON.stringify({
      name: savedName.trim(),
      filters: currentFilters,
    });
    if (pending.fingerprint !== fingerprint) {
      savedCreateAttempt.current = null;
      clearCampaignTemplateDiscoveryCreateRecovery("saved-search");
    }
  }, [currentFilters, savedName]);

  useEffect(
    () => () => {
      compareController.current?.abort();
      recentController.current?.abort();
      collectionListController.current?.abort();
      collectionDetailController.current?.abort();
      savedListController.current?.abort();
      savedRunController.current?.abort();
    },
    [],
  );

  const openCollection = async (collection: CampaignTemplateCollection) => {
    collectionDetailController.current?.abort();
    const controller = new AbortController();
    collectionDetailController.current = controller;
    setCollectionMutating(true);
    setCollectionsError(null);
    try {
      const detail = await getCampaignTemplateCollection(collection.id, {
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setSelectedCollection(detail);
      setEditCollectionName(detail.name);
      setEditCollectionDescription(detail.description);
      setCollections((current) => replaceCollection(current, detail));
    } catch (error) {
      if (!isAborted(error)) {
        setCollectionsError(
          personalStateError(error, "This collection could not be opened."),
        );
      }
    } finally {
      if (!controller.signal.aborted) setCollectionMutating(false);
    }
  };

  const refreshCollectionAfterConflict = async (id: string) => {
    try {
      const fresh = await getCampaignTemplateCollection(id);
      setSelectedCollection(fresh);
      setEditCollectionName(fresh.name);
      setEditCollectionDescription(fresh.description);
      setCollections((current) => replaceCollection(current, fresh));
    } catch (error) {
      setCollectionsError(
        personalStateError(
          error,
          "The latest collection could not be reloaded.",
        ),
      );
    }
  };

  const createCollection = async () => {
    const name = collectionName.trim();
    const description = collectionDescription.trim();
    if (!name) {
      setCollectionsError("Give the collection a name.");
      return;
    }
    const input = {
      name,
      ...(description ? { description } : {}),
      ...(organizerTemplate ? { template_ids: [organizerTemplate.id] } : {}),
    };
    const fingerprint = JSON.stringify(input);
    const attempt = createAttemptKey(
      collectionCreateAttempt.current,
      fingerprint,
      "collection",
    );
    collectionCreateAttempt.current = attempt;
    setCollectionMutating(true);
    setCollectionsError(null);
    try {
      const created = await createCampaignTemplateCollection(input, {
        idempotencyKey: attempt.key,
      });
      collectionCreateAttempt.current = null;
      clearCampaignTemplateDiscoveryCreateRecovery("collection");
      setCollections((current) => replaceCollection(current, created));
      setSelectedCollection(created);
      setEditCollectionName(created.name);
      setEditCollectionDescription(created.description);
      setCollectionName("");
      setCollectionDescription("");
      onOrganizerTemplateChange(null);
      toast.success("Collection created");
    } catch (error) {
      setCollectionsError(
        error instanceof ApiError && error.status === 409
          ? "A collection with that name already exists."
          : personalStateError(error, "The collection could not be created."),
      );
    } finally {
      setCollectionMutating(false);
    }
  };

  const saveCollectionDetails = async () => {
    if (!selectedCollection) return;
    const name = editCollectionName.trim();
    if (!name) {
      setCollectionsError("A collection name cannot be empty.");
      return;
    }
    const previous = selectedCollection;
    const optimistic = {
      ...previous,
      name,
      description: editCollectionDescription.trim(),
    };
    setSelectedCollection(optimistic);
    setCollections((current) => replaceCollection(current, optimistic));
    setCollectionMutating(true);
    setCollectionsError(null);
    try {
      const updated = await updateCampaignTemplateCollection(previous, {
        name: optimistic.name,
        description: optimistic.description,
      });
      setSelectedCollection(updated);
      setCollections((current) => replaceCollection(current, updated));
      toast.success("Collection updated");
    } catch (error) {
      setSelectedCollection(previous);
      setCollections((current) => replaceCollection(current, previous));
      if (isPreconditionConflict(error)) {
        setCollectionsError(
          "This collection changed in another tab. Its latest version has been loaded.",
        );
        await refreshCollectionAfterConflict(previous.id);
      } else {
        setCollectionsError(
          personalStateError(error, "The collection could not be updated."),
        );
      }
    } finally {
      setCollectionMutating(false);
    }
  };

  const replaceCollectionItems = async (
    collection: CampaignTemplateCollection,
    nextIds: string[],
  ) => {
    const previous = collection;
    const optimistic = {
      ...collection,
      template_ids: nextIds,
      item_count: nextIds.length,
    };
    setSelectedCollection(optimistic);
    setCollections((current) => replaceCollection(current, optimistic));
    setCollectionMutating(true);
    setCollectionsError(null);
    try {
      const updated = await replaceCampaignTemplateCollectionItems(
        previous,
        nextIds,
      );
      setSelectedCollection(updated);
      setCollections((current) => replaceCollection(current, updated));
      return updated;
    } catch (error) {
      setSelectedCollection(previous);
      setCollections((current) => replaceCollection(current, previous));
      if (isPreconditionConflict(error)) {
        setCollectionsError(
          "Collection membership changed elsewhere. The latest order has been loaded.",
        );
        await refreshCollectionAfterConflict(previous.id);
      } else {
        setCollectionsError(
          personalStateError(
            error,
            "Collection membership could not be saved.",
          ),
        );
      }
      return null;
    } finally {
      setCollectionMutating(false);
    }
  };

  const addOrganizerToCollection = async (
    collection: CampaignTemplateCollection,
  ) => {
    if (!organizerTemplate) return;
    setCollectionMutating(true);
    setCollectionsError(null);
    try {
      const detail = await getCampaignTemplateCollection(collection.id);
      if (detail.template_ids.includes(organizerTemplate.id)) {
        onOrganizerTemplateChange(null);
        toast.info("This design is already in the collection.");
        setSelectedCollection(detail);
        return;
      }
      if (detail.template_ids.length >= 100) {
        setCollectionsError(
          "This collection is full. Remove a design before adding another.",
        );
        return;
      }
      const updated = await replaceCollectionItems(detail, [
        ...detail.template_ids,
        organizerTemplate.id,
      ]);
      if (updated) {
        onOrganizerTemplateChange(null);
        toast.success(`Added to ${updated.name}`);
      }
    } catch (error) {
      setCollectionsError(
        personalStateError(error, "The design could not be added."),
      );
    } finally {
      setCollectionMutating(false);
    }
  };

  const deleteCollection = async (collection: CampaignTemplateCollection) => {
    const previous = collections;
    setCollections((current) =>
      current.filter((candidate) => candidate.id !== collection.id),
    );
    if (selectedCollection?.id === collection.id) setSelectedCollection(null);
    setCollectionMutating(true);
    setCollectionsError(null);
    try {
      await deleteCampaignTemplateCollection(collection);
      toast.success("Collection deleted", {
        description: "The templates themselves were not changed.",
      });
    } catch (error) {
      setCollections(previous);
      if (isPreconditionConflict(error)) {
        setCollectionsError(
          "That collection changed before deletion. Review the latest version and try again.",
        );
        await refreshCollectionAfterConflict(collection.id);
      } else {
        setCollectionsError(
          personalStateError(error, "The collection could not be deleted."),
        );
      }
    } finally {
      setCollectionMutating(false);
    }
  };

  const createSavedSearch = async () => {
    const name = savedName.trim();
    if (!name) {
      setSavedError("Give this search a name.");
      return;
    }
    const input = { name, filters: currentFilters };
    const fingerprint = JSON.stringify(input);
    const attempt = createAttemptKey(
      savedCreateAttempt.current,
      fingerprint,
      "saved-search",
    );
    savedCreateAttempt.current = attempt;
    setSavedMutating(true);
    setSavedError(null);
    try {
      const created = await createCampaignTemplateSavedSearch(input, {
        idempotencyKey: attempt.key,
      });
      savedCreateAttempt.current = null;
      clearCampaignTemplateDiscoveryCreateRecovery("saved-search");
      setSavedSearches((current) => replaceSavedSearch(current, created));
      setSavedName("");
      toast.success("Search saved");
    } catch (error) {
      setSavedError(
        error instanceof ApiError && error.status === 409
          ? "A saved search with that name already exists."
          : personalStateError(error, "This search could not be saved."),
      );
    } finally {
      setSavedMutating(false);
    }
  };

  const refreshSavedSearchAfterConflict = async (id: string) => {
    try {
      const fresh = await getCampaignTemplateSavedSearch(id);
      setSavedSearches((current) => replaceSavedSearch(current, fresh));
      setEditingSaved(fresh);
      setEditSavedName(fresh.name);
    } catch (error) {
      setSavedError(
        personalStateError(
          error,
          "The latest saved search could not be loaded.",
        ),
      );
    }
  };

  const saveSavedSearchName = async () => {
    if (!editingSaved) return;
    const name = editSavedName.trim();
    if (!name) {
      setSavedError("A saved search name cannot be empty.");
      return;
    }
    const previous = editingSaved;
    const optimistic = { ...previous, name };
    setEditingSaved(optimistic);
    setSavedSearches((current) => replaceSavedSearch(current, optimistic));
    setSavedMutating(true);
    setSavedError(null);
    try {
      const updated = await updateCampaignTemplateSavedSearch(previous, {
        name,
      });
      setEditingSaved(updated);
      setSavedSearches((current) => replaceSavedSearch(current, updated));
      toast.success("Saved search renamed");
    } catch (error) {
      setEditingSaved(previous);
      setSavedSearches((current) => replaceSavedSearch(current, previous));
      if (isPreconditionConflict(error)) {
        setSavedError(
          "This saved search changed in another tab. Its latest version has been loaded.",
        );
        await refreshSavedSearchAfterConflict(previous.id);
      } else {
        setSavedError(
          personalStateError(error, "The saved search could not be renamed."),
        );
      }
    } finally {
      setSavedMutating(false);
    }
  };

  const removeObsoleteSavedSearchFilters = async () => {
    const obsoleteFilters = editingSaved?.obsolete_filters;
    if (!editingSaved || !obsoleteFilters?.length) return;
    const previous = editingSaved;
    const cleanedFilters = removeObsoleteSavedSearchFilterPairs(
      previous.filters,
      obsoleteFilters,
    );
    const optimistic = {
      ...previous,
      filters: cleanedFilters,
      obsolete_filters: [],
    };
    setEditingSaved(optimistic);
    setSavedSearches((current) => replaceSavedSearch(current, optimistic));
    setSavedRun(null);
    setSavedMutating(true);
    setSavedError(null);
    try {
      const updated = await updateCampaignTemplateSavedSearch(previous, {
        filters: cleanedFilters,
      });
      setEditingSaved(updated);
      setSavedSearches((current) => replaceSavedSearch(current, updated));
      toast.success("Unavailable filters removed");
    } catch (error) {
      setEditingSaved(previous);
      setSavedSearches((current) => replaceSavedSearch(current, previous));
      if (isPreconditionConflict(error)) {
        setSavedError(
          "This saved search changed in another tab. Its latest filters have been loaded.",
        );
        await refreshSavedSearchAfterConflict(previous.id);
      } else {
        setSavedError(
          personalStateError(
            error,
            "The unavailable filters could not be removed.",
          ),
        );
      }
    } finally {
      setSavedMutating(false);
    }
  };

  const deleteSavedSearch = async (
    savedSearch: CampaignTemplateSavedSearch,
  ) => {
    const previous = savedSearches;
    setSavedSearches((current) =>
      current.filter((candidate) => candidate.id !== savedSearch.id),
    );
    if (editingSaved?.id === savedSearch.id) setEditingSaved(null);
    setSavedMutating(true);
    setSavedError(null);
    try {
      await deleteCampaignTemplateSavedSearch(savedSearch);
      toast.success("Saved search deleted");
    } catch (error) {
      setSavedSearches(previous);
      if (isPreconditionConflict(error)) {
        setSavedError(
          "That search changed before deletion. Review the latest version and try again.",
        );
        await refreshSavedSearchAfterConflict(savedSearch.id);
      } else {
        setSavedError(
          personalStateError(error, "The saved search could not be deleted."),
        );
      }
    } finally {
      setSavedMutating(false);
    }
  };

  const runSavedSearch = async (savedSearch: CampaignTemplateSavedSearch) => {
    setRunningSavedId(savedSearch.id);
    setSavedError(null);
    setSavedRun(null);
    savedRunController.current?.abort();
    const controller = new AbortController();
    savedRunController.current = controller;
    try {
      const result = await runCampaignTemplateSavedSearch(
        savedSearch.id,
        { perPage: 8 },
        { signal: controller.signal },
      );
      setSavedRun({ id: savedSearch.id, result });
    } catch (error) {
      if (!isAborted(error)) {
        setSavedError(
          personalStateError(error, "This saved search could not be run."),
        );
      }
    } finally {
      setRunningSavedId(null);
    }
  };

  const runComparison = async () => {
    if (compareSelection.length < 2 || compareSelection.length > 4) return;
    compareController.current?.abort();
    const controller = new AbortController();
    compareController.current = controller;
    setCompareOpen(true);
    setCompareLoading(true);
    setCompareError(null);
    setCompareUnavailable(null);
    setCompareCollectionsAvailable(null);
    setComparison([]);
    try {
      const [response, availableCollections] = await Promise.all([
        compareCampaignTemplates(
          compareSelection.map((template) => template.id),
          { signal: controller.signal },
        ),
        listCampaignTemplateCollections({ signal: controller.signal })
          .then((items) => ({ available: true, items }))
          .catch((error: unknown) => {
            if (isAborted(error)) throw error;
            return { available: false, items: collections };
          }),
      ]);
      if (!controller.signal.aborted) {
        setCollections(availableCollections.items);
        setCompareCollectionsAvailable(availableCollections.available);
        setComparison(response.items);
        if (response.unavailable_identifiers.length) {
          const unavailable = new Set(response.unavailable_identifiers);
          const labels = response.unavailable_identifiers.map(
            (identifier) =>
              compareSelection.find((template) => template.id === identifier)
                ?.name ?? identifier,
          );
          setCompareUnavailable({
            identifiers: response.unavailable_identifiers,
            labels,
          });
          for (const identifier of unavailable) onRemoveCompare(identifier);
        }
      }
    } catch (error) {
      const aborted = isAborted(error) || controller.signal.aborted;
      if (!aborted) {
        setCompareError(
          apiErrorMessage(
            error,
            "These templates could not be compared. One may no longer be available.",
          ),
        );
        setCompareLoading(false);
      }
      controller.abort();
    } finally {
      if (!controller.signal.aborted) setCompareLoading(false);
    }
  };

  const clearRecent = async (id?: string) => {
    const previous = recent;
    setRecent((current) =>
      id ? current.filter((view) => view.template.id !== id) : [],
    );
    setRecentError(null);
    try {
      await clearRecentCampaignTemplateViews(id);
    } catch (error) {
      setRecent(previous);
      setRecentError(
        personalStateError(error, "Recent history could not be cleared."),
      );
    }
  };

  const comparisonRows = useMemo(
    () =>
      [
        ["Goal", (template: CampaignTemplateSummary) => template.goal],
        ["Category", (template: CampaignTemplateSummary) => template.category],
        ["Style", (template: CampaignTemplateSummary) => template.style],
        ["Industry", (template: CampaignTemplateSummary) => template.industry],
        [
          "Layout",
          (template: CampaignTemplateSummary) => template.layout_archetype,
        ],
        [
          "Desktop preview",
          (template: CampaignTemplateSummary) =>
            campaignTemplateCapabilities(template).has_desktop_preview
              ? "Available"
              : "Not available",
        ],
        [
          "Mobile preview",
          (template: CampaignTemplateSummary) =>
            campaignTemplateCapabilities(template).has_mobile_preview
              ? "Available"
              : "Not available",
        ],
        [
          "Capability",
          (template: CampaignTemplateSummary) => {
            const capabilities = campaignTemplateCapabilities(template);
            if (template.template_kind === "reference") {
              return capabilities.can_adapt
                ? "Adaptation only"
                : "Preview only";
            }
            return capabilities.can_edit_directly
              ? "Directly editable"
              : campaignTemplateCapabilityLabel(template);
          },
        ],
        [
          "Favorite",
          (template: CampaignTemplateSummary) =>
            template.is_favorited ? "Saved" : "Not saved",
        ],
        [
          "Ingestion quality",
          (template: CampaignTemplateSummary) =>
            typeof template.quality_score === "number" &&
            Number.isFinite(template.quality_score)
              ? `${Math.round(Math.min(1, Math.max(0, template.quality_score)) * 100)}%`
              : "Not provided",
        ],
        [
          "Collections",
          (template: CampaignTemplateSummary) => {
            if (compareCollectionsAvailable === false) return "Unavailable";
            const memberships = collections
              .filter((collection) =>
                collection.template_ids.includes(template.id),
              )
              .map((collection) => collection.name);
            return memberships.length ? memberships.join(", ") : "None";
          },
        ],
        [
          "Review",
          (template: CampaignTemplateSummary) =>
            template.review_status
              ? humanizeDiscoveryValue(template.review_status)
              : "Not provided",
        ],
        [
          "Provenance",
          (template: CampaignTemplateSummary) =>
            template.source_brand ||
            template.provider ||
            template.source ||
            "Not provided",
        ],
      ] satisfies Array<
        [string, (template: CampaignTemplateSummary) => string | undefined]
      >,
    [collections, compareCollectionsAvailable],
  );

  return (
    <>
      <section
        aria-label="Personal template library tools"
        className="rounded-xl border bg-gradient-to-r from-primary/[0.06] via-background to-background p-4 shadow-sm"
      >
        <div className="flex flex-col justify-between gap-3 lg:flex-row lg:items-center">
          <div>
            <p className="flex items-center gap-2 text-sm font-medium">
              <FolderHeart className="h-4 w-4 text-primary" aria-hidden />
              Your design shelf
            </p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              Pick up where you left off, organize references, or save these
              filters. This shelf is private to you in this workspace.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="min-h-11 sm:min-h-8"
              onClick={() => setRecentOpen(true)}
            >
              <Clock3 aria-hidden /> Recent
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="min-h-11 sm:min-h-8"
              onClick={() => setCollectionsOpen(true)}
            >
              <FolderHeart aria-hidden /> Collections
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="min-h-11 sm:min-h-8"
              onClick={() => setSavedOpen(true)}
            >
              <Bookmark aria-hidden /> Saved searches
            </Button>
            <Button
              type="button"
              size="sm"
              className="min-h-11 sm:min-h-8"
              onClick={() => setSavedOpen(true)}
            >
              <Save aria-hidden /> Save this search
            </Button>
          </div>
        </div>
      </section>

      {compareSelection.length ? (
        <section
          aria-label="Template comparison tray"
          className="sticky bottom-3 z-30 rounded-xl border border-primary/30 bg-background/95 p-3 shadow-lg backdrop-blur motion-reduce:transition-none"
        >
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium" aria-live="polite">
                {compareSelection.length} of 4 ready to compare
              </p>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {compareSelection.map((template) => (
                  <Badge
                    key={template.id}
                    variant="secondary"
                    className="max-w-full gap-1 font-normal"
                  >
                    <span className="truncate">{template.name}</span>
                    <button
                      type="button"
                      aria-label={`Remove ${template.name} from comparison`}
                      onClick={() => onRemoveCompare(template.id)}
                      className="-m-2 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:-m-1 sm:h-7 sm:w-7"
                    >
                      <X className="h-3 w-3" aria-hidden />
                    </button>
                  </Badge>
                ))}
              </div>
            </div>
            <div className="flex shrink-0 gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="min-h-11 sm:min-h-8"
                onClick={onClearCompare}
              >
                Clear
              </Button>
              <Button
                type="button"
                size="sm"
                className="min-h-11 sm:min-h-8"
                disabled={compareSelection.length < 2}
                onClick={() => void runComparison()}
              >
                <Columns3 aria-hidden /> Compare
              </Button>
            </div>
          </div>
          {compareSelection.length === 1 ? (
            <p className="mt-2 text-xs text-muted-foreground">
              Choose one more design. Comparison supports 2–4 templates.
            </p>
          ) : null}
        </section>
      ) : null}

      <Dialog open={recentOpen} onOpenChange={setRecentOpen}>
        <DialogContent className="max-w-3xl motion-reduce:duration-0">
          <DialogHeader>
            <DialogTitle>Recently viewed designs</DialogTitle>
            <DialogDescription>
              Recorded only after a template detail page loads successfully.
              Clearing this list never deletes a template.
            </DialogDescription>
          </DialogHeader>
          <div aria-live="polite">
            {recentLoading ? (
              <div className="grid gap-2" aria-label="Loading recent designs">
                {Array.from({ length: 4 }, (_, index) => (
                  <div
                    key={index}
                    className="h-16 animate-pulse rounded-lg bg-muted motion-reduce:animate-none"
                  />
                ))}
              </div>
            ) : recentError ? (
              <Alert variant="destructive">
                <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
                  <span>{recentError}</span>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => void loadRecent()}
                  >
                    <RefreshCw aria-hidden /> Try again
                  </Button>
                </AlertDescription>
              </Alert>
            ) : recent.length === 0 ? (
              <Card>
                <CardContent className="py-10 text-center">
                  <Clock3 className="mx-auto h-7 w-7 text-muted-foreground" />
                  <p className="mt-3 font-medium">No recent designs yet</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Open a design to start a private, easy-to-resume history.
                  </p>
                </CardContent>
              </Card>
            ) : (
              <ul className="divide-y rounded-lg border">
                {recent.map((view) => (
                  <li
                    key={view.template.id}
                    className="flex items-center gap-3 p-3"
                  >
                    <div className="min-w-0 flex-1">
                      <Link
                        href={`/app/templates/${view.template.id}`}
                        className="font-medium underline-offset-4 hover:underline"
                      >
                        {view.template.name}
                      </Link>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        Last opened <RelativeTime iso={view.last_viewed_at} /> ·
                        Viewed {view.view_count.toLocaleString()}×
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`Remove ${view.template.name} from recent history`}
                      onClick={() => void clearRecent(view.template.id)}
                    >
                      <X aria-hidden />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <DialogFooter>
            {recent.length ? (
              <ConfirmDialog
                title="Clear recent history?"
                description="This removes only your private viewing history. Templates and collections stay unchanged."
                confirmLabel="Clear history"
                confirmVariant="destructive"
                onConfirm={() => clearRecent()}
                trigger={
                  <Button type="button" variant="outline">
                    <Trash2 aria-hidden /> Clear all
                  </Button>
                }
              />
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={collectionsOpen}
        onOpenChange={(open) => {
          setCollectionsOpen(open);
          if (!open) onOrganizerTemplateChange(null);
        }}
      >
        <DialogContent className="max-w-5xl motion-reduce:duration-0">
          <DialogHeader>
            <DialogTitle>
              {organizerTemplate
                ? `Add “${organizerTemplate.name}” to a collection`
                : "Template collections"}
            </DialogTitle>
            <DialogDescription>
              Personal, ordered design boards. Removing a collection or member
              never changes the underlying template.
            </DialogDescription>
          </DialogHeader>

          {collectionsError ? (
            <Alert variant="destructive">
              <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
                <span>{collectionsError}</span>
                {!collectionsAccessDenied ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => void loadCollections()}
                  >
                    <RefreshCw aria-hidden /> Try again
                  </Button>
                ) : null}
              </AlertDescription>
            </Alert>
          ) : null}

          <div className="grid min-h-0 gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
            <div className="space-y-3">
              <Card>
                <CardContent className="space-y-3 p-4">
                  <div>
                    <p className="text-sm font-medium">New collection</p>
                    <p className="text-xs text-muted-foreground">
                      {organizerTemplate
                        ? "The selected design will be its first item."
                        : "Create an empty board, then add designs from card actions."}
                    </p>
                  </div>
                  <Input
                    aria-label="New collection name"
                    placeholder="e.g. Friday digest ideas"
                    maxLength={120}
                    value={collectionName}
                    disabled={collectionsAccessDenied}
                    onChange={(event) => setCollectionName(event.target.value)}
                  />
                  <Textarea
                    aria-label="New collection description"
                    placeholder="Optional note"
                    maxLength={1000}
                    rows={2}
                    value={collectionDescription}
                    disabled={collectionsAccessDenied}
                    onChange={(event) =>
                      setCollectionDescription(event.target.value)
                    }
                  />
                  <Button
                    type="button"
                    className="w-full"
                    loading={collectionMutating}
                    disabled={collectionsAccessDenied}
                    onClick={() => void createCollection()}
                  >
                    <Plus aria-hidden /> Create collection
                  </Button>
                </CardContent>
              </Card>

              <div
                className="max-h-[340px] space-y-2 overflow-y-auto pr-1"
                aria-label="Your collections"
              >
                {collectionsLoading ? (
                  Array.from({ length: 3 }, (_, index) => (
                    <div
                      key={index}
                      className="h-14 animate-pulse rounded-lg bg-muted motion-reduce:animate-none"
                    />
                  ))
                ) : collections.length === 0 ? (
                  <p className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
                    No collections yet.
                  </p>
                ) : (
                  collections.map((collection) => (
                    <div
                      key={collection.id}
                      className={cn(
                        "flex items-center gap-2 rounded-lg border p-2",
                        selectedCollection?.id === collection.id &&
                          "border-primary bg-primary/5",
                      )}
                    >
                      <button
                        type="button"
                        aria-pressed={selectedCollection?.id === collection.id}
                        className="min-w-0 flex-1 rounded px-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        onClick={() => void openCollection(collection)}
                      >
                        <span className="block truncate text-sm font-medium">
                          {collection.name}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {collection.item_count} design
                          {collection.item_count === 1 ? "" : "s"}
                        </span>
                      </button>
                      {organizerTemplate ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={
                            collectionMutating || collection.item_count >= 100
                          }
                          aria-label={`Add ${organizerTemplate.name} to ${collection.name}`}
                          onClick={() =>
                            void addOrganizerToCollection(collection)
                          }
                        >
                          Add
                        </Button>
                      ) : null}
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className="min-w-0">
              {selectedCollection ? (
                <Card>
                  <CardContent className="space-y-5 p-4 sm:p-5">
                    <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
                      <div className="min-w-0 flex-1 space-y-2">
                        <Input
                          aria-label="Collection name"
                          maxLength={120}
                          value={editCollectionName}
                          onChange={(event) =>
                            setEditCollectionName(event.target.value)
                          }
                        />
                        <Textarea
                          aria-label="Collection description"
                          maxLength={1000}
                          rows={2}
                          placeholder="Optional note"
                          value={editCollectionDescription}
                          onChange={(event) =>
                            setEditCollectionDescription(event.target.value)
                          }
                        />
                      </div>
                      <div className="flex gap-2">
                        <Button
                          type="button"
                          size="sm"
                          loading={collectionMutating}
                          onClick={() => void saveCollectionDetails()}
                        >
                          Save
                        </Button>
                        <ConfirmDialog
                          title={`Delete “${selectedCollection.name}”?`}
                          description="Only this personal collection is deleted. Its templates remain available everywhere else."
                          confirmLabel="Delete collection"
                          confirmVariant="destructive"
                          onConfirm={() => deleteCollection(selectedCollection)}
                          trigger={
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              aria-label={`Delete ${selectedCollection.name}`}
                            >
                              <Trash2 aria-hidden />
                            </Button>
                          }
                        />
                      </div>
                    </div>

                    <div>
                      <div className="mb-2 flex items-center justify-between gap-2">
                        <p className="text-sm font-medium">
                          Ordered designs ({selectedCollection.item_count}/100)
                        </p>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={collectionMutating}
                          onClick={() =>
                            void openCollection(selectedCollection)
                          }
                        >
                          <RefreshCw aria-hidden /> Refresh
                        </Button>
                      </div>
                      {selectedCollection.template_ids.length === 0 ? (
                        <div className="rounded-lg border border-dashed p-8 text-center">
                          <FolderPlus className="mx-auto h-6 w-6 text-muted-foreground" />
                          <p className="mt-2 text-sm font-medium">
                            This collection is empty
                          </p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            Use “Add to collection” from any template card.
                          </p>
                        </div>
                      ) : (
                        <ol className="divide-y rounded-lg border">
                          {selectedCollection.template_ids.map((id, index) => {
                            const template = selectedCollection.items?.find(
                              (candidate) => candidate.id === id,
                            );
                            return (
                              <li
                                key={id}
                                className="flex items-center gap-2 p-2.5"
                              >
                                <span className="w-6 text-center text-xs tabular-nums text-muted-foreground">
                                  {index + 1}
                                </span>
                                <div className="min-w-0 flex-1">
                                  {template ? (
                                    <Link
                                      href={`/app/templates/${template.id}`}
                                      className="truncate text-sm font-medium underline-offset-4 hover:underline"
                                    >
                                      {template.name}
                                    </Link>
                                  ) : (
                                    <>
                                      <p className="truncate text-sm font-medium">
                                        Unavailable design
                                      </p>
                                      <p className="text-xs text-muted-foreground">
                                        It remains in the saved order but may be
                                        archived or no longer visible to you.
                                      </p>
                                    </>
                                  )}
                                </div>
                                <div
                                  className="flex"
                                  role="group"
                                  aria-label={`Reorder ${template?.name ?? "unavailable design"}`}
                                >
                                  <Button
                                    type="button"
                                    size="icon"
                                    variant="ghost"
                                    disabled={index === 0 || collectionMutating}
                                    aria-label="Move up"
                                    onClick={() => {
                                      const ids = [
                                        ...selectedCollection.template_ids,
                                      ];
                                      [ids[index - 1], ids[index]] = [
                                        ids[index],
                                        ids[index - 1],
                                      ];
                                      void replaceCollectionItems(
                                        selectedCollection,
                                        ids,
                                      );
                                    }}
                                  >
                                    <ChevronUp aria-hidden />
                                  </Button>
                                  <Button
                                    type="button"
                                    size="icon"
                                    variant="ghost"
                                    disabled={
                                      index ===
                                        selectedCollection.template_ids.length -
                                          1 || collectionMutating
                                    }
                                    aria-label="Move down"
                                    onClick={() => {
                                      const ids = [
                                        ...selectedCollection.template_ids,
                                      ];
                                      [ids[index], ids[index + 1]] = [
                                        ids[index + 1],
                                        ids[index],
                                      ];
                                      void replaceCollectionItems(
                                        selectedCollection,
                                        ids,
                                      );
                                    }}
                                  >
                                    <ChevronDown aria-hidden />
                                  </Button>
                                  <Button
                                    type="button"
                                    size="icon"
                                    variant="ghost"
                                    disabled={collectionMutating}
                                    aria-label={`Remove ${template?.name ?? "unavailable design"} from collection`}
                                    onClick={() =>
                                      void replaceCollectionItems(
                                        selectedCollection,
                                        selectedCollection.template_ids.filter(
                                          (candidate) => candidate !== id,
                                        ),
                                      )
                                    }
                                  >
                                    <X aria-hidden />
                                  </Button>
                                </div>
                              </li>
                            );
                          })}
                        </ol>
                      )}
                    </div>
                  </CardContent>
                </Card>
              ) : (
                <div className="grid min-h-72 place-items-center rounded-lg border border-dashed p-8 text-center">
                  <div>
                    <FolderHeart className="mx-auto h-8 w-8 text-muted-foreground" />
                    <p className="mt-3 font-medium">Choose a collection</p>
                    <p className="mt-1 max-w-sm text-sm text-muted-foreground">
                      Open one to rename it, reorder members, or remove designs
                      safely.
                    </p>
                  </div>
                </div>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={savedOpen} onOpenChange={setSavedOpen}>
        <DialogContent className="max-w-4xl motion-reduce:duration-0">
          <DialogHeader>
            <DialogTitle>Saved searches</DialogTitle>
            <DialogDescription>
              Save the current URL-backed filters, run them later, or restore
              them to the browser without losing Back/Forward behavior.
            </DialogDescription>
          </DialogHeader>

          {savedError ? (
            <Alert variant="destructive">
              <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
                <span>{savedError}</span>
                {!savedAccessDenied ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => void loadSavedSearches()}
                  >
                    <RefreshCw aria-hidden /> Try again
                  </Button>
                ) : null}
              </AlertDescription>
            </Alert>
          ) : null}

          <Card>
            <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-end">
              <label className="grid min-w-0 flex-1 gap-1 text-xs font-medium text-muted-foreground">
                Name this search
                <Input
                  maxLength={120}
                  placeholder="e.g. Minimal ecommerce newsletters"
                  value={savedName}
                  disabled={savedAccessDenied}
                  onChange={(event) => setSavedName(event.target.value)}
                />
              </label>
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium text-muted-foreground">
                  Current filters
                </p>
                <p className="mt-1 truncate text-sm">
                  {filterSummary(currentFilters)}
                </p>
              </div>
              <Button
                type="button"
                loading={savedMutating}
                disabled={savedAccessDenied}
                onClick={() => void createSavedSearch()}
              >
                <Save aria-hidden /> Save current
              </Button>
            </CardContent>
          </Card>

          <div className="grid min-h-0 gap-4 md:grid-cols-[minmax(0,1fr)_300px]">
            <div
              className="max-h-[420px] space-y-2 overflow-y-auto pr-1"
              aria-live="polite"
            >
              {savedLoading ? (
                Array.from({ length: 4 }, (_, index) => (
                  <div
                    key={index}
                    className="h-20 animate-pulse rounded-lg bg-muted motion-reduce:animate-none"
                  />
                ))
              ) : savedSearches.length === 0 ? (
                <div className="rounded-lg border border-dashed p-8 text-center">
                  <Bookmark className="mx-auto h-7 w-7 text-muted-foreground" />
                  <p className="mt-3 font-medium">No saved searches yet</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Your current filters are ready to save above.
                  </p>
                </div>
              ) : (
                savedSearches.map((savedSearch) => (
                  <Card key={savedSearch.id}>
                    <CardContent className="flex items-start gap-3 p-3">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">
                          {savedSearch.name}
                        </p>
                        <p className="mt-1 truncate text-xs text-muted-foreground">
                          {filterSummary(savedSearch.filters)}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          Updated <RelativeTime iso={savedSearch.updated_at} />
                        </p>
                        {savedSearch.obsolete_filters?.length ? (
                          <p className="mt-1 text-xs font-medium text-amber-700 dark:text-amber-300">
                            Needs an update:{" "}
                            {obsoleteFilterSummary(savedSearch)} is no longer
                            available.
                          </p>
                        ) : null}
                      </div>
                      <div className="flex flex-wrap justify-end gap-1">
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          loading={runningSavedId === savedSearch.id}
                          onClick={() => void runSavedSearch(savedSearch)}
                        >
                          <Search aria-hidden /> Run
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setEditingSaved(savedSearch);
                            setEditSavedName(savedSearch.name);
                          }}
                        >
                          Manage
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                ))
              )}
            </div>

            <div className="space-y-3">
              {savedRun ? (
                <Card>
                  <CardContent className="space-y-3 p-4">
                    <div>
                      <p className="text-sm font-medium">
                        {savedRun.result.total.toLocaleString()} matching design
                        {savedRun.result.total === 1 ? "" : "s"}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Previewing the first{" "}
                        {savedRun.result.items.length.toLocaleString()}.
                      </p>
                    </div>
                    {savedRun.result.items.length ? (
                      <ul className="space-y-1 text-sm">
                        {savedRun.result.items.slice(0, 5).map((template) => (
                          <li key={template.id} className="truncate">
                            {template.name}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        No designs currently match.
                      </p>
                    )}
                    <Button
                      type="button"
                      className="w-full"
                      disabled={Boolean(
                        savedSearches.find(
                          (candidate) => candidate.id === savedRun.id,
                        )?.obsolete_filters?.length,
                      )}
                      title={
                        savedSearches.find(
                          (candidate) => candidate.id === savedRun.id,
                        )?.obsolete_filters?.length
                          ? "Replace the unavailable filters before opening this saved search in the browser."
                          : undefined
                      }
                      onClick={() => {
                        const savedSearch = savedSearches.find(
                          (candidate) => candidate.id === savedRun.id,
                        );
                        if (!savedSearch) return;
                        onApplySavedSearch(savedSearch.filters);
                        setSavedOpen(false);
                      }}
                    >
                      Open in browser
                    </Button>
                  </CardContent>
                </Card>
              ) : null}

              {editingSaved ? (
                <Card>
                  <CardContent className="space-y-3 p-4">
                    <p className="text-sm font-medium">Manage saved search</p>
                    <Input
                      aria-label="Saved search name"
                      maxLength={120}
                      value={editSavedName}
                      onChange={(event) => setEditSavedName(event.target.value)}
                    />
                    <p className="text-xs leading-5 text-muted-foreground">
                      {filterSummary(editingSaved.filters)}
                    </p>
                    {editingSaved.obsolete_filters?.length ? (
                      <Alert variant="warning">
                        <AlertDescription>
                          This definition still preserves unavailable filters:{" "}
                          {obsoleteFilterSummary(editingSaved)}. Remove only
                          those unavailable values, or leave the saved
                          definition unchanged.
                        </AlertDescription>
                      </Alert>
                    ) : null}
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        size="sm"
                        loading={savedMutating}
                        onClick={() => void saveSavedSearchName()}
                      >
                        Save name
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={Boolean(
                          editingSaved.obsolete_filters?.length,
                        )}
                        title={
                          editingSaved.obsolete_filters?.length
                            ? "Replace the unavailable filters before applying this saved search."
                            : undefined
                        }
                        onClick={() => {
                          onApplySavedSearch(editingSaved.filters);
                          setSavedOpen(false);
                        }}
                      >
                        Apply filters
                      </Button>
                      {editingSaved.obsolete_filters?.length ? (
                        <ConfirmDialog
                          title={`Remove unavailable filters from “${editingSaved.name}”?`}
                          description={`Only ${obsoleteFilterSummary(
                            editingSaved,
                          )} will be removed. Every other saved filter stays unchanged. The cleaned definition will be: ${filterSummary(
                            removeObsoleteSavedSearchFilterPairs(
                              editingSaved.filters,
                              editingSaved.obsolete_filters,
                            ),
                          )}.`}
                          confirmLabel="Remove unavailable values"
                          onConfirm={removeObsoleteSavedSearchFilters}
                          trigger={
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              disabled={savedMutating}
                            >
                              Remove unavailable filters
                            </Button>
                          }
                        />
                      ) : null}
                      <ConfirmDialog
                        title={`Delete “${editingSaved.name}”?`}
                        description="Only this saved filter definition is removed. Templates and your current browser URL are unchanged."
                        confirmLabel="Delete saved search"
                        confirmVariant="destructive"
                        onConfirm={() => deleteSavedSearch(editingSaved)}
                        trigger={
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            aria-label={`Delete ${editingSaved.name}`}
                          >
                            <Trash2 aria-hidden />
                          </Button>
                        }
                      />
                    </div>
                  </CardContent>
                </Card>
              ) : (
                <p className="rounded-lg border border-dashed p-5 text-center text-sm text-muted-foreground">
                  Run a search to preview fresh results, or choose Manage to
                  rename, apply, or delete it.
                </p>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={compareOpen}
        onOpenChange={(open) => {
          setCompareOpen(open);
          if (!open) compareController.current?.abort();
        }}
      >
        <DialogContent className="max-w-6xl motion-reduce:duration-0">
          <DialogHeader>
            <DialogTitle>Compare newsletter designs</DialogTitle>
            <DialogDescription>
              A side-by-side view of the latest versions you can access. Open
              any design for its complete preview and actions.
            </DialogDescription>
          </DialogHeader>

          {compareUnavailable ? (
            <Alert variant="warning" role="status" aria-live="assertive">
              <AlertDescription>
                Removed{" "}
                {compareUnavailable.labels.length === 1
                  ? compareUnavailable.labels[0]
                  : compareUnavailable.labels.join(", ")}{" "}
                from comparison because{" "}
                {compareUnavailable.identifiers.length === 1
                  ? "it is"
                  : "they are"}{" "}
                no longer available. Your comparison tray was updated.
              </AlertDescription>
            </Alert>
          ) : null}

          {compareLoading ? (
            <div
              className="h-72 animate-pulse rounded-lg bg-muted motion-reduce:animate-none"
              aria-label="Loading template comparison"
            />
          ) : compareError ? (
            <Alert variant="destructive">
              <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
                <span>{compareError}</span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void runComparison()}
                >
                  <RefreshCw aria-hidden /> Try again
                </Button>
              </AlertDescription>
            </Alert>
          ) : comparison.length >= 2 ? (
            <div
              role="region"
              aria-label="Side-by-side template attributes"
              tabIndex={0}
              className="overflow-x-auto rounded-lg border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <table className="w-full min-w-[720px] border-collapse text-sm">
                <caption className="sr-only">
                  Side-by-side template attributes
                </caption>
                <thead>
                  <tr className="border-b bg-muted/40">
                    <th scope="col" className="w-32 p-3 text-left">
                      Attribute
                    </th>
                    {comparison.map((item) => (
                      <th
                        key={item.requested_identifier}
                        scope="col"
                        className="min-w-48 p-3 text-left align-top"
                      >
                        <div className="space-y-2">
                          <PreviewImage
                            src={campaignTemplateThumbnailUrl(item.template)}
                            alt=""
                            className="h-28 w-full rounded object-cover object-top"
                            wrapperClassName="min-h-0 rounded border"
                          />
                          <Link
                            href={`/app/templates/${item.template.id}`}
                            className="block font-medium underline-offset-4 hover:underline"
                          >
                            {item.template.name}
                          </Link>
                        </div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {comparisonRows.map(([label, value]) => (
                    <tr key={label} className="border-b last:border-0">
                      <th
                        scope="row"
                        className="bg-muted/20 p-3 text-left font-medium"
                      >
                        {label}
                      </th>
                      {comparison.map((item) => (
                        <td
                          key={item.requested_identifier}
                          className="p-3 text-muted-foreground"
                        >
                          {value(item.template) || "—"}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="border-t bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                Collection membership is private to this account and loaded
                separately from the catalogue comparison.
              </p>
            </div>
          ) : compareUnavailable ? (
            <Card>
              <CardContent className="py-10 text-center">
                <Columns3 className="mx-auto h-7 w-7 text-muted-foreground" />
                <p className="mt-3 font-medium">
                  Choose another available design
                </p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Comparison needs at least two available designs. The
                  unavailable selection has already been removed.
                </p>
              </CardContent>
            </Card>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
