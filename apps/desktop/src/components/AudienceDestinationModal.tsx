/**
 * AudienceDestinationModal — SUB-113 create / edit one native ad-platform
 * audience destination (Meta / Google Ads / TikTok / LinkedIn / Snap).
 *
 * Surface:
 *   1. Provider tabs (the catalog comes from the live providers endpoint,
 *      falling back to the canonical five).
 *   2. Per-platform credential entry + readiness probe
 *      (AudienceDestinationAuthFlow).
 *   3. Source picker — exactly one list OR segment, with member counts.
 *   4. Optional external-audience-id override.
 *   5. On EDIT: a consent-aware exclusion preview (AudienceDestinationPreview)
 *      showing how many members the firewall would withhold.
 *
 * Members are matched + consent-filtered server-side at sync time; this
 * modal only stages the destination + its credentials.
 *
 * Backend: apps/api/internal/audience_destinations/handlers.go.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
} from "react";

import {
  AudienceDestinationAuthFlow,
  audienceDestinationConfigWithProviderDefaults,
} from "./AudienceDestinationAuthFlow";
import { AudienceDestinationPreview } from "./AudienceDestinationPreview";
import { ChoiceGroup, type ChoiceGroupOption } from "./ChoiceGroup";
import { ConfirmModal } from "./ConfirmModal";
import { FormField } from "./FormField";
import { Modal, ModalFooter } from "./Modal";
import { toast } from "./Toast";
import {
  api,
  audienceDestinationsApi,
  type AudienceDestination,
  type AudiencePlatform,
  type List,
} from "../lib/api-client";
import { segmentsClient, type Segment } from "./segments/segmentsClient";
import {
  type PersistentLifecycleOperation,
  usePersistentLifecycleOperation,
} from "../hooks/usePersistentLifecycleOperation";
import {
  lifecycleOperationError,
  useDiscardOnlyDraftLifecycle,
  useExistingSettingLifecycle,
} from "../hooks/useSettingsDraftLifecycle";

const PROVIDER_LABELS: Record<string, string> = {
  meta: "Meta",
  google_ads: "Google Ads",
  tiktok: "TikTok",
  linkedin: "LinkedIn",
  snap: "Snap",
};
const FALLBACK_PROVIDERS: AudiencePlatform[] = [
  "meta",
  "google_ads",
  "tiktok",
  "linkedin",
  "snap",
];

type SourceKind = "list" | "segment";

const SOURCE_KIND_OPTIONS: readonly ChoiceGroupOption<SourceKind>[] = [
  {
    value: "list",
    label: "List",
    description: "Use current membership from one workspace list.",
  },
  {
    value: "segment",
    label: "Segment",
    description: "Use the current result of one saved segment.",
  },
];

interface DestinationDraft {
  provider: AudiencePlatform;
  sourceKind: SourceKind;
  listId: string;
  segmentId: string;
  externalId: string;
  config: Record<string, unknown>;
}

function initialDestinationDraft(
  destination: AudienceDestination | null,
): DestinationDraft {
  const provider =
    (destination?.provider as AudiencePlatform | undefined) ?? "meta";
  return {
    provider,
    sourceKind: destination?.segment_id ? "segment" : "list",
    listId: destination?.list_id ?? "",
    segmentId: destination?.segment_id ?? "",
    externalId: destination?.external_audience_id ?? "",
    config: audienceDestinationConfigWithProviderDefaults(
      provider,
      destination?.config ?? {},
    ),
  };
}

function configsEqual(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): boolean {
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every(
      (key) => JSON.stringify(left[key]) === JSON.stringify(right[key]),
    )
  );
}

function destinationDraftsEqual(
  left: DestinationDraft,
  right: DestinationDraft,
): boolean {
  return (
    left.provider === right.provider &&
    left.sourceKind === right.sourceKind &&
    left.listId === right.listId &&
    left.segmentId === right.segmentId &&
    left.externalId === right.externalId &&
    configsEqual(left.config, right.config)
  );
}

/** Unwrap the Listmonk lists envelope ({data:{results}} | {items} | …). */
function unwrapLists(payload: unknown): List[] {
  if (Array.isArray(payload)) return payload as List[];
  if (payload && typeof payload === "object") {
    const r = payload as Record<string, unknown>;
    const inner = (r.data ?? r) as Record<string, unknown>;
    const arr = Array.isArray(inner)
      ? inner
      : ((inner.results as unknown) ??
        (r.items as unknown) ??
        (r.results as unknown) ??
        []);
    return Array.isArray(arr) ? (arr as List[]) : [];
  }
  return [];
}

interface Props {
  /** null → create; otherwise edit this destination. */
  destination: AudienceDestination | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}

