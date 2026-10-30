import {
  type ReactElement,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import { useTabsInteraction } from "../../hooks/useTabsInteraction";
import type { CampaignTemplate, TemplateGoal } from "../../lib/api-client";
import {
  clearCampaignTemplateDiscoveryCreate,
  prepareCampaignTemplateDiscoveryCreate,
  type CampaignTemplateDiscoveryCreateAttempt,
  type CampaignTemplateDiscoveryCreatePreparation,
} from "../../lib/campaign-template-discovery-recovery";
import {
  campaignTemplateDiscoveryApi,
  newCampaignTemplateDiscoveryIdempotencyKey,
  type CampaignTemplateCollection,
  type CampaignTemplateRecentView,
  type CampaignTemplateSavedSearch,
  type CampaignTemplateSavedSearchFilters,
  type CampaignTemplateSavedSearchResults,
} from "../../lib/api/campaign-template-discovery";
import { TemplateComparePanel } from "./TemplateComparePanel";
import {
  currentSavedSearchFilters,
  type DiscoveryFailure,
  FailureNotice,
  isConcurrencyFailure,
  isDeniedFailure,
  isMissingFailure,
  readableDate,
  requestFailure,
  ResourceTruth,
  savedSearchSummary,
  TEMPLATE_UUID_RE,
  templateLabel,
  upsertById,
} from "./template-discovery-shared";
import type { TemplateSource } from "./TemplateLibraryPrimitives";
import type {
  CampaignTemplateDiscoveryLifecycle,
  CampaignTemplateDiscoverySort,
} from "../../lib/campaign-template-discovery-preferences";

import "../../styles-template-discovery.css";

type DiscoveryTab = "recent" | "compare" | "collections" | "searches";

interface TemplateDiscoveryHubProps {
  compareSelection: string[];
  currentGoal: TemplateGoal | "";
  currentLifecycle: CampaignTemplateDiscoveryLifecycle;
  currentQuery: string;
  currentSort: CampaignTemplateDiscoverySort;
  currentSource: TemplateSource;
  recoveryScope: string | null;
  recentRefreshToken: number;
  rows: CampaignTemplate[] | null;
  onApplySavedSearch: (filters: CampaignTemplateSavedSearchFilters) => void;
  onCompareSelectionChange: (ids: string[]) => void;
  onOpenTemplate: (template: CampaignTemplate) => void;
}

interface PanelProps {
  enabled: boolean;
}

const TAB_ORDER: DiscoveryTab[] = [
  "recent",
  "compare",
  "collections",
  "searches",
];
const TAB_LABELS: Record<DiscoveryTab, string> = {
  recent: "Recent",
  compare: "Compare",
  collections: "Collections",
  searches: "Saved searches",
};

function createRecoveryFailure(
  preparation: Extract<
    CampaignTemplateDiscoveryCreatePreparation,
    { ok: false }
  >,
): DiscoveryFailure {
  if (preparation.reason === "identity-unavailable") {
    return {
      code: "template_discovery_identity_unavailable",
      message:
        "Your signed-in workspace identity is still resolving. No create request was sent; wait a moment and retry.",
    };
  }
  if (preparation.reason === "recovery-record-invalid") {
    return {
      code: "template_discovery_recovery_invalid",
      message:
        "A previous create may be unresolved, but its local recovery marker is unreadable. No request was sent. Reconcile the server list before clearing app data or trying a different draft.",
    };
  }
  return {
    code: "template_discovery_recovery_unavailable",
    message:
      "Moosewave could not durably save a safe retry identity on this device, so no create request was sent. Restore local storage access and retry.",
  };
}
function RecentPanel({
  enabled,
  recentRefreshToken,
  onOpenTemplate,
}: PanelProps & {
  recentRefreshToken: number;
  onOpenTemplate: (template: CampaignTemplate) => void;
}): ReactElement {
  const [items, setItems] = useState<CampaignTemplateRecentView[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<DiscoveryFailure | null>(null);
  const [lastVerifiedAt, setLastVerifiedAt] = useState<number | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const sequence = useRef(0);
  const previousRefreshToken = useRef(recentRefreshToken);

  const load = useCallback(async (): Promise<void> => {
    const requestId = ++sequence.current;
    setLoading(true);
    setFailure(null);
    try {
      const response = await campaignTemplateDiscoveryApi.recent(24);
      if (requestId !== sequence.current) return;
      if (response.error) {
        const nextFailure = requestFailure(response.error);
        setFailure(nextFailure);
        if (isDeniedFailure(nextFailure)) setItems(null);
        return;
      }
      setItems(response.data.items);
      setLastVerifiedAt(Date.now());
    } catch {
      if (requestId === sequence.current) {
        setFailure({
          message:
            "Recent templates could not be reached. Check the connection and retry.",
        });
      }
    } finally {
      if (requestId === sequence.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (enabled && items === null) void load();
  }, [enabled, items, load]);

  useEffect(() => {
    if (previousRefreshToken.current === recentRefreshToken) return;
    previousRefreshToken.current = recentRefreshToken;
    if (enabled) void load();
  }, [enabled, load, recentRefreshToken]);

  useEffect(
    () => () => {
      sequence.current += 1;
    },
    [],
  );

  const clear = async (id?: string): Promise<void> => {
    if (removingId) return;
    setRemovingId(id ?? "all");
    setFailure(null);
    try {
      const response = await campaignTemplateDiscoveryApi.clearRecent(id);
      if (response.error) {
        setFailure(requestFailure(response.error));
        return;
      }
      setItems((current) =>
        id ? (current ?? []).filter((item) => item.template.id !== id) : [],
      );
      setLastVerifiedAt(Date.now());
      setConfirmClear(false);
    } catch {
      setFailure({
        message:
          "Recent-template history was not changed because the request did not complete.",
      });
    } finally {
      setRemovingId(null);
    }
  };

  return (
    <section
      aria-labelledby="tpl-discovery-recent-heading"
      className="tpl-discovery-panel"
    >
      <div className="tpl-discovery-panel-heading">
        <div>
          <h3 id="tpl-discovery-recent-heading">Recently opened</h3>
          <p>
            A template appears here only after its current detail record has
            been verified and opened.
          </p>
        </div>
        <button
          type="button"
          className="btn btn-sm"
          disabled={loading}
          onClick={() => void load()}
        >
          {loading ? "Refreshing…" : "Refresh recent"}
        </button>
      </div>
      <ResourceTruth
        count={items?.length ?? null}
        label="recent template records"
        lastVerifiedAt={lastVerifiedAt}
        loading={loading}
        stale={loading && items !== null}
      />
      <FailureNotice
        failure={failure}
        loading={loading}
        onRetry={() => void load()}
      />
      {items === null && loading ? (
        <div className="tpl-discovery-loading" role="status">
          Loading your recent templates…
        </div>
      ) : items === null ? (
        <div className="empty-state" role="status">
          <h4>Recent templates unavailable</h4>
          <p>No unverified history is shown.</p>
        </div>
      ) : items.length === 0 ? (
        <div className="empty-state">
          <h4>No recent templates yet</h4>
          <p>Open a catalog template to start this workspace-only history.</p>
        </div>
      ) : (
        <>
          <ul
            className="tpl-discovery-list"
            aria-label="Recently opened templates"
          >
            {items.map((item) => (
              <li key={item.template.id}>
                <div>
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => onOpenTemplate(item.template)}
                  >
                    {item.template.name}
                  </button>
                  <p>
                    Last opened{" "}
                    <time dateTime={item.last_viewed_at}>
                      {readableDate(item.last_viewed_at)}
                    </time>{" "}
                    · opened {item.view_count.toLocaleString()}{" "}
                    {item.view_count === 1 ? "time" : "times"}
                  </p>
                </div>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={removingId !== null}
                  aria-label={`Remove ${item.template.name} from recent templates`}
                  onClick={() => void clear(item.template.id)}
                >
                  {removingId === item.template.id ? "Removing…" : "Remove"}
                </button>
              </li>
            ))}
          </ul>
          <div className="tpl-discovery-destructive-row">
            {confirmClear ? (
              <div role="group" aria-label="Confirm clearing recent templates">
                <span>This removes all personal recent-template history.</span>
                <button
                  type="button"
                  className="btn btn-sm btn-danger"
                  disabled={removingId !== null}
                  onClick={() => void clear()}
                >
                  {removingId === "all" ? "Clearing…" : "Clear all recent"}
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={removingId !== null}
                  onClick={() => setConfirmClear(false)}
                >
                  Keep history
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="btn btn-sm"
                disabled={removingId !== null}
                onClick={() => setConfirmClear(true)}
              >
                Clear recent history…
              </button>
            )}
          </div>
        </>
      )}
    </section>
  );
}

function CollectionsPanel({
  compareSelection,
  enabled,
  recoveryScope,
  rows,
  onOpenTemplate,
}: PanelProps &
  Pick<
    TemplateDiscoveryHubProps,
    "compareSelection" | "recoveryScope" | "rows" | "onOpenTemplate"
  >): ReactElement {
  const [collections, setCollections] = useState<
    CampaignTemplateCollection[] | null
  >(null);
  const [selectedId, setSelectedId] = useState("");
  const [detail, setDetail] = useState<CampaignTemplateCollection | null>(null);
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [mutationBusy, setMutationBusy] = useState(false);
  const [failure, setFailure] = useState<DiscoveryFailure | null>(null);
  const [status, setStatus] = useState("");
  const [lastVerifiedAt, setLastVerifiedAt] = useState<number | null>(null);
  const [createName, setCreateName] = useState("");
  const [createDescription, setCreateDescription] = useState("");
  const [includeComparison, setIncludeComparison] = useState(false);
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [pickerId, setPickerId] = useState("");
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const createAttempt = useRef<CampaignTemplateDiscoveryCreateAttempt | null>(
    null,
  );
  const previousRecoveryScope = useRef(recoveryScope);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const detailHeadingRef = useRef<HTMLHeadingElement>(null);
  const listSequence = useRef(0);
  const detailSequence = useRef(0);
  const createTemplateIds = useMemo(
    () =>
      includeComparison
        ? compareSelection
            .filter((id) => TEMPLATE_UUID_RE.test(id))
            .map((id) => id.trim())
        : [],
    [compareSelection, includeComparison],
  );
  const createSignature = useMemo(
    () =>
      JSON.stringify({
        name: createName.trim(),
        description: createDescription.trim(),
        template_ids: createTemplateIds,
      }),
    [createDescription, createName, createTemplateIds],
  );

  const templates = useMemo(() => {
    const map = new Map((rows ?? []).map((row) => [row.id, row]));
    for (const item of detail?.items ?? []) map.set(item.id, item);
    return map;
  }, [detail?.items, rows]);

  const replaceCollection = useCallback(
    (collection: CampaignTemplateCollection): void => {
      setCollections((current) => upsertById(current ?? [], collection));
      setDetail(collection);
      setEditName(collection.name);
      setEditDescription(collection.description);
      setLastVerifiedAt(Date.now());
    },
    [],
  );

  const loadCollections = useCallback(async (): Promise<void> => {
    const requestId = ++listSequence.current;
    setLoading(true);
    setFailure(null);
    try {
      const response = await campaignTemplateDiscoveryApi.listCollections();
      if (requestId !== listSequence.current) return;
      if (response.error) {
        const nextFailure = requestFailure(response.error);
        setFailure(nextFailure);
        if (isDeniedFailure(nextFailure)) {
          setCollections(null);
          setDetail(null);
          setSelectedId("");
        }
        return;
      }
      setCollections(response.data.items);
      setLastVerifiedAt(Date.now());
      setSelectedId((current) => {
        if (
          current &&
          response.data.items.some((collection) => collection.id === current)
        ) {
          return current;
        }
        return response.data.items[0]?.id ?? "";
      });
    } catch {
      if (requestId === listSequence.current) {
        setFailure({
          message:
            "Collections could not be reached. Previously verified collections remain visible.",
        });
      }
    } finally {
      if (requestId === listSequence.current) setLoading(false);
    }
  }, []);

  const loadDetail = useCallback(
    async (
      id: string,
      conflictMessage?: string,
    ): Promise<CampaignTemplateCollection | null> => {
      const requestId = ++detailSequence.current;
      setDetailLoading(true);
      try {
        const response = await campaignTemplateDiscoveryApi.getCollection(id);
        if (requestId !== detailSequence.current) return null;
        if (response.error) {
          const nextFailure = requestFailure(response.error);
          if (isMissingFailure(nextFailure)) {
            setCollections(
              (current) =>
                current?.filter((collection) => collection.id !== id) ?? null,
            );
            setDetail(null);
            setSelectedId("");
            setStatus(
              "This collection no longer exists. The collection list was reconciled.",
            );
          } else {
            setFailure(nextFailure);
          }
          return null;
        }
        replaceCollection(response.data);
        if (conflictMessage) setStatus(conflictMessage);
        return response.data;
      } catch {
        if (requestId === detailSequence.current) {
          setFailure({
            message:
              "The collection detail could not be verified. No change was applied.",
          });
        }
        return null;
      } finally {
        if (requestId === detailSequence.current) setDetailLoading(false);
      }
    },
    [replaceCollection],
  );

  useEffect(() => {
    if (enabled && collections === null) void loadCollections();
  }, [collections, enabled, loadCollections]);

  useEffect(() => {
    if (!enabled || !selectedId) {
      if (!selectedId) setDetail(null);
      return;
    }
    if (detail?.id !== selectedId) void loadDetail(selectedId);
  }, [detail?.id, enabled, loadDetail, selectedId]);

  useEffect(
    () => () => {
      listSequence.current += 1;
      detailSequence.current += 1;
    },
    [],
  );

  useEffect(() => {
    const previous = previousRecoveryScope.current;
    if (previous !== recoveryScope) {
      clearCampaignTemplateDiscoveryCreate(previous, "collection");
      createAttempt.current = null;
      previousRecoveryScope.current = recoveryScope;
    }
  }, [recoveryScope]);

  useEffect(() => {
    const attempt = createAttempt.current;
    if (!mutationBusy && attempt && attempt.signature !== createSignature) {
      clearCampaignTemplateDiscoveryCreate(recoveryScope, "collection");
      createAttempt.current = null;
    }
  }, [createSignature, mutationBusy, recoveryScope]);

  const recoverConflict = async (
    id: string,
    message: string,
  ): Promise<void> => {
    await loadDetail(
      id,
      `${message} The latest version is loaded; review it before retrying.`,
    );
  };

  const create = async (): Promise<void> => {
    if (mutationBusy) return;
    const payload = {
      name: createName,
      description: createDescription,
      template_ids: createTemplateIds,
    };
    setMutationBusy(true);
    setFailure(null);
    setStatus("");
    try {
      const preparation = await prepareCampaignTemplateDiscoveryCreate(
        recoveryScope,
        "collection",
        createSignature,
        newCampaignTemplateDiscoveryIdempotencyKey,
      );
      if (!preparation.ok) {
        setFailure(createRecoveryFailure(preparation));
        return;
      }
      createAttempt.current = preparation.attempt;
      const response = await campaignTemplateDiscoveryApi.createCollection(
        payload,
        {
          idempotencyKey: preparation.attempt.key,
        },
      );
      if (response.error) {
        const nextFailure = requestFailure(response.error);
        setFailure(nextFailure);
        if (
          nextFailure.status === 409 ||
          nextFailure.code === "name_conflict"
        ) {
          nameInputRef.current?.focus();
        }
        return;
      }
      clearCampaignTemplateDiscoveryCreate(recoveryScope, "collection");
      createAttempt.current = null;
      replaceCollection(response.data);
      setSelectedId(response.data.id);
      setCreateName("");
      setCreateDescription("");
      setIncludeComparison(false);
      setStatus(`Collection “${response.data.name}” created.`);
      window.setTimeout(() => detailHeadingRef.current?.focus(), 0);
    } catch {
      setFailure({
        message:
          "The create result is unknown. Your draft and request identity were preserved; retry the unchanged draft safely.",
      });
    } finally {
      setMutationBusy(false);
    }
  };

  const saveMetadata = async (): Promise<void> => {
    if (!detail || mutationBusy) return;
    setMutationBusy(true);
    setFailure(null);
    setStatus("");
    try {
      const response = await campaignTemplateDiscoveryApi.updateCollection(
        detail.id,
        { name: editName, description: editDescription },
        { ifMatch: detail.etag },
      );
      if (response.error) {
        const nextFailure = requestFailure(response.error);
        if (isConcurrencyFailure(nextFailure)) {
          await recoverConflict(
            detail.id,
            "The collection changed elsewhere, so your edit was not applied.",
          );
        } else {
          setFailure(nextFailure);
          if (
            nextFailure.status === 409 ||
            nextFailure.code === "name_conflict"
          ) {
            nameInputRef.current?.focus();
          }
        }
        return;
      }
      replaceCollection(response.data);
      setStatus("Collection details saved.");
    } catch {
      setFailure({
        message:
          "The collection edit did not complete. Reload before retrying if its outcome is uncertain.",
      });
    } finally {
      setMutationBusy(false);
    }
  };

  const replaceItems = async (
    templateIds: string[],
    successMessage: string,
  ): Promise<void> => {
    if (!detail || mutationBusy) return;
    setMutationBusy(true);
    setFailure(null);
    setStatus("");
    try {
      const response =
        await campaignTemplateDiscoveryApi.replaceCollectionItems(
          detail.id,
          templateIds,
          { ifMatch: detail.etag },
        );
      if (response.error) {
        const nextFailure = requestFailure(response.error);
        if (isConcurrencyFailure(nextFailure)) {
          await recoverConflict(
            detail.id,
            "The collection order changed elsewhere, so your change was not applied.",
          );
        } else {
          setFailure(nextFailure);
        }
        return;
      }
      replaceCollection(response.data);
      setPickerId("");
      setStatus(successMessage);
    } catch {
      setFailure({
        message:
          "The collection items were not changed because the request did not complete.",
      });
    } finally {
      setMutationBusy(false);
    }
  };

  const moveItem = (index: number, direction: -1 | 1): void => {
    if (!detail) return;
    const target = index + direction;
    if (target < 0 || target >= detail.template_ids.length) return;
    const next = [...detail.template_ids];
    [next[index], next[target]] = [next[target], next[index]];
    void replaceItems(next, "Collection order saved.");
  };

  const deleteCollection = async (): Promise<void> => {
    if (!detail || mutationBusy) return;
    setMutationBusy(true);
    setFailure(null);
    try {
      const response = await campaignTemplateDiscoveryApi.deleteCollection(
        detail.id,
        {
          ifMatch: detail.etag,
        },
      );
      if (response.error) {
        const nextFailure = requestFailure(response.error);
        if (isConcurrencyFailure(nextFailure)) {
          await recoverConflict(
            detail.id,
            "The collection changed elsewhere, so it was not deleted.",
          );
        } else if (isMissingFailure(nextFailure)) {
          setCollections(
            (current) =>
              current?.filter((item) => item.id !== detail.id) ?? null,
          );
          setDetail(null);
          setSelectedId("");
          setStatus("The already-removed collection was reconciled.");
        } else {
          setFailure(nextFailure);
        }
        return;
      }
      setCollections(
        (current) => current?.filter((item) => item.id !== detail.id) ?? [],
      );
      setDetail(null);
      setSelectedId("");
      setDeleteConfirm(false);
      setStatus("Collection deleted.");
    } catch {
      setFailure({
        message:
          "The delete result is unknown. Reload collections before trying again.",
      });
    } finally {
      setMutationBusy(false);
    }
  };

  return (
    <section
      aria-labelledby="tpl-discovery-collections-heading"
      className="tpl-discovery-panel"
    >
      <div className="tpl-discovery-panel-heading">
        <div>
          <h3 id="tpl-discovery-collections-heading">Personal collections</h3>
          <p>
            Keep an ordered shortlist for this workspace. Collection changes use
            exact versions, so another session cannot be overwritten.
          </p>
        </div>
        <button
          type="button"
          className="btn btn-sm"
          disabled={loading || mutationBusy}
          onClick={() => void loadCollections()}
        >
          {loading ? "Refreshing…" : "Refresh collections"}
        </button>
      </div>
      <ResourceTruth
        count={collections?.length ?? null}
        label="personal collections"
        lastVerifiedAt={lastVerifiedAt}
        loading={loading}
        stale={loading && collections !== null}
      />
      <FailureNotice
        failure={failure}
        loading={loading || mutationBusy}
        onRetry={() => void loadCollections()}
      />
      {status ? (
        <p className="tpl-discovery-status" role="status">
          {status}
        </p>
      ) : null}
      <div className="tpl-collection-layout">
        <div className="tpl-discovery-sidebar">
          <h4>Your collections</h4>
          {collections === null && loading ? (
            <p role="status">Loading collections…</p>
          ) : collections === null ? (
            <p>No verified collection list is available.</p>
          ) : collections.length === 0 ? (
            <p>No collections yet.</p>
          ) : (
            <ul aria-label="Template collections">
              {collections.map((collection) => (
                <li key={collection.id}>
                  <button
                    type="button"
                    aria-current={
                      selectedId === collection.id ? "true" : undefined
                    }
                    onClick={() => {
                      setFailure(null);
                      setStatus("");
                      setDeleteConfirm(false);
                      setSelectedId(collection.id);
                    }}
                  >
                    <span>{collection.name}</span>
                    <small>
                      {collection.item_count}{" "}
                      {collection.item_count === 1 ? "template" : "templates"}
                    </small>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <form
            className="tpl-discovery-form"
            onSubmit={(event) => {
              event.preventDefault();
              void create();
            }}
          >
            <h4>Create collection</h4>
            <label htmlFor="tpl-new-collection-name">Name</label>
            <input
              ref={nameInputRef}
              id="tpl-new-collection-name"
              value={createName}
              maxLength={120}
              required
              disabled={mutationBusy}
              onChange={(event) => setCreateName(event.target.value)}
            />
            <label htmlFor="tpl-new-collection-description">
              Description <span className="muted">(optional)</span>
            </label>
            <textarea
              id="tpl-new-collection-description"
              value={createDescription}
              maxLength={1_000}
              rows={3}
              disabled={mutationBusy}
              onChange={(event) => setCreateDescription(event.target.value)}
            />
            {compareSelection.length ? (
              <label className="tpl-discovery-check">
                <input
                  type="checkbox"
                  checked={includeComparison}
                  disabled={mutationBusy}
                  onChange={(event) =>
                    setIncludeComparison(event.target.checked)
                  }
                />
                Start with {compareSelection.length} compared{" "}
                {compareSelection.length === 1 ? "template" : "templates"}
              </label>
            ) : null}
            <button
              type="submit"
              className="btn btn-sm btn-primary"
              disabled={mutationBusy || !createName.trim()}
            >
              {mutationBusy ? "Working…" : "Create collection"}
            </button>
          </form>
        </div>
        <div className="tpl-collection-detail">
          {!selectedId ? (
            <div className="empty-state">
              <h4>Choose or create a collection</h4>
              <p>Its ordered templates and current version will appear here.</p>
            </div>
          ) : detailLoading && detail?.id !== selectedId ? (
            <p role="status">Loading verified collection detail…</p>
          ) : detail ? (
            <>
              <h4 ref={detailHeadingRef} tabIndex={-1}>
                Manage {detail.name}
              </h4>
              {detailLoading ? (
                <p role="status">
                  Refreshing this collection; the verified version below stays
                  visible.
                </p>
              ) : null}
              <p className="tpl-discovery-version">
                Version {detail.version} · updated{" "}
                <time dateTime={detail.updated_at}>
                  {readableDate(detail.updated_at)}
                </time>
              </p>
              <div className="tpl-discovery-form">
                <label htmlFor="tpl-edit-collection-name">Name</label>
                <input
                  id="tpl-edit-collection-name"
                  value={editName}
                  maxLength={120}
                  onChange={(event) => setEditName(event.target.value)}
                />
                <label htmlFor="tpl-edit-collection-description">
                  Description
                </label>
                <textarea
                  id="tpl-edit-collection-description"
                  value={editDescription}
                  maxLength={1_000}
                  rows={3}
                  onChange={(event) => setEditDescription(event.target.value)}
                />
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={
                    mutationBusy ||
                    (!editName.trim() && !editDescription.trim()) ||
                    (editName === detail.name &&
                      editDescription === detail.description)
                  }
                  onClick={() => void saveMetadata()}
                >
                  Save collection details
                </button>
              </div>
              <div className="tpl-discovery-picker">
                <label htmlFor="tpl-collection-template-picker">
                  Add a loaded template
                </label>
                <div>
                  <select
                    id="tpl-collection-template-picker"
                    value={pickerId}
                    disabled={mutationBusy || detail.template_ids.length >= 100}
                    onChange={(event) => setPickerId(event.target.value)}
                  >
                    <option value="">Choose a template</option>
                    {(rows ?? [])
                      .filter(
                        (row) =>
                          TEMPLATE_UUID_RE.test(row.id) &&
                          !detail.template_ids.includes(row.id),
                      )
                      .map((row) => (
                        <option key={row.id} value={row.id}>
                          {row.name}
                        </option>
                      ))}
                  </select>
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={!pickerId || mutationBusy}
                    onClick={() =>
                      void replaceItems(
                        [...detail.template_ids, pickerId],
                        "Template added to the end of the collection.",
                      )
                    }
                  >
                    Add
                  </button>
                </div>
              </div>
              {detail.template_ids.length === 0 ? (
                <div className="empty-state">
                  <h5>This collection is empty</h5>
                  <p>Add a loaded catalog template above.</p>
                </div>
              ) : (
                <ol
                  className="tpl-collection-items"
                  aria-label={`Ordered templates in ${detail.name}`}
                >
                  {detail.template_ids.map((id, index) => {
                    const template = templates.get(id);
                    return (
                      <li key={id}>
                        <span className="tpl-collection-position">
                          {index + 1}
                        </span>
                        <div>
                          {template ? (
                            <button
                              type="button"
                              className="link-button"
                              onClick={() => onOpenTemplate(template)}
                            >
                              {template.name}
                            </button>
                          ) : (
                            <strong>Template not in the loaded catalog</strong>
                          )}
                          <small>{id}</small>
                        </div>
                        <div className="tpl-collection-item-actions">
                          <button
                            type="button"
                            className="btn btn-sm"
                            disabled={index === 0 || mutationBusy}
                            aria-label={`Move ${templateLabel(id, templates)} up`}
                            onClick={() => moveItem(index, -1)}
                          >
                            Up
                          </button>
                          <button
                            type="button"
                            className="btn btn-sm"
                            disabled={
                              index === detail.template_ids.length - 1 ||
                              mutationBusy
                            }
                            aria-label={`Move ${templateLabel(id, templates)} down`}
                            onClick={() => moveItem(index, 1)}
                          >
                            Down
                          </button>
                          <button
                            type="button"
                            className="btn btn-sm"
                            disabled={mutationBusy}
                            aria-label={`Remove ${templateLabel(id, templates)} from ${detail.name}`}
                            onClick={() =>
                              void replaceItems(
                                detail.template_ids.filter(
                                  (candidate) => candidate !== id,
                                ),
                                "Template removed from the collection.",
                              )
                            }
                          >
                            Remove
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ol>
              )}
              <div className="tpl-discovery-destructive-row">
                {deleteConfirm ? (
                  <div role="group" aria-label="Confirm collection deletion">
                    <span>
                      Delete “{detail.name}”? Templates themselves are kept.
                    </span>
                    <button
                      type="button"
                      className="btn btn-sm btn-danger"
                      disabled={mutationBusy}
                      onClick={() => void deleteCollection()}
                    >
                      {mutationBusy ? "Deleting…" : "Delete collection"}
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={mutationBusy}
                      onClick={() => setDeleteConfirm(false)}
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={mutationBusy}
                    onClick={() => setDeleteConfirm(true)}
                  >
                    Delete collection…
                  </button>
                )}
              </div>
            </>
          ) : (
            <div className="empty-state" role="status">
              <h4>Collection detail unavailable</h4>
              <p>Retry the collection list before making a change.</p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function SavedSearchesPanel({
  currentGoal,
  currentLifecycle,
  currentQuery,
  currentSort,
  currentSource,
  enabled,
  onApplySavedSearch,
  onOpenTemplate,
  recoveryScope,
}: PanelProps &
  Pick<
    TemplateDiscoveryHubProps,
    | "currentGoal"
    | "currentLifecycle"
    | "currentQuery"
    | "currentSort"
    | "currentSource"
    | "onApplySavedSearch"
    | "onOpenTemplate"
    | "recoveryScope"
  >): ReactElement {
  const [searches, setSearches] = useState<
    CampaignTemplateSavedSearch[] | null
  >(null);
  const [selectedId, setSelectedId] = useState("");
  const [detail, setDetail] = useState<CampaignTemplateSavedSearch | null>(
    null,
  );
  const [results, setResults] =
    useState<CampaignTemplateSavedSearchResults | null>(null);
  const [resultsOwnerId, setResultsOwnerId] = useState("");
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [resultsLoading, setResultsLoading] = useState(false);
  const [mutationBusy, setMutationBusy] = useState(false);
  const [failure, setFailure] = useState<DiscoveryFailure | null>(null);
  const [resultsFailure, setResultsFailure] = useState<DiscoveryFailure | null>(
    null,
  );
  const [status, setStatus] = useState("");
  const [lastVerifiedAt, setLastVerifiedAt] = useState<number | null>(null);
  const [createName, setCreateName] = useState("");
  const [editName, setEditName] = useState("");
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const createAttempt = useRef<CampaignTemplateDiscoveryCreateAttempt | null>(
    null,
  );
  const previousRecoveryScope = useRef(recoveryScope);
  const createNameRef = useRef<HTMLInputElement>(null);
  const detailHeadingRef = useRef<HTMLHeadingElement>(null);
  const listSequence = useRef(0);
  const detailSequence = useRef(0);
  const resultsSequence = useRef(0);
  const filters = useMemo(
    () =>
      currentSavedSearchFilters({
        currentGoal,
        currentLifecycle,
        currentQuery,
        currentSort,
        currentSource,
      }),
    [currentGoal, currentLifecycle, currentQuery, currentSort, currentSource],
  );
  const createSignature = useMemo(
    () => JSON.stringify({ name: createName.trim(), filters }),
    [createName, filters],
  );

  const replaceSearch = useCallback(
    (search: CampaignTemplateSavedSearch): void => {
      setSearches((current) => upsertById(current ?? [], search));
      setDetail(search);
      setEditName(search.name);
      setLastVerifiedAt(Date.now());
    },
    [],
  );

  const loadSearches = useCallback(async (): Promise<void> => {
    const requestId = ++listSequence.current;
    setLoading(true);
    setFailure(null);
    try {
      const response = await campaignTemplateDiscoveryApi.listSavedSearches();
      if (requestId !== listSequence.current) return;
      if (response.error) {
        const nextFailure = requestFailure(response.error);
        setFailure(nextFailure);
        if (isDeniedFailure(nextFailure)) {
          setSearches(null);
          setDetail(null);
          setSelectedId("");
        }
        return;
      }
      setSearches(response.data.items);
      setLastVerifiedAt(Date.now());
      setSelectedId((current) => {
        if (
          current &&
          response.data.items.some((search) => search.id === current)
        ) {
          return current;
        }
        return response.data.items[0]?.id ?? "";
      });
    } catch {
      if (requestId === listSequence.current) {
        setFailure({
          message:
            "Saved searches could not be reached. Previously verified searches remain visible.",
        });
      }
    } finally {
      if (requestId === listSequence.current) setLoading(false);
    }
  }, []);

  const loadDetail = useCallback(
    async (
      id: string,
      conflictMessage?: string,
    ): Promise<CampaignTemplateSavedSearch | null> => {
      const requestId = ++detailSequence.current;
      setDetailLoading(true);
      try {
        const response = await campaignTemplateDiscoveryApi.getSavedSearch(id);
        if (requestId !== detailSequence.current) return null;
        if (response.error) {
          const nextFailure = requestFailure(response.error);
          if (isMissingFailure(nextFailure)) {
            setSearches(
              (current) =>
                current?.filter((search) => search.id !== id) ?? null,
            );
            setDetail(null);
            setSelectedId("");
            setResults(null);
            setResultsOwnerId("");
            setStatus(
              "This saved search no longer exists. The list was reconciled.",
            );
          } else {
            setFailure(nextFailure);
          }
          return null;
        }
        replaceSearch(response.data);
        if (conflictMessage) setStatus(conflictMessage);
        return response.data;
      } catch {
        if (requestId === detailSequence.current) {
          setFailure({
            message:
              "The saved-search detail could not be verified. No change was applied.",
          });
        }
        return null;
      } finally {
        if (requestId === detailSequence.current) setDetailLoading(false);
      }
    },
    [replaceSearch],
  );

  useEffect(() => {
    if (enabled && searches === null) void loadSearches();
  }, [enabled, loadSearches, searches]);

  useEffect(() => {
    if (!enabled || !selectedId) {
      if (!selectedId) setDetail(null);
      return;
    }
    if (detail?.id !== selectedId) void loadDetail(selectedId);
  }, [detail?.id, enabled, loadDetail, selectedId]);

  useEffect(
    () => () => {
      listSequence.current += 1;
      detailSequence.current += 1;
      resultsSequence.current += 1;
    },
    [],
  );

  useEffect(() => {
    const previous = previousRecoveryScope.current;
    if (previous !== recoveryScope) {
      clearCampaignTemplateDiscoveryCreate(previous, "saved-search");
      createAttempt.current = null;
      previousRecoveryScope.current = recoveryScope;
    }
  }, [recoveryScope]);

  useEffect(() => {
    const attempt = createAttempt.current;
    if (!mutationBusy && attempt && attempt.signature !== createSignature) {
      clearCampaignTemplateDiscoveryCreate(recoveryScope, "saved-search");
      createAttempt.current = null;
    }
  }, [createSignature, mutationBusy, recoveryScope]);

  const recoverConflict = async (
    id: string,
    message: string,
  ): Promise<void> => {
    await loadDetail(
      id,
      `${message} The latest version is loaded; review it before retrying.`,
    );
  };

  const create = async (): Promise<void> => {
    if (mutationBusy) return;
    const payload = { name: createName, filters };
    setMutationBusy(true);
    setFailure(null);
    setStatus("");
    try {
      const preparation = await prepareCampaignTemplateDiscoveryCreate(
        recoveryScope,
        "saved-search",
        createSignature,
        newCampaignTemplateDiscoveryIdempotencyKey,
      );
      if (!preparation.ok) {
        setFailure(createRecoveryFailure(preparation));
        return;
      }
      createAttempt.current = preparation.attempt;
      const response = await campaignTemplateDiscoveryApi.createSavedSearch(
        payload,
        {
          idempotencyKey: preparation.attempt.key,
        },
      );
      if (response.error) {
        const nextFailure = requestFailure(response.error);
        setFailure(nextFailure);
        if (
          nextFailure.status === 409 ||
          nextFailure.code === "name_conflict"
        ) {
          createNameRef.current?.focus();
        }
        return;
      }
      clearCampaignTemplateDiscoveryCreate(recoveryScope, "saved-search");
      createAttempt.current = null;
      replaceSearch(response.data);
      setSelectedId(response.data.id);
      setCreateName("");
      setStatus(`Saved search “${response.data.name}” created.`);
      window.setTimeout(() => detailHeadingRef.current?.focus(), 0);
    } catch {
      setFailure({
        message:
          "The create result is unknown. Your name, filters, and request identity were preserved for a safe retry.",
      });
    } finally {
      setMutationBusy(false);
    }
  };

  const update = async (useCurrentFilters: boolean): Promise<void> => {
    if (!detail || mutationBusy) return;
    setMutationBusy(true);
    setFailure(null);
    setStatus("");
    try {
      const response = await campaignTemplateDiscoveryApi.updateSavedSearch(
        detail.id,
        {
          name: editName,
          ...(useCurrentFilters ? { filters } : {}),
        },
        { ifMatch: detail.etag },
      );
      if (response.error) {
        const nextFailure = requestFailure(response.error);
        if (isConcurrencyFailure(nextFailure)) {
          await recoverConflict(
            detail.id,
            "The saved search changed elsewhere, so your edit was not applied.",
          );
        } else {
          setFailure(nextFailure);
        }
        return;
      }
      replaceSearch(response.data);
      setResults(null);
      setResultsOwnerId("");
      setStatus(
        useCurrentFilters
          ? "Saved search updated with the current library filters."
          : "Saved-search name updated.",
      );
    } catch {
      setFailure({
        message:
          "The saved-search edit did not complete. Reload before retrying if its outcome is uncertain.",
      });
    } finally {
      setMutationBusy(false);
    }
  };

  const run = async (
    search: CampaignTemplateSavedSearch,
    cursor?: string,
  ): Promise<void> => {
    if (resultsLoading) return;
    const requestId = ++resultsSequence.current;
    setResultsLoading(true);
    setResultsFailure(null);
    try {
      const response = await campaignTemplateDiscoveryApi.savedSearchResults(
        search.id,
        {
          ...(cursor ? { cursor } : {}),
          per_page: 24,
        },
      );
      if (requestId !== resultsSequence.current) return;
      if (response.error) {
        setResultsFailure(requestFailure(response.error));
        return;
      }
      setResults((current) =>
        cursor && resultsOwnerId === search.id && current
          ? {
              ...response.data,
              items: [
                ...current.items,
                ...response.data.items.filter(
                  (item) =>
                    !current.items.some((existing) => existing.id === item.id),
                ),
              ],
            }
          : response.data,
      );
      setResultsOwnerId(search.id);
    } catch {
      if (requestId === resultsSequence.current) {
        setResultsFailure({
          message:
            "The saved search did not run. Previously verified results remain visible.",
        });
      }
    } finally {
      if (requestId === resultsSequence.current) setResultsLoading(false);
    }
  };

  const deleteSearch = async (): Promise<void> => {
    if (!detail || mutationBusy) return;
    setMutationBusy(true);
    setFailure(null);
    try {
      const response = await campaignTemplateDiscoveryApi.deleteSavedSearch(
        detail.id,
        {
          ifMatch: detail.etag,
        },
      );
      if (response.error) {
        const nextFailure = requestFailure(response.error);
        if (isConcurrencyFailure(nextFailure)) {
          await recoverConflict(
            detail.id,
            "The saved search changed elsewhere, so it was not deleted.",
          );
        } else if (isMissingFailure(nextFailure)) {
          setSearches(
            (current) =>
              current?.filter((item) => item.id !== detail.id) ?? null,
          );
          setDetail(null);
          setSelectedId("");
          setStatus("The already-removed saved search was reconciled.");
        } else {
          setFailure(nextFailure);
        }
        return;
      }
      setSearches(
        (current) => current?.filter((item) => item.id !== detail.id) ?? [],
      );
      setDetail(null);
      setSelectedId("");
      setResults(null);
      setResultsOwnerId("");
      setDeleteConfirm(false);
      setStatus("Saved search deleted.");
    } catch {
      setFailure({
        message:
          "The delete result is unknown. Reload saved searches before trying again.",
      });
    } finally {
      setMutationBusy(false);
    }
  };

  const selectedResults =
    detail && resultsOwnerId === detail.id ? results : null;

  return (
    <section
      aria-labelledby="tpl-discovery-searches-heading"
      className="tpl-discovery-panel"
    >
      <div className="tpl-discovery-panel-heading">
        <div>
          <h3 id="tpl-discovery-searches-heading">Saved searches</h3>
          <p>
            Name the current catalog view, rerun it later, and update it without
            losing server-only filters.
          </p>
        </div>
        <button
          type="button"
          className="btn btn-sm"
          disabled={loading || mutationBusy}
          onClick={() => void loadSearches()}
        >
          {loading ? "Refreshing…" : "Refresh saved searches"}
        </button>
      </div>
      <ResourceTruth
        count={searches?.length ?? null}
        label="saved searches"
        lastVerifiedAt={lastVerifiedAt}
        loading={loading}
        stale={loading && searches !== null}
      />
      <FailureNotice
        failure={failure}
        loading={loading || mutationBusy}
        onRetry={() => void loadSearches()}
      />
      {status ? (
        <p className="tpl-discovery-status" role="status">
          {status}
        </p>
      ) : null}
      <div className="tpl-saved-search-current">
        <div>
          <strong>Current library view</strong>
          <span>{savedSearchSummary(filters)}</span>
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <label htmlFor="tpl-new-saved-search-name">Save this view as</label>
          <input
            ref={createNameRef}
            id="tpl-new-saved-search-name"
            value={createName}
            maxLength={120}
            required
            disabled={mutationBusy}
            placeholder="e.g. Editorial inspiration"
            onChange={(event) => setCreateName(event.target.value)}
          />
          <button
            type="submit"
            className="btn btn-sm btn-primary"
            disabled={mutationBusy || !createName.trim()}
          >
            {mutationBusy ? "Working…" : "Save current search"}
          </button>
        </form>
      </div>
      <div className="tpl-collection-layout">
        <div className="tpl-discovery-sidebar">
          <h4>Your saved searches</h4>
          {searches === null && loading ? (
            <p role="status">Loading saved searches…</p>
          ) : searches === null ? (
            <p>No verified saved-search list is available.</p>
          ) : searches.length === 0 ? (
            <p>No saved searches yet.</p>
          ) : (
            <ul aria-label="Saved template searches">
              {searches.map((search) => (
                <li key={search.id}>
                  <button
                    type="button"
                    aria-current={selectedId === search.id ? "true" : undefined}
                    onClick={() => {
                      setFailure(null);
                      setStatus("");
                      setDeleteConfirm(false);
                      setSelectedId(search.id);
                    }}
                  >
                    <span>{search.name}</span>
                    <small>{savedSearchSummary(search.filters)}</small>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="tpl-collection-detail">
          {!selectedId ? (
            <div className="empty-state">
              <h4>Choose or save a search</h4>
              <p>Its filters and live results will appear here.</p>
            </div>
          ) : detailLoading && detail?.id !== selectedId ? (
            <p role="status">Loading verified saved-search detail…</p>
          ) : detail ? (
            <>
              <h4 ref={detailHeadingRef} tabIndex={-1}>
                {detail.name}
              </h4>
              {detailLoading ? (
                <p role="status">
                  Refreshing this search; the verified version below remains
                  visible.
                </p>
              ) : null}
              <p className="tpl-discovery-version">
                Version {detail.version} · updated{" "}
                <time dateTime={detail.updated_at}>
                  {readableDate(detail.updated_at)}
                </time>
              </p>
              <p className="tpl-saved-search-summary">
                {savedSearchSummary(detail.filters)}
              </p>
              <div className="tpl-discovery-form">
                <label htmlFor="tpl-edit-saved-search-name">Name</label>
                <input
                  id="tpl-edit-saved-search-name"
                  value={editName}
                  maxLength={120}
                  onChange={(event) => setEditName(event.target.value)}
                />
                <div className="tpl-discovery-inline-actions">
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={
                      mutationBusy ||
                      !editName.trim() ||
                      editName === detail.name
                    }
                    onClick={() => void update(false)}
                  >
                    Rename
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={mutationBusy}
                    onClick={() => void update(true)}
                  >
                    Replace with current filters
                  </button>
                </div>
              </div>
              <div className="tpl-discovery-inline-actions">
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  disabled={resultsLoading}
                  onClick={() => void run(detail)}
                >
                  {resultsLoading ? "Running…" : "Run saved search"}
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => onApplySavedSearch(detail.filters)}
                >
                  Apply supported filters to library
                </button>
              </div>
              <p className="tpl-discovery-guidance">
                “Run” honors every saved server filter. “Apply” updates the
                visible library text, goal, source, favorites, or archive view;
                advanced filters remain available through Run.
              </p>
              <FailureNotice
                failure={resultsFailure}
                loading={resultsLoading}
                onRetry={() => void run(detail)}
              />
              {selectedResults ? (
                <div className="tpl-saved-search-results">
                  <p aria-live="polite">
                    {selectedResults.items.length.toLocaleString()} of{" "}
                    {selectedResults.total.toLocaleString()} matching templates
                    loaded.
                  </p>
                  {selectedResults.items.length === 0 ? (
                    <div className="empty-state">
                      <h5>No current matches</h5>
                      <p>The saved definition is valid but currently empty.</p>
                    </div>
                  ) : (
                    <ul aria-label={`Results for ${detail.name}`}>
                      {selectedResults.items.map((template) => (
                        <li key={template.id}>
                          <button
                            type="button"
                            className="link-button"
                            onClick={() => onOpenTemplate(template)}
                          >
                            {template.name}
                          </button>
                          <span>{template.subject || "No subject"}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {selectedResults.next_cursor ? (
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={resultsLoading}
                      onClick={() =>
                        void run(detail, selectedResults.next_cursor)
                      }
                    >
                      {resultsLoading ? "Loading…" : "Load more results"}
                    </button>
                  ) : null}
                </div>
              ) : null}
              <div className="tpl-discovery-destructive-row">
                {deleteConfirm ? (
                  <div role="group" aria-label="Confirm saved search deletion">
                    <span>Delete “{detail.name}”?</span>
                    <button
                      type="button"
                      className="btn btn-sm btn-danger"
                      disabled={mutationBusy}
                      onClick={() => void deleteSearch()}
                    >
                      {mutationBusy ? "Deleting…" : "Delete saved search"}
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={mutationBusy}
                      onClick={() => setDeleteConfirm(false)}
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={mutationBusy}
                    onClick={() => setDeleteConfirm(true)}
                  >
                    Delete saved search…
                  </button>
                )}
              </div>
            </>
          ) : (
            <div className="empty-state" role="status">
              <h4>Saved-search detail unavailable</h4>
              <p>Retry the list before making a change.</p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

export function TemplateDiscoveryHub({
  compareSelection,
  currentGoal,
  currentLifecycle,
  currentQuery,
  currentSort,
  currentSource,
  recoveryScope,
  recentRefreshToken,
  rows,
  onApplySavedSearch,
  onCompareSelectionChange,
  onOpenTemplate,
}: TemplateDiscoveryHubProps): ReactElement {
  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<DiscoveryTab>("recent");
  const generatedId = useId();
  const regionId = `${generatedId}-region`;
  const tabs = useTabsInteraction<DiscoveryTab>({
    value: activeTab,
    items: TAB_ORDER.map((value) => ({ value })),
    onChange: setActiveTab,
  });
  const templates = useMemo(
    () => new Map((rows ?? []).map((row) => [row.id, row])),
    [rows],
  );

  const activate = (tab: DiscoveryTab): void => {
    setOpen(true);
    setActiveTab(tab);
  };

  return (
    <section
      className="tpl-discovery-hub"
      aria-labelledby={`${generatedId}-heading`}
    >
      <div className="tpl-discovery-hub-summary">
        <div>
          <span className="tpl-discovery-eyebrow">Personal library tools</span>
          <h2 id={`${generatedId}-heading`}>
            Find it again. Compare it. Curate it.
          </h2>
          <p>
            Recent views, side-by-side decisions, ordered collections, and
            reusable searches stay isolated to your current workspace.
          </p>
        </div>
        <button
          type="button"
          className="btn"
          aria-expanded={open}
          aria-controls={regionId}
          onClick={() => setOpen((current) => !current)}
        >
          {open ? "Hide library tools" : "Open library tools"}
        </button>
      </div>
      {compareSelection.length ? (
        <div className="tpl-compare-tray" aria-live="polite">
          <div>
            <strong>
              {compareSelection.length} of 4 selected for comparison
            </strong>
            <span>
              {compareSelection
                .map((id) => templateLabel(id, templates))
                .join(" · ")}
            </span>
          </div>
          <div>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={() => activate("compare")}
            >
              Review comparison
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => onCompareSelectionChange([])}
            >
              Clear
            </button>
          </div>
        </div>
      ) : null}
      <div id={regionId} hidden={!open}>
        <div
          ref={tabs.listRef}
          className="tpl-discovery-tabs"
          {...tabs.listProps}
          aria-label="Personal template library tools"
        >
          {TAB_ORDER.map((tab) => (
            <button key={tab} type="button" {...tabs.getTabProps(tab)}>
              {TAB_LABELS[tab]}
              {tab === "compare" && compareSelection.length
                ? ` (${compareSelection.length})`
                : ""}
            </button>
          ))}
        </div>
        <div {...tabs.getPanelProps("recent")}>
          <RecentPanel
            enabled={open && activeTab === "recent"}
            recentRefreshToken={recentRefreshToken}
            onOpenTemplate={onOpenTemplate}
          />
        </div>
        <div {...tabs.getPanelProps("compare")}>
          <TemplateComparePanel
            compareSelection={compareSelection}
            enabled={open && activeTab === "compare"}
            rows={rows}
            onCompareSelectionChange={onCompareSelectionChange}
            onOpenTemplate={onOpenTemplate}
          />
        </div>
        <div {...tabs.getPanelProps("collections")}>
          <CollectionsPanel
            compareSelection={compareSelection}
            enabled={open && activeTab === "collections"}
            recoveryScope={recoveryScope}
            rows={rows}
            onOpenTemplate={onOpenTemplate}
          />
        </div>
        <div {...tabs.getPanelProps("searches")}>
          <SavedSearchesPanel
            currentGoal={currentGoal}
            currentLifecycle={currentLifecycle}
            currentQuery={currentQuery}
            currentSort={currentSort}
            currentSource={currentSource}
            enabled={open && activeTab === "searches"}
            recoveryScope={recoveryScope}
            onApplySavedSearch={onApplySavedSearch}
            onOpenTemplate={onOpenTemplate}
          />
        </div>
      </div>
    </section>
  );
}
