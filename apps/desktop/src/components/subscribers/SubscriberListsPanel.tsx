import {
  type Dispatch,
  type ReactElement,
  type SetStateAction,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  type CustomField,
  type DataClassification,
  type MergeFieldSchema,
  type MergeFieldType,
  type Subscriber,
  type SubscriberDetail,
  type SubscriberGroupMembership,
  type SubscriberTrackingPrefs,
  api,
  customFieldsApi,
  getSubscriberMergeFields,
  listMergeFieldSchema,
  patchSubscriberMergeFields,
} from "../../lib/api-client";
import { queueReceiptMessage } from "../../lib/api/result";
import { fmtDate } from "../../lib/format-date";
import { InlineHelp } from "../InlineHelp";
import { ConfirmModal } from "../ConfirmModal";
import { toast } from "../Toast";
import { ChannelConsentsPanel } from "./ChannelConsentsPanel";
import { FrequencyPreferencePanel } from "./FrequencyPreferencePanel";
import { GppSectionsPanel } from "./GppSectionsPanel";
import { AddTagButton } from "./InlineTagChip";
import {
  PurposeConsentSection,
  TrackingPrefsPanel,
} from "./SubscriberPrivacyPanels";
import { SendTimesPanel } from "./SendTimesPanel";
import { SubscriberListMembershipsSection } from "./SubscriberListMembershipsSection";

interface SubscriberListsPanelProps {
  active: boolean;
  subscriberId: string | number | null | undefined;
  subscriberEmail: string;
  detail: SubscriberDetail;
  canMutate: boolean;
  onDetailChange: (updated: SubscriberDetail) => void;
  onPersistedDetailChange: (
    updated: SubscriberDetail,
    patch?: Partial<Subscriber>,
  ) => void;
}