export function AudienceDestinationModal({
  destination,
  onClose,
  onSaved,
}: Props): ReactElement {
  const editing = destination !== null;
  const mountedRef = useRef(true);
  const baselineRef = useRef<DestinationDraft>(
    initialDestinationDraft(destination),
  );

  const [providers, setProviders] = useState<string[]>(FALLBACK_PROVIDERS);
  const [provider, setProvider] = useState<AudiencePlatform>(
    baselineRef.current.provider,
  );
  const [sourceKind, setSourceKind] = useState<SourceKind>(
    baselineRef.current.sourceKind,
  );
  const [listId, setListId] = useState(baselineRef.current.listId);
  const [segmentId, setSegmentId] = useState(baselineRef.current.segmentId);
  const [externalId, setExternalId] = useState(baselineRef.current.externalId);
  const [config, setConfig] = useState<Record<string, unknown>>(
    baselineRef.current.config,
  );

  const [lists, setLists] = useState<List[] | null>(null);
  const [listsErr, setListsErr] = useState<string | null>(null);
  const [segments, setSegments] = useState<Segment[] | null>(null);
  const [segmentsErr, setSegmentsErr] = useState<string | null>(null);

  const [formErr, setFormErr] = useState<string | null>(null);
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);
  const operation = usePersistentLifecycleOperation({
    ownerId: `audience-destination-${destination?.id ?? "create"}`,
    label: editing
      ? "Audience destination update"
      : "Audience destination creation",
  });

  const currentDraft: DestinationDraft = {
    provider,
    sourceKind,
    listId,
    segmentId,
    externalId,
    config,
  };
  const draftDirty = !destinationDraftsEqual(currentDraft, baselineRef.current);

  const restoreBaseline = useCallback((): void => {
    const baseline = baselineRef.current;
    setProvider(baseline.provider);
    setSourceKind(baseline.sourceKind);
    setListId(baseline.listId);
    setSegmentId(baseline.segmentId);
    setExternalId(baseline.externalId);
    setConfig({ ...baseline.config });
    setFormErr(null);
    setDiscardConfirmOpen(false);
  }, []);

  // Provider catalog + source catalogs load on mount.
  useEffect(() => {
    mountedRef.current = true;
    let cancelled = false;
    void (async () => {
      const res = await audienceDestinationsApi.providers();
      if (cancelled) return;
      const got = res.data?.providers;
      if (Array.isArray(got) && got.length > 0) setProviders(got);
    })();
    void (async () => {
      const res = await api.listLists();
      if (cancelled) return;
      if (res.error) {
        setListsErr(res.error.message);
        setLists([]);
      } else {
        setLists(unwrapLists(res.data));
      }
    })();
    void (async () => {
      const res = await segmentsClient.list();
      if (cancelled) return;
      if (res.error) {
        setSegmentsErr(
          res.error.status === 404
            ? "Segments aren't enabled on this Moosewave server."
            : res.error.message,
        );
        setSegments([]);
      } else {
        setSegments(Array.isArray(res.data) ? res.data : []);
      }
    })();
    return () => {
      mountedRef.current = false;
      cancelled = true;
    };
  }, []);

  const validate = (): string | null => {
    if (sourceKind === "list" && !listId) return "Pick a source list.";
    if (sourceKind === "segment" && !segmentId) return "Pick a source segment.";
    return null;
  };

  const save = async (): Promise<boolean> => {
    const v = validate();
    if (v) {
      setFormErr(v);
      return false;
    }
    setFormErr(null);
    const submittedDraft = currentDraft;
    const normalizedConfig = audienceDestinationConfigWithProviderDefaults(
      submittedDraft.provider,
      submittedDraft.config,
    );
    const pending = operation.run(async () =>
      editing
        ? audienceDestinationsApi.update(destination.id, {
            external_audience_id: submittedDraft.externalId.trim(),
            config: normalizedConfig,
          })
        : audienceDestinationsApi.create({
            provider: submittedDraft.provider,
            ...(submittedDraft.sourceKind === "list"
              ? { list_id: submittedDraft.listId }
              : { segment_id: submittedDraft.segmentId }),
            external_audience_id: submittedDraft.externalId.trim() || undefined,
            config: normalizedConfig,
          }),
    );
    if (!pending) return false;
    try {
      const res = await pending;
      if (res.error) {
        if (mountedRef.current) setFormErr(res.error.message);
        return false;
      }
      if (!mountedRef.current) return true;
      const acknowledged: DestinationDraft = {
        ...submittedDraft,
        externalId: submittedDraft.externalId.trim(),
        config: normalizedConfig,
      };
      baselineRef.current = acknowledged;
      if (mountedRef.current) {
        setExternalId(acknowledged.externalId);
        setConfig(acknowledged.config);
        setDiscardConfirmOpen(false);
        toast.success(
          editing
            ? "Destination updated"
            : `${PROVIDER_LABELS[provider] ?? provider} destination created`,
        );
      }
      try {
        await onSaved();
      } catch (refreshError) {
        if (mountedRef.current) {
          toast.error({
            message: "Destination saved, but the list couldn't refresh",
            detail: lifecycleOperationError(
              refreshError,
              "Refresh the destination list to see the saved change.",
            ),
          });
        }
      }
      return true;
    } catch (error) {
      if (mountedRef.current) {
        setFormErr(
          lifecycleOperationError(
            error,
            "The audience destination request failed.",
          ),
        );
      }
      return false;
    }
  };

  useDiscardOnlyDraftLifecycle({
    ownerId: "audience-destination-create",
    label: "New audience destination draft",
    dirty: !editing && draftDirty,
    operationRef: operation.promiseRef,
    discard: restoreBaseline,
    enabled: !editing,
    detail:
      "This audience destination draft has not been created. Return to it or explicitly discard it.",
  });
  useExistingSettingLifecycle({
    ownerId: `audience-destination-${destination?.id ?? "none"}`,
    label: "Audience destination changes",
    dirty: editing && draftDirty,
    operationRef: operation.promiseRef,
    save,
    discard: restoreBaseline,
    enabled: editing,
  });

  const requestClose = (): void => {
    if (operation.promiseRef.current) return;
    if (draftDirty) {
      setDiscardConfirmOpen(true);
      return;
    }
    onClose();
  };

  const discardAndClose = (): void => {
    if (operation.promiseRef.current) return;
    restoreBaseline();
    onClose();
  };

  return (
    <AudienceDestinationModalView
      editing={editing}
      destinationId={destination?.id}
      providers={providers}
      provider={provider}
      setProvider={setProvider}
      sourceKind={sourceKind}
      setSourceKind={setSourceKind}
      listId={listId}
      setListId={setListId}
      segmentId={segmentId}
      setSegmentId={setSegmentId}
      externalId={externalId}
      setExternalId={setExternalId}
      config={config}
      setConfig={setConfig}
      lists={lists}
      listsErr={listsErr}
      segments={segments}
      segmentsErr={segmentsErr}
      formErr={formErr}
      discardConfirmOpen={discardConfirmOpen}
      setDiscardConfirmOpen={setDiscardConfirmOpen}
      operation={operation}
      requestClose={requestClose}
      discardAndClose={discardAndClose}
      save={save}
    />
  );
}

interface AudienceDestinationModalViewProps {
  editing: boolean;
  destinationId?: string;
  providers: string[];
  provider: AudiencePlatform;
  setProvider: (provider: AudiencePlatform) => void;
  sourceKind: SourceKind;
  setSourceKind: (kind: SourceKind) => void;
  listId: string;
  setListId: (id: string) => void;
  segmentId: string;
  setSegmentId: (id: string) => void;
  externalId: string;
  setExternalId: (id: string) => void;
  config: Record<string, unknown>;
  setConfig: (config: Record<string, unknown>) => void;
  lists: List[] | null;
  listsErr: string | null;
  segments: Segment[] | null;
  segmentsErr: string | null;
  formErr: string | null;
  discardConfirmOpen: boolean;
  setDiscardConfirmOpen: (open: boolean) => void;
  operation: PersistentLifecycleOperation;
  requestClose: () => void;
  discardAndClose: () => void;
  save: () => Promise<boolean>;
}

function AudienceDestinationModalView({
  editing,
  destinationId,
  providers,
  provider,
  setProvider,
  sourceKind,
  setSourceKind,
  listId,
  setListId,
  segmentId,
  setSegmentId,
  externalId,
  setExternalId,
  config,
  setConfig,
  lists,
  listsErr,
  segments,
  segmentsErr,
  formErr,
  discardConfirmOpen,
  setDiscardConfirmOpen,
  operation,
  requestClose,
  discardAndClose,
  save,
}: AudienceDestinationModalViewProps): ReactElement {
  return (
    <>
      <Modal
        open
        onClose={requestClose}
        closeOnBackdrop={!operation.active}
        closeOnEscape={!operation.active}
        closeDisabled={operation.active}
        size="lg"
        title={
          editing ? "Edit audience destination" : "New audience destination"
        }
        description="Build a Custom Audience on an ad platform from a list or segment, with consent-aware exclusion. Moosewave ships SHA-256-hashed emails only."
      >
        {formErr ? (
          <div className="notice" role="alert" style={{ marginBottom: 12 }}>
            <span>{formErr}</span>
          </div>
        ) : null}
        <FormField label="Platform">
          {editing ? (
            <div>
              <span className="badge">
                {PROVIDER_LABELS[provider] ?? provider}
              </span>
              <p className="muted" style={{ fontSize: 11, margin: "4px 0 0" }}>
                The platform and source are fixed once created — delete and
                recreate to change them.
              </p>
            </div>
          ) : (
            <ChoiceGroup
              legend="Audience platform"
              value={provider}
              options={providers.map((candidate) => ({
                value: candidate as AudiencePlatform,
                label: PROVIDER_LABELS[candidate] ?? candidate,
              }))}
              onChange={(nextProvider) => {
                setProvider(nextProvider);
                setConfig({});
              }}
            />
          )}
        </FormField>
        <AudienceDestinationAuthFlow
          provider={provider}
          config={config}
          onChange={setConfig}
          runOperation={operation.run}
        />
        {!editing ? (
          <DestinationSourcePicker
            sourceKind={sourceKind}
            setSourceKind={setSourceKind}
            listId={listId}
            setListId={setListId}
            segmentId={segmentId}
            setSegmentId={setSegmentId}
            lists={lists}
            listsErr={listsErr}
            segments={segments}
            segmentsErr={segmentsErr}
          />
        ) : null}
        <FormField
          label="External audience ID (optional)"
          help="The platform-side audience this maps to. Usually set automatically on first sync."
        >
          <input
            type="text"
            className="mono"
            value={externalId}
            onChange={(event) => setExternalId(event.target.value)}
            placeholder="platform audience id"
          />
        </FormField>
        {editing && destinationId ? (
          <FormField label="Consent exclusion preview">
            <AudienceDestinationPreview destinationId={destinationId} />
          </FormField>
        ) : null}
        <ModalFooter>
          <button
            type="button"
            className="btn"
            disabled={operation.active}
            onClick={requestClose}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={operation.active}
            onClick={() => void save()}
          >
            {operation.active
              ? "Working…"
              : editing
                ? "Save changes"
                : "Create destination"}
          </button>
        </ModalFooter>
      </Modal>
      <ConfirmModal
        open={discardConfirmOpen}
        title={
          editing
            ? "Discard destination changes?"
            : "Discard destination draft?"
        }
        description={
          editing
            ? "Your unsaved destination changes will be lost."
            : "The provider, source, and connection configuration in this draft will be lost."
        }
        confirmLabel="Discard changes"
        danger
        busy={operation.active}
        onConfirm={discardAndClose}
        onClose={() => setDiscardConfirmOpen(false)}
      />
    </>
  );
}