interface ListsData {
  customFieldDefs: CustomField[];
  groupMemberships: SubscriberGroupMembership[];
  loadError: string | null;
  mergeFieldSchema: MergeFieldSchema[];
  mergeFieldValues: Record<string, string>;
  reload: () => void;
  setMergeFieldValues: Dispatch<SetStateAction<Record<string, string>>>;
  setTrackingError: Dispatch<SetStateAction<string | null>>;
  setTrackingPrefs: Dispatch<SetStateAction<SubscriberTrackingPrefs | null>>;
  setTrackingSaving: Dispatch<SetStateAction<string | null>>;
  setTrackingVersion: Dispatch<SetStateAction<string | null>>;
  trackingError: string | null;
  trackingPrefs: SubscriberTrackingPrefs | null;
  trackingSaving: string | null;
  trackingVersion: string | null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_RE = /^https?:\/\/[^\s]+$/i;
const MAX_MERGE_FIELD_VALUE_LENGTH = 4096;

const CONSENT_SOURCE_LABELS: Record<string, string> = {
  double_optin: "Double opt-in",
  single_optin: "Single opt-in",
  import: "Imported",
  api: "API",
  form: "Signup form",
  unknown: "Not recorded",
};

function customFieldAnnotation(
  definition: CustomField | undefined,
  value: unknown,
): { tip: string; valid?: boolean } | null {
  if (!definition) return null;
  const normalizedValue =
    typeof value === "string" ? value.trim() : String(value ?? "").trim();
  switch (definition.type) {
    case "enum": {
      const options = definition.config?.options ?? [];
      return {
        tip:
          options.length === 0
            ? "Enum field"
            : `Allowed values: ${options.join(" | ")}`,
      };
    }
    case "email":
      return {
        tip: "Email-formatted field",
        valid:
          normalizedValue === "" ? undefined : EMAIL_RE.test(normalizedValue),
      };
    case "url":
      return {
        tip: "URL-formatted field",
        valid:
          normalizedValue === "" ? undefined : URL_RE.test(normalizedValue),
      };
    case "phone": {
      const pattern = definition.config?.pattern || definition.validation_rule;
      return {
        tip: pattern
          ? `Phone field (pattern: ${pattern})`
          : "Phone field — include country code (E.164)",
      };
    }
    case "region":
      return { tip: "Region / ISO 3166-2 field" };
    case "array":
      return {
        tip: definition.config?.item_type
          ? `Array of ${definition.config.item_type}`
          : "Array field",
      };
    case "object":
      return { tip: "Nested object field" };
    default:
      if (definition.config?.pattern || definition.validation_rule) {
        return {
          tip: `Pattern: ${
            definition.config?.pattern || definition.validation_rule
          }`,
        };
      }
      return null;
  }
}

function boundedCustomFieldText(value: string, max = 240): string {
  const characters = Array.from(value);
  return characters.length <= max
    ? value
    : `${characters.slice(0, max).join("")}…`;
}

function customFieldDisplayValue(
  definition: CustomField | undefined,
  value: unknown,
): string {
  if (value == null || value === "") return "—";
  if (definition?.type === "boolean" || typeof value === "boolean") {
    return value === true || value === "true" ? "True" : "False";
  }
  if (definition?.type === "number" || typeof value === "number") {
    const numeric = typeof value === "number" ? value : Number(value);
    return Number.isFinite(numeric)
      ? numeric.toLocaleString()
      : "Invalid number";
  }
  if (Array.isArray(value)) {
    const visible = value
      .slice(0, 5)
      .map((entry) => boundedCustomFieldText(String(entry ?? ""), 48));
    return `${visible.join(", ")}${value.length > 5 ? ` +${value.length - 5} more` : ""}`;
  }
  if (typeof value === "object") {
    try {
      return boundedCustomFieldText(JSON.stringify(value));
    } catch {
      return "Structured value unavailable";
    }
  }
  return boundedCustomFieldText(String(value));
}

function classificationBadge(
  classification: DataClassification | undefined,
): { label: string; className: string; tip: string } | null {
  switch (classification) {
    case "pii":
      return {
        label: "PII",
        className: "badge danger",
        tip: "Personally identifiable information — masking / export policy applies",
      };
    case "phi":
      return {
        label: "PHI",
        className: "badge warning",
        tip: "Protected health information — heightened handling policy applies",
      };
    case "pci":
      return {
        label: "PCI",
        className: "badge warning",
        tip: "Payment-card data — PCI-DSS handling policy applies",
      };
    case "sensitive":
      return {
        label: "Sensitive",
        className: "badge accent",
        tip: "Sensitive attribute — restricted handling policy applies",
      };
    case "business":
      return {
        label: "Business",
        className: "badge",
        tip: "Business attribute — non-personal data",
      };
    case "none":
    default:
      return null;
  }
}

function useCurrentSubscriberGuard(): () => boolean {
  const generation = useRef(0);
  const renderGeneration = generation.current;
  useEffect(
    () => () => {
      generation.current += 1;
    },
    [],
  );
  return () => generation.current === renderGeneration;
}

function useListsData(
  subscriberId: string | number | null | undefined,
  active: boolean,
): ListsData {
  const [mergeFieldSchema, setMergeFieldSchema] = useState<MergeFieldSchema[]>(
    [],
  );
  const [mergeFieldValues, setMergeFieldValues] = useState<
    Record<string, string>
  >({});
  const [customFieldDefs, setCustomFieldDefs] = useState<CustomField[]>([]);
  const [trackingPrefs, setTrackingPrefs] =
    useState<SubscriberTrackingPrefs | null>(null);
  const [trackingError, setTrackingError] = useState<string | null>(null);
  const [trackingSaving, setTrackingSaving] = useState<string | null>(null);
  const [trackingVersion, setTrackingVersion] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [groupMemberships, setGroupMemberships] = useState<
    SubscriberGroupMembership[]
  >([]);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    setTrackingError(null);
    setTrackingSaving(null);
    setLoadError(null);

    if (!active || subscriberId == null) {
      return () => {
        cancelled = true;
        controller.abort();
      };
    }

    setTrackingVersion(null);
    setTrackingSaving("refresh");

    void (async () => {
      try {
        const results = await Promise.all([
          listMergeFieldSchema(),
          getSubscriberMergeFields(subscriberId),
          api.getSubscriberTrackingPrefs(subscriberId, {
            signal: controller.signal,
          }),
          customFieldsApi.list(),
          api.getSubscriberGroupMemberships(subscriberId),
        ]);
        const [schema, values, prefs, definitions, groups] = results;
        if (cancelled) return;

        if (
          results.some(
            (result) =>
              result != null && "error" in result && Boolean(result.error),
          )
        ) {
          setLoadError(
            "Some subscriber metadata couldn't be loaded. Retry to restore the missing sections.",
          );
        }

        if (!("error" in schema)) {
          setMergeFieldSchema(schema.data?.items ?? []);
        }
        if (!("error" in values)) {
          setMergeFieldValues(values.data?.values ?? {});
        }
        if (prefs == null) {
          setTrackingPrefs(null);
        } else if (!("error" in prefs)) {
          setTrackingPrefs(prefs.data ?? null);
          setTrackingVersion(prefs.serverVersion ?? null);
        }
        if (!("error" in definitions)) {
          setCustomFieldDefs(definitions.data ?? []);
        }
        if (!("error" in groups)) {
          setGroupMemberships(groups.data?.groups ?? []);
        }
        setTrackingSaving(null);
      } catch {
        if (!cancelled) {
          setTrackingSaving(null);
          setLoadError(
            "Couldn't load subscriber metadata. Check your connection and retry.",
          );
        }
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [active, reloadNonce, subscriberId]);

  return {
    customFieldDefs,
    groupMemberships,
    loadError,
    mergeFieldSchema,
    mergeFieldValues,
    reload: () => setReloadNonce((current) => current + 1),
    setMergeFieldValues,
    setTrackingError,
    setTrackingPrefs,
    setTrackingSaving,
    setTrackingVersion,
    trackingError,
    trackingPrefs,
    trackingSaving,
    trackingVersion,
  };
}

function useListsMutations({
  subscriberId,
  detail,
  canMutate,
  data,
  onDetailChange,
  onPersistedDetailChange,
}: Omit<SubscriberListsPanelProps, "active"> & { data: ListsData }) {
  const isCurrent = useCurrentSubscriberGuard();
  const inFlightRef = useRef(new Set<string>());
  const begin = (key: string): boolean => {
    if (inFlightRef.current.has(key)) return false;
    inFlightRef.current.add(key);
    return true;
  };
  const finish = (key: string): void => {
    inFlightRef.current.delete(key);
  };

  const removeTag = async (tag: string): Promise<void> => {
    if (subscriberId == null || !canMutate || !begin("profile")) return;
    const previousTags = detail.tags ?? [];
    const nextTags = previousTags.filter((currentTag) => currentTag !== tag);
    const optimistic = { ...detail, tags: nextTags };
    onDetailChange(optimistic);
    let result: Awaited<ReturnType<typeof api.updateSubscriber>>;
    try {
      result = await api.updateSubscriber(
        subscriberId,
        { tags: nextTags },
        { version: detail.version ?? "" },
      );
    } catch {
      finish("profile");
      if (isCurrent()) {
        onDetailChange({ ...detail, tags: previousTags });
        toast.error(
          "Couldn't remove the tag. Check your connection and retry.",
        );
      }
      return;
    }
    finish("profile");
    if (!isCurrent()) return;
    if (result.error) {
      onDetailChange({ ...detail, tags: previousTags });
      toast.error(`Couldn't remove tag: ${result.error.message}`);
      return;
    }
    const updated = result.queued ? optimistic : (result.data ?? optimistic);
    if (!result.queued && result.data) onDetailChange(result.data);
    onPersistedDetailChange(updated, { tags: nextTags });
    if (result.queued) toast.info(queueReceiptMessage(result.receipt));
    else toast.success(`Removed tag "${tag}"`);
  };

  const addTag = async (tag: string): Promise<void> => {
    if (subscriberId == null || !canMutate) return;
    const normalizedTag = tag.trim();
    if (!normalizedTag) return;
    const previousTags = detail.tags ?? [];
    if (previousTags.includes(normalizedTag)) return;
    if (!begin("profile")) return;
    const nextTags = [...previousTags, normalizedTag];
    const optimistic = { ...detail, tags: nextTags };
    onDetailChange(optimistic);
    let result: Awaited<ReturnType<typeof api.updateSubscriber>>;
    try {
      result = await api.updateSubscriber(
        subscriberId,
        { tags: nextTags },
        { version: detail.version ?? "" },
      );
    } catch {
      finish("profile");
      if (isCurrent()) {
        onDetailChange({ ...detail, tags: previousTags });
        toast.error("Couldn't add the tag. Check your connection and retry.");
      }
      return;
    }
    finish("profile");
    if (!isCurrent()) return;
    if (result.error) {
      onDetailChange({ ...detail, tags: previousTags });
      toast.error(`Couldn't add tag: ${result.error.message}`);
      return;
    }
    const updated = result.queued ? optimistic : (result.data ?? optimistic);
    if (!result.queued && result.data) onDetailChange(result.data);
    onPersistedDetailChange(updated, { tags: nextTags });
    if (result.queued) toast.info(queueReceiptMessage(result.receipt));
    else toast.success(`Added tag "${normalizedTag}"`);
  };

  const removeCustomField = async (key: string): Promise<void> => {
    if (subscriberId == null || !canMutate || !begin("profile")) return;
    const previousFields = {
      ...(detail.custom_fields ?? detail.merge_fields ?? {}),
    };
    const nextFields = { ...previousFields };
    delete nextFields[key];
    const optimistic = { ...detail, custom_fields: nextFields };
    onDetailChange(optimistic);
    let result: Awaited<ReturnType<typeof api.updateSubscriber>>;
    try {
      result = await api.updateSubscriber(
        subscriberId,
        {
          custom_fields: nextFields,
        },
        { version: detail.version ?? "" },
      );
    } catch {
      finish("profile");
      if (isCurrent()) {
        onDetailChange({ ...detail, custom_fields: previousFields });
        toast.error(
          "Couldn't remove the field. Check your connection and retry.",
        );
      }
      return;
    }
    finish("profile");
    if (!isCurrent()) return;
    if (result.error) {
      onDetailChange({ ...detail, custom_fields: previousFields });
      toast.error(`Couldn't remove field: ${result.error.message}`);
      return;
    }
    const updated = result.queued ? optimistic : (result.data ?? optimistic);
    if (!result.queued && result.data) onDetailChange(result.data);
    onPersistedDetailChange(updated);
    if (result.queued) toast.info(queueReceiptMessage(result.receipt));
  };

  const setMergeField = async (key: string, value: string): Promise<void> => {
    const operationKey = `merge:${key}`;
    if (subscriberId == null || !canMutate || !begin(operationKey)) return;
    const previousHadKey = Object.hasOwn(data.mergeFieldValues, key);
    const previousValue = data.mergeFieldValues[key];
    data.setMergeFieldValues((current) => ({ ...current, [key]: value }));
    const restoreKey = (): void => {
      data.setMergeFieldValues((current) => {
        const next = { ...current };
        if (previousHadKey) next[key] = previousValue ?? "";
        else delete next[key];
        return next;
      });
    };
    let result: Awaited<ReturnType<typeof patchSubscriberMergeFields>>;
    try {
      result = await patchSubscriberMergeFields(subscriberId, { [key]: value });
    } catch {
      finish(operationKey);
      if (isCurrent()) {
        restoreKey();
        toast.error(
          "Couldn't update the merge field. Check your connection and retry.",
        );
      }
      return;
    }
    finish(operationKey);
    if (!isCurrent()) return;
    if (result.error) {
      restoreKey();
      toast.error(`Couldn't update ${key}: ${result.error.message}`);
      return;
    }
    if (result.data) {
      data.setMergeFieldValues((current) => {
        const next = { ...current };
        if (Object.hasOwn(result.data.values, key)) {
          next[key] = result.data.values[key] ?? "";
        } else {
          delete next[key];
        }
        return next;
      });
    }
  };

  const toggleTracking = async (
    dimension: "open" | "click",
    nextOptOut: boolean,
  ): Promise<void> => {
    const operationKey = `tracking:${dimension}`;
    if (subscriberId == null || !canMutate || !begin(operationKey)) return;
    if (!data.trackingVersion) {
      finish(operationKey);
      data.setTrackingError(
        "Refresh these tracking preferences before changing them so the latest exact revision can be verified.",
      );
      return;
    }
    data.setTrackingError(null);
    data.setTrackingSaving(dimension);
    const patch =
      dimension === "open"
        ? { open_opt_out: nextOptOut }
        : { click_opt_out: nextOptOut };
    let result: Awaited<ReturnType<typeof api.patchSubscriberTrackingPrefs>>;
    try {
      result = await api.patchSubscriberTrackingPrefs(subscriberId, patch, {
        version: data.trackingVersion,
      });
    } catch {
      finish(operationKey);
      if (isCurrent()) {
        data.setTrackingSaving(null);
        data.setTrackingError(
          "Couldn't update tracking preferences. Check your connection and retry.",
        );
      }
      return;
    }
    finish(operationKey);
    if (!isCurrent()) return;
    data.setTrackingSaving(null);
    if (result.error) {
      if (result.error.status === 412) {
        data.setTrackingVersion(null);
        data.setTrackingError(
          "Tracking preferences changed elsewhere. Reload the latest verified state, review it, and then try again.",
        );
      } else {
        data.setTrackingError(result.error.message);
      }
      return;
    }
    if (result.data) {
      data.setTrackingPrefs(result.data);
      data.setTrackingVersion(result.serverVersion ?? null);
      toast.success("Tracking preferences saved");
    }
  };

  return {
    addTag,
    removeCustomField,
    removeTag,
    setMergeField,
    toggleTracking,
  };
}

export function SubscriberListsPanel(
  props: SubscriberListsPanelProps,
): ReactElement {
  const subscriberKey =
    props.subscriberId == null
      ? "none"
      : `${typeof props.subscriberId}:${String(props.subscriberId)}`;
  return <SubscriberListsPanelState key={subscriberKey} {...props} />;
}

function SubscriberListsPanelState(
  props: SubscriberListsPanelProps,
): ReactElement | null {
  const [channelConsentsUnavailable, setChannelConsentsUnavailable] =
    useState(false);
  const [gppUnavailable, setGppUnavailable] = useState(false);
  const [pendingCustomFieldRemoval, setPendingCustomFieldRemoval] = useState<{
    key: string;
    label: string;
    type: CustomField["type"] | undefined;
    classification: DataClassification | undefined;
  } | null>(null);
  const data = useListsData(props.subscriberId, props.active);
  const mutations = useListsMutations({ ...props, data });
  const isCurrent = useCurrentSubscriberGuard();

  if (!props.active) return null;
  return (
    <>
      <SubscriberListsPanelView
        {...props}
        onDetailChange={(updated) => {
          if (isCurrent()) props.onDetailChange(updated);
        }}
        onPersistedDetailChange={(updated, patch) => {
          if (isCurrent()) props.onPersistedDetailChange(updated, patch);
        }}
        data={data}
        mutations={mutations}
        channelConsentsUnavailable={channelConsentsUnavailable}
        gppUnavailable={gppUnavailable}
        onRequestCustomFieldRemoval={setPendingCustomFieldRemoval}
        onChannelConsentsUnavailable={() => {
          if (isCurrent()) setChannelConsentsUnavailable(true);
        }}
        onGppUnavailable={() => {
          if (isCurrent()) setGppUnavailable(true);
        }}
      />
      <ConfirmModal
        open={pendingCustomFieldRemoval != null}
        title="Remove custom field value?"
        description={
          pendingCustomFieldRemoval
            ? `Remove “${pendingCustomFieldRemoval.label}” from this subscriber? This deletes the stored ${pendingCustomFieldRemoval.type ?? "custom"} value${pendingCustomFieldRemoval.classification && pendingCustomFieldRemoval.classification !== "none" ? ` classified as ${pendingCustomFieldRemoval.classification.toUpperCase()}` : ""}. Attribute history remains available for audit.`
            : ""
        }
        confirmLabel="Remove field value"
        danger
        onClose={() => setPendingCustomFieldRemoval(null)}
        onConfirm={() => {
          if (!pendingCustomFieldRemoval) return;
          const key = pendingCustomFieldRemoval.key;
          setPendingCustomFieldRemoval(null);
          void mutations.removeCustomField(key);
        }}
      />
    </>
  );
}

interface SubscriberListsPanelViewProps extends SubscriberListsPanelProps {
  data: ListsData;
  mutations: ReturnType<typeof useListsMutations>;
  channelConsentsUnavailable: boolean;
  gppUnavailable: boolean;
  onChannelConsentsUnavailable: () => void;
  onGppUnavailable: () => void;
  onRequestCustomFieldRemoval: (field: {
    key: string;
    label: string;
    type: CustomField["type"] | undefined;
    classification: DataClassification | undefined;
  }) => void;
}

function SubscriberListsPanelView({
  subscriberId,
  detail,
  canMutate,
  onDetailChange,
  onPersistedDetailChange,
  data,
  mutations,
  channelConsentsUnavailable,
  gppUnavailable,
  onChannelConsentsUnavailable,
  onGppUnavailable,
  onRequestCustomFieldRemoval,
}: SubscriberListsPanelViewProps): ReactElement {
  const customFields = useMemo<Array<[string, unknown]>>(() => {
    const fields = detail.custom_fields ?? detail.merge_fields ?? {};
    return Object.entries(fields);
  }, [detail.custom_fields, detail.merge_fields]);
  const customFieldDefinitions = useMemo<Record<string, CustomField>>(() => {
    const definitions: Record<string, CustomField> = {};
    for (const definition of data.customFieldDefs) {
      definitions[definition.key] = definition;
    }
    return definitions;
  }, [data.customFieldDefs]);

  return (
    <div>
      {data.loadError ? (
        <div role="alert" style={{ fontSize: 12, marginBottom: 10 }}>
          {data.loadError}
          <div style={{ marginTop: 6 }}>
            <button type="button" className="btn btn-sm" onClick={data.reload}>
              Retry subscriber metadata
            </button>
          </div>
        </div>
      ) : null}
      {subscriberId != null ? (
        <SubscriberListMembershipsSection
          subscriberId={String(subscriberId)}
          canMutate={canMutate}
        />
      ) : null}
      <SubscriberTagsSection
        tags={detail.tags ?? []}
        canMutate={canMutate}
        hasSubscriberId={subscriberId != null}
        onAdd={mutations.addTag}
        onRemove={mutations.removeTag}
      />
      <SubscriberGroupsSection groups={data.groupMemberships} />
      <SubscriberCustomFieldsSection
        fields={customFields}
        definitions={customFieldDefinitions}
        canMutate={canMutate}
        onRequestRemove={onRequestCustomFieldRemoval}
      />
      <SubscriberMergeFieldsSection
        schema={data.mergeFieldSchema}
        values={data.mergeFieldValues}
        canMutate={canMutate}
        onSave={mutations.setMergeField}
      />
      <ConsentProvenance detail={detail} />
      <PurposeConsentSection detail={detail} />
      <TrackingPrefsPanel
        prefs={data.trackingPrefs}
        saving={data.trackingSaving}
        err={data.trackingError}
        canMutate={canMutate && Boolean(data.trackingVersion)}
        onToggle={mutations.toggleTracking}
        onRetry={data.reload}
      />
      {subscriberId != null && !channelConsentsUnavailable ? (
        <ChannelConsentsPanel
          subscriberId={String(subscriberId)}
          subscriberVersion={detail.version}
          canMutate={canMutate}
          onSubscriberVersionChange={(version) => {
            const updated = { ...detail, version };
            onDetailChange(updated);
            onPersistedDetailChange(updated, { version });
          }}
          onUnavailable={onChannelConsentsUnavailable}
        />
      ) : null}
      {subscriberId != null ? (
        <FrequencyPreferencePanel
          subscriberId={subscriberId}
          version={detail.version}
          frequencyPreference={detail.frequency_preference}
          pausedUntil={detail.paused_until}
          canMutate={canMutate}
          onChange={(updated) => {
            onDetailChange(updated);
            onPersistedDetailChange(updated);
          }}
        />
      ) : null}
      {subscriberId != null ? (
        <SendTimesPanel subscriberId={String(subscriberId)} />
      ) : null}
      {subscriberId != null && !gppUnavailable ? (
        <GppSectionsPanel
          subscriberId={String(subscriberId)}
          onUnavailable={onGppUnavailable}
        />
      ) : null}
    </div>
  );
}

function SubscriberTagsSection({
  tags,
  canMutate,
  hasSubscriberId,
  onAdd,
  onRemove,
}: {
  tags: string[];
  canMutate: boolean;
  hasSubscriberId: boolean;
  onAdd: (tag: string) => Promise<void>;
  onRemove: (tag: string) => Promise<void>;
}): ReactElement {
  const guidanceId = useId();
  return (
    <>
      <div className="label">Tags</div>
      {tags.length === 0 && !(canMutate && hasSubscriberId) ? (
        <div className="muted" style={{ fontSize: 12 }}>
          —
        </div>
      ) : (
        <div
          className="chip-list"
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: 6,
          }}
        >
          {tags.map((tag) => (
            <span key={tag} className="chip-removable">
              <span>{tag}</span>
              <button
                type="button"
                aria-label={`Remove tag ${tag}`}
                aria-disabled={!canMutate || undefined}
                aria-describedby={!canMutate ? guidanceId : undefined}
                onClick={() => {
                  if (canMutate) void onRemove(tag);
                }}
              >
                ×
              </button>
            </span>
          ))}
          {canMutate && hasSubscriberId ? <AddTagButton onAdd={onAdd} /> : null}
        </div>
      )}
      {!canMutate ? (
        <p
          id={guidanceId}
          className="muted"
          role="status"
          style={{ fontSize: 11, margin: "4px 0 0" }}
        >
          Viewer role can inspect tags but can&apos;t add or remove them.
        </p>
      ) : null}
    </>
  );
}

function SubscriberGroupsSection({
  groups,
}: {
  groups: SubscriberGroupMembership[];
}): ReactElement | null {
  if (groups.length === 0) return null;
  const byCategory = new Map<string, SubscriberGroupMembership[]>();
  for (const membership of groups) {
    const category = membership.category || "Other";
    const existing = byCategory.get(category);
    if (existing) existing.push(membership);
    else byCategory.set(category, [membership]);
  }
  return (
    <div style={{ marginTop: 12 }}>
      <div className="label">Groups</div>
      <div style={{ display: "grid", gap: 8 }}>
        {[...byCategory.entries()].map(([category, memberships]) => (
          <div key={category}>
            <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>
              {category}
            </div>
            <div className="chip-list">
              {memberships.map((membership) => (
                <span
                  key={membership.group_id}
                  className="chip"
                  style={{ whiteSpace: "normal", flexWrap: "wrap" }}
                >
                  <strong>{membership.name}</strong>
                  <span className="muted" style={{ fontSize: 10 }}>
                    Joined{" "}
                    <time dateTime={membership.joined_at}>
                      {fmtDate(membership.joined_at)}
                    </time>
                    {membership.type ? ` · ${membership.type}` : ""}
                  </span>
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function SubscriberCustomFieldsSection({
  fields,
  definitions,
  canMutate,
  onRequestRemove,
}: {
  fields: Array<[string, unknown]>;
  definitions: Record<string, CustomField>;
  canMutate: boolean;
  onRequestRemove: (field: {
    key: string;
    label: string;
    type: CustomField["type"] | undefined;
    classification: DataClassification | undefined;
  }) => void;
}): ReactElement | null {
  const permissionReasonId = useId();
  if (fields.length === 0) return null;
  return (
    <div style={{ marginTop: 12 }}>
      <div className="label">Custom fields</div>
      <div className="chip-list">
        {fields.map(([key, value]) => (
          <CustomFieldChip
            key={key}
            fieldKey={key}
            value={value}
            definition={definitions[key]}
            canMutate={canMutate}
            permissionReasonId={permissionReasonId}
            onRequestRemove={onRequestRemove}
          />
        ))}
      </div>
      {!canMutate ? (
        <p
          id={permissionReasonId}
          className="muted"
          role="status"
          style={{ fontSize: 11, margin: "4px 0 0" }}
        >
          Viewer role can inspect custom fields but can&apos;t remove them.
        </p>
      ) : null}
    </div>
  );
}

function CustomFieldChip({
  fieldKey,
  value,
  definition,
  canMutate,
  permissionReasonId,
  onRequestRemove,
}: {
  fieldKey: string;
  value: unknown;
  definition: CustomField | undefined;
  canMutate: boolean;
  permissionReasonId: string;
  onRequestRemove: (field: {
    key: string;
    label: string;
    type: CustomField["type"] | undefined;
    classification: DataClassification | undefined;
  }) => void;
}): ReactElement {
  const annotation = customFieldAnnotation(definition, value);
  const classification = classificationBadge(
    definition?.config?.data_classification,
  );
  return (
    <span className="chip-removable">
      <span>
        <span className="muted">{definition?.label || fieldKey}:</span>{" "}
        {customFieldDisplayValue(definition, value)}
        {classification ? (
          <span style={{ display: "inline-flex", flexWrap: "wrap", gap: 4 }}>
            <span
              className={classification.className}
              style={{ marginLeft: 4, fontSize: 10 }}
              aria-label={`Data classification: ${classification.label}`}
            >
              {classification.label}
            </span>
            <span className="muted" style={{ fontSize: 10 }}>
              {classification.tip}
            </span>
          </span>
        ) : null}
        {annotation?.valid === true ? (
          <span
            style={{ marginLeft: 4, color: "var(--pw-success)" }}
            aria-label="Valid format"
          >
            ✓ Valid format
          </span>
        ) : annotation?.valid === false ? (
          <span
            style={{ marginLeft: 4, color: "var(--pw-danger)" }}
            aria-label="Invalid format"
          >
            ✗ Value does not match the expected format
          </span>
        ) : null}
        {annotation ? (
          <span
            style={{
              display: "inline-flex",
              marginLeft: 4,
              verticalAlign: "middle",
            }}
          >
            <InlineHelp text={annotation.tip} />
          </span>
        ) : null}
      </span>
      <button
        type="button"
        aria-label={`Remove ${definition?.label || fieldKey}`}
        aria-disabled={!canMutate || undefined}
        aria-describedby={!canMutate ? permissionReasonId : undefined}
        onClick={() => {
          if (canMutate) {
            onRequestRemove({
              key: fieldKey,
              label: definition?.label || fieldKey,
              type: definition?.type,
              classification:
                definition?.config?.data_classification ?? undefined,
            });
          }
        }}
      >
        ×
      </button>
    </span>
  );
}

function SubscriberMergeFieldsSection({
  schema,
  values,
  canMutate,
  onSave,
}: {
  schema: MergeFieldSchema[];
  values: Record<string, string>;
  canMutate: boolean;
  onSave: (key: string, value: string) => Promise<void>;
}): ReactElement | null {
  if (schema.length === 0) return null;
  return (
    <div style={{ marginTop: 12 }}>
      <div className="label">Merge fields</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {schema.map((field) => (
          <MergeFieldRow
            key={field.key}
            schema={field}
            value={values[field.key] ?? field.default_value ?? ""}
            onSave={(value) => onSave(field.key, value)}
            disabled={!canMutate}
          />
        ))}
      </div>
    </div>
  );
}

interface MergeFieldValueValidation {
  error: string | null;
  hint: string;
}

function unicodeLength(value: string): number {
  return Array.from(value).length;
}

function isRealCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  if (!year || year < 1) return false;
  const parsed = new Date(Date.UTC(year, month! - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() + 1 === month &&
    parsed.getUTCDate() === day
  );
}

function validateMergeFieldValue(
  schema: MergeFieldSchema,
  value: string,
): MergeFieldValueValidation {
  const normalized = value.trim();
  const requiredHint = schema.required
    ? "This field is required."
    : "Leave blank to use the field default.";
  if (unicodeLength(normalized) > MAX_MERGE_FIELD_VALUE_LENGTH) {
    return {
      error: `Use ${MAX_MERGE_FIELD_VALUE_LENGTH.toLocaleString()} characters or fewer.`,
      hint: requiredHint,
    };
  }
  if (!normalized) {
    return {
      error: schema.required ? `${schema.label} can't be empty.` : null,
      hint: requiredHint,
    };
  }

  switch (schema.type) {
    case "number":
      return {
        error: Number.isFinite(Number(normalized))
          ? null
          : "Enter a finite number.",
        hint: "Use digits and an optional decimal or exponent (for example, 42 or 3.14).",
      };
    case "boolean":
      return {
        error:
          normalized === "true" || normalized === "false"
            ? null
            : "Choose True or False.",
        hint: "Choose the subscriber's explicit True or False value.",
      };
    case "date":
      return {
        error: isRealCalendarDate(normalized)
          ? null
          : "Enter a real calendar date in YYYY-MM-DD format.",
        hint: "Use a complete calendar date in YYYY-MM-DD format.",
      };
    case "address":
      return {
        error: null,
        hint: "Enter a postal address. Line breaks are supported.",
      };
    case "phone": {
      const extensionMatch = normalized.match(/\s*(?:x|ext\.?)\s*\d{1,8}$/i);
      const mainNumber = extensionMatch
        ? normalized.slice(0, extensionMatch.index).trim()
        : normalized;
      const digitCount = (mainNumber.match(/\d/g) ?? []).length;
      const supportedCharacters = /^\+?[\d().\-\s]+$/.test(mainNumber);
      return {
        error:
          supportedCharacters && digitCount >= 7 && digitCount <= 15
            ? null
            : "Enter a phone number with 7–15 digits using +, spaces, parentheses, periods, or hyphens.",
        hint: "Include the country code when possible. Add an extension as x123 or ext. 123.",
      };
    }
    case "text":
    default:
      return { error: null, hint: requiredHint };
  }
}

function MergeFieldValueControl({
  schema,
  id,
  guidanceId,
  value,
  validation,
  disabled,
  saving,
  onChange,
}: {
  schema: MergeFieldSchema;
  id: string;
  guidanceId: string;
  value: string;
  validation: MergeFieldValueValidation;
  disabled: boolean;
  saving: boolean;
  onChange: (value: string) => void;
}): ReactElement {
  const invalid = Boolean(validation.error);
  const style = { flex: "1 1 180px" };
  const type: MergeFieldType = schema.type ?? "text";

  if (type === "boolean") {
    const unsupportedValue =
      value !== "" && value !== "true" && value !== "false";
    return (
      <select
        id={id}
        className="input"
        value={value}
        disabled={disabled || saving}
        aria-invalid={invalid || undefined}
        aria-describedby={guidanceId}
        style={style}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">
          {schema.required ? "Select True or False" : "Not set"}
        </option>
        {unsupportedValue ? (
          <option value={value}>{`Unsupported value: ${value}`}</option>
        ) : null}
        <option value="true">True</option>
        <option value="false">False</option>
      </select>
    );
  }

  if (type === "address") {
    return (
      <textarea
        id={id}
        className="input"
        value={value}
        rows={2}
        maxLength={MAX_MERGE_FIELD_VALUE_LENGTH}
        disabled={saving}
        readOnly={disabled}
        aria-disabled={disabled || undefined}
        aria-invalid={invalid || undefined}
        aria-describedby={guidanceId}
        autoComplete="street-address"
        placeholder={
          schema.default_value || "Street, city, region, postal code"
        }
        style={{ ...style, resize: "vertical" }}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  }

  const nativeNumber =
    type === "number" &&
    (value.trim() === "" || Number.isFinite(Number(value.trim())));
  const nativeDate =
    type === "date" &&
    (value.trim() === "" || isRealCalendarDate(value.trim()));
  const inputType =
    type === "phone"
      ? "tel"
      : nativeNumber
        ? "number"
        : nativeDate
          ? "date"
          : "text";
  const placeholder =
    schema.default_value ||
    (type === "number"
      ? "0"
      : type === "date"
        ? "YYYY-MM-DD"
        : type === "phone"
          ? "+1 415 555 0123"
          : schema.label);
  return (
    <input
      id={id}
      className="input"
      type={inputType}
      step={nativeNumber ? "any" : undefined}
      inputMode={
        type === "number" ? "decimal" : type === "phone" ? "tel" : undefined
      }
      value={value}
      maxLength={
        inputType === "text" || inputType === "tel"
          ? MAX_MERGE_FIELD_VALUE_LENGTH
          : undefined
      }
      disabled={saving}
      readOnly={disabled}
      aria-disabled={disabled || undefined}
      aria-invalid={invalid || undefined}
      aria-describedby={guidanceId}
      autoComplete={type === "phone" ? "tel" : "off"}
      placeholder={placeholder}
      style={style}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

function MergeFieldRow({
  schema,
  value,
  onSave,
  disabled,
}: {
  schema: MergeFieldSchema;
  value: string;
  onSave: (value: string) => Promise<void>;
  disabled?: boolean;
}): ReactElement {
  const inputId = useId();
  const guidanceId = useId();
  const [localValue, setLocalValue] = useState(value);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  useEffect(() => {
    setLocalValue(value);
  }, [value]);
  const dirty = localValue !== value;
  const validation = validateMergeFieldValue(schema, localValue);
  const saveDisabled = Boolean(
    disabled || !dirty || validation.error || saving,
  );
  const save = async (): Promise<void> => {
    if (disabled || !dirty || validation.error || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      await onSave(localValue);
    } finally {
      savingRef.current = false;
      if (mountedRef.current) setSaving(false);
    }
  };
  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: 6,
        alignItems: "center",
        fontSize: 12,
      }}
    >
      <label
        htmlFor={inputId}
        style={{ display: "grid", flex: "0 1 140px", gap: 2 }}
      >
        <code style={{ fontSize: 11, overflowWrap: "anywhere" }}>
          {schema.key}
        </code>
        <span className="muted" style={{ fontSize: 10 }}>
          {schema.label}
        </span>
      </label>
      <MergeFieldValueControl
        schema={schema}
        id={inputId}
        guidanceId={guidanceId}
        value={localValue}
        validation={validation}
        disabled={Boolean(disabled)}
        saving={saving}
        onChange={setLocalValue}
      />
      <button
        type="button"
        className="btn btn-sm btn-primary"
        disabled={saveDisabled}
        aria-disabled={saveDisabled || undefined}
        aria-describedby={guidanceId}
        onClick={() => void save()}
      >
        {saving ? "Saving…" : "Save"}
      </button>
      <span
        id={guidanceId}
        className="muted"
        role="status"
        aria-live="polite"
        style={{ flexBasis: "100%", fontSize: 10 }}
      >
        {saving
          ? `Saving ${schema.label}.`
          : disabled
            ? `Viewer role can inspect ${schema.label} but can't change it.`
            : validation.error
              ? validation.error
              : dirty
                ? `Save updates ${schema.label} for this subscriber.`
                : `Change ${schema.label} before saving.`}{" "}
        {!saving && !disabled ? validation.hint : null}
      </span>
    </div>
  );
}

function ConsentProvenance({
  detail,
}: {
  detail: SubscriberDetail;
}): ReactElement {
  const rawSource = (detail.consent_source ?? "").trim();
  const timestamp = (detail.consent_timestamp ?? "").trim();
  const sourceLabel = rawSource
    ? (CONSENT_SOURCE_LABELS[rawSource.toLowerCase()] ?? rawSource)
    : "";
  const dateLabel = timestamp ? fmtDate(timestamp) : "";
  const hasProvenance = Boolean(sourceLabel) || Boolean(dateLabel);
  const sourceCanDescribeOptIn = [
    "double_optin",
    "single_optin",
    "form",
  ].includes(rawSource.toLowerCase());
  const sourceAndTimeRecorded = sourceCanDescribeOptIn && Boolean(timestamp);
  return (
    <div style={{ marginBottom: 10 }}>
      <div className="label">Consent provenance</div>
      {hasProvenance ? (
        <div
          className="muted"
          style={{ fontSize: 12, display: "grid", gap: 2 }}
        >
          <div>
            How: <strong>{sourceLabel || "Not recorded"}</strong>
          </div>
          <div>
            When:{" "}
            {timestamp ? (
              <time className="tabular" dateTime={timestamp}>
                {dateLabel}
              </time>
            ) : (
              <span>Not recorded</span>
            )}
          </div>
          <div
            className={sourceAndTimeRecorded ? "badge" : "badge warning"}
            style={{ justifySelf: "start", marginTop: 2 }}
          >
            {sourceAndTimeRecorded
              ? "Source and timestamp recorded"
              : "Incomplete provenance · not consent proof"}
          </div>
          <div style={{ fontSize: 11 }}>
            Profile provenance alone does not establish send eligibility. Verify
            the purpose and channel consent ledgers below.
          </div>
        </div>
      ) : (
        <div className="muted" style={{ fontSize: 12 }}>
          No recorded opt-in provenance. Treat permission as absent until the
          purpose and channel consent ledgers contain defensible evidence.
        </div>
      )}
    </div>
  );
}