type DestinationSourcePickerProps = Pick<
  AudienceDestinationModalViewProps,
  | "sourceKind"
  | "setSourceKind"
  | "listId"
  | "setListId"
  | "segmentId"
  | "setSegmentId"
  | "lists"
  | "listsErr"
  | "segments"
  | "segmentsErr"
>;

function DestinationSourcePicker({
  sourceKind,
  setSourceKind,
  listId,
  setListId,
  segmentId,
  setSegmentId,
  lists,
  listsErr,
  segments,
  segmentsErr,
}: DestinationSourcePickerProps): ReactElement {
  return (
    <FormField
      label="Source audience"
      required
      help="Exactly one list or segment per destination."
    >
      <ChoiceGroup
        legend="Source audience type"
        value={sourceKind}
        options={SOURCE_KIND_OPTIONS}
        onChange={setSourceKind}
        style={{ marginBottom: 6 }}
      />
      {sourceKind === "list" ? (
        listsErr ? (
          <div className="notice">
            <span>Couldn&apos;t load lists: {listsErr}</span>
          </div>
        ) : (
          <select
            value={listId}
            disabled={lists === null}
            onChange={(event) => setListId(event.target.value)}
            aria-label="Source list"
          >
            <option value="">
              {lists === null
                ? "Loading lists…"
                : lists.length === 0
                  ? "No lists on this workspace"
                  : "Select a list…"}
            </option>
            {(lists ?? []).map((list) => (
              <option key={String(list.id)} value={String(list.id)}>
                {list.name || "(unnamed list)"}
                {typeof list.subscriber_count === "number"
                  ? ` (${list.subscriber_count.toLocaleString()} members)`
                  : ""}
              </option>
            ))}
          </select>
        )
      ) : segmentsErr ? (
        <div className="notice">
          <span>Couldn&apos;t load segments: {segmentsErr}</span>
        </div>
      ) : (
        <select
          value={segmentId}
          disabled={segments === null}
          onChange={(event) => setSegmentId(event.target.value)}
          aria-label="Source segment"
        >
          <option value="">
            {segments === null
              ? "Loading segments…"
              : segments.length === 0
                ? "No segments on this workspace"
                : "Select a segment…"}
          </option>
          {(segments ?? []).map((segment) => (
            <option key={segment.id} value={segment.id}>
              {segment.name || "(unnamed segment)"}
            </option>
          ))}
        </select>
      )}
    </FormField>
  );
}
