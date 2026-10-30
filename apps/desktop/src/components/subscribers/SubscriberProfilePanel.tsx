import {
  type Dispatch,
  type MutableRefObject,
  type ReactElement,
  type SetStateAction,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import {
  type PredictionMetadata,
  type SubscriberAlias,
  type SubscriberComputedTrait,
  type SubscriberDetail,
  type SubscriberLifecycle,
  type SubscriberLifecycleStage,
  SUBSCRIBER_LIFECYCLE_STAGES,
  api,
} from "../../lib/api-client";
import { queueReceiptMessage } from "../../lib/api/result";
import { fmtDateTime } from "../../lib/format-date";
import {
  type LocalizationDraft,
  buildLocalizationPatch,
  localizationDirty,
  localizationDraftFrom,
  validateLocalization,
} from "../../lib/localization-helpers";
import { ConfirmModal } from "../ConfirmModal";
import { FormField } from "../FormField";
import { PendingSyncStatus } from "../PendingSyncStatus";
import { AccessibleChartData } from "../charts/AccessibleChartData";
import { dux025Provenance } from "../charts/dux-025-visual-manifest";
import { AccountSection } from "./AccountSection";
import { CatalogAttributesPanel } from "./CatalogAttributesPanel";
import { DemographicsPanel } from "./DemographicsPanel";
import { FederatedIdentityPanel } from "./FederatedIdentityPanel";
import { IdentifierNormalizationDisclosure } from "./SubscriberPrivacyPanels";
import { ReplenishmentCadencePanel } from "./ReplenishmentCadencePanel";
import { SubscriberEmailsSection } from "./SubscriberEmailsSection";
import { toast } from "../Toast";

interface SubscriberProfilePanelProps {
  active: boolean;
  subscriberId: string | number | null | undefined;
  detail: SubscriberDetail;
  canMutate: boolean;
  onPersistedDetailChange: (updated: SubscriberDetail) => void;
  onRefreshDetail: () => void;
  formatRelativeTime: (timestamp: string | undefined | null) => string;
}

const ALIAS_TYPE_OPTIONS: ReadonlyArray<{
  value: SubscriberAlias["alias_type"];
  label: string;
  placeholder: string;
}> = [
  {
    value: "external_id",
    label: "External customer ID",
    placeholder: "e.g. crm_48291",
  },
  {
    value: "anonymous_id",
    label: "Anonymous visitor ID",
    placeholder: "e.g. visitor_7f91",
  },
  {
    value: "device_token",
    label: "Device token",
    placeholder: "Device identifier",
  },
  {
    value: "push_token",
    label: "Push token",
    placeholder: "Push-provider token",
  },
  {
    value: "custom",
    label: "Custom identifier",
    placeholder: "Namespaced identifier",
  },
];

function aliasTypeLabel(type: SubscriberAlias["alias_type"]): string {
  return (
    ALIAS_TYPE_OPTIONS.find((option) => option.value === type)?.label ??
    lifecycleLabel(type)
  );
}

function aliasUsesVerifiedContactWorkflow(
  type: SubscriberAlias["alias_type"],
): boolean {
  return type === "email" || type === "phone";
}

function lifecycleLabel(stage: SubscriberLifecycleStage | string): string {
  return String(stage)
    .split("_")
    .map((part) => (part ? part[0]!.toUpperCase() + part.slice(1) : part))
    .join(" ");
}

const LIFECYCLE_STAGE_DESCRIPTIONS: Record<SubscriberLifecycleStage, string> = {
  subscriber: "Known contact without a qualified buying signal yet.",
  lead: "Showing early interest and ready for lightweight qualification.",
  mql: "Marketing-qualified based on fit or meaningful engagement.",
  sql: "Sales-qualified and ready for direct commercial follow-up.",
  opportunity: "An active deal or concrete buying process is underway.",
  customer: "Has completed a purchase or active customer conversion.",
  evangelist: "A high-advocacy customer likely to refer or champion the brand.",
  other: "A reviewed lifecycle state outside the standard progression.",
};

type PredictionState = "loading" | "loaded" | "unavailable" | "error";
type LifecycleState = "loading" | "loaded" | "unavailable" | "error";
type OptionalProfileSection =
  | "account"
  | "catalog"
  | "demographics"
  | "emails"
  | "federation"
  | "replenishment";

interface NameDraft {
  first_name: string;
  last_name: string;
  full_name: string;
  display_name: string;
}

function useSubscriberProfileGraph(
  subscriberId: string | number | null | undefined,
  active: boolean,
) {
  const [profileGraphUnavailable, setProfileGraphUnavailable] = useState(false);
  const [profileGraphError, setProfileGraphError] = useState<string | null>(
    null,
  );
  const [reloadNonce, setReloadNonce] = useState(0);
  const [predictionMetadata, setPredictionMetadata] = useState<
    PredictionMetadata[]
  >([]);
  const [predictionState, setPredictionState] =
    useState<PredictionState>("loading");
  const [predictionFeaturesOpen, setPredictionFeaturesOpen] = useState<
    Record<string, boolean>
  >({});
  const [lifecycle, setLifecycle] = useState<SubscriberLifecycle | null>(null);
  const [lifecycleState, setLifecycleState] =
    useState<LifecycleState>("loading");
  const [aliases, setAliases] = useState<SubscriberAlias[]>([]);
  const [traits, setTraits] = useState<SubscriberComputedTrait[]>([]);

  useEffect(() => {
    const controller = new AbortController();
    if (!active) return () => controller.abort();
    if (subscriberId == null) {
      setPredictionState("unavailable");
      setLifecycleState("unavailable");
      return () => controller.abort();
    }
    setProfileGraphError(null);
    setProfileGraphUnavailable(false);
    setPredictionState("loading");
    setLifecycleState("loading");

    void (async () => {
      let results: Awaited<
        ReturnType<
          () => Promise<
            [
              Awaited<ReturnType<typeof api.getSubscriberLifecycle>>,
              Awaited<ReturnType<typeof api.listSubscriberAliases>>,
              Awaited<ReturnType<typeof api.listSubscriberTraits>>,
              Awaited<ReturnType<typeof api.getSubscriberPredictionMetadata>>,
            ]
          >
        >
      >;
      try {
        results = await Promise.all([
          api.getSubscriberLifecycle(subscriberId, {
            signal: controller.signal,
          }),
          api.listSubscriberAliases(subscriberId, {
            signal: controller.signal,
          }),
          api.listSubscriberTraits(subscriberId, {
            signal: controller.signal,
          }),
          api.getSubscriberPredictionMetadata(String(subscriberId), {
            signal: controller.signal,
          }),
        ]);
      } catch {
        if (!controller.signal.aborted) {
          setProfileGraphError(
            "Couldn't load profile graph data. Check your connection and retry.",
          );
          setPredictionState("error");
          setLifecycleState("error");
        }
        return;
      }
      const [lifecycleResult, aliasesResult, traitsResult, predictionResult] =
        results;
      if (controller.signal.aborted) return;

      if (lifecycleResult.data) {
        setLifecycle(lifecycleResult.data);
        setLifecycleState("loaded");
      } else if (
        lifecycleResult.error?.kind === "http" &&
        (lifecycleResult.error.status === 404 ||
          lifecycleResult.error.status === 501)
      ) {
        setLifecycleState("unavailable");
      } else {
        setLifecycleState("error");
      }
      if (aliasesResult.data) setAliases(aliasesResult.data.items ?? []);
      if (traitsResult.data) setTraits(traitsResult.data.items ?? []);
      const graphErrors = [
        lifecycleResult.error,
        aliasesResult.error,
        traitsResult.error,
      ];
      setProfileGraphUnavailable(
        graphErrors.some(
          (error) =>
            error?.kind === "http" &&
            (error.status === 404 || error.status === 501),
        ),
      );
      const recoverableGraphError = graphErrors.find(
        (error) =>
          error &&
          !(
            error.kind === "http" &&
            (error.status === 404 || error.status === 501)
          ),
      );
      if (recoverableGraphError) {
        setProfileGraphError(
          "Some profile graph data couldn't be loaded. Retry to restore the missing sections.",
        );
      }

      if (predictionResult.error) {
        setPredictionState(
          predictionResult.error.kind === "http" &&
            predictionResult.error.status === 404
            ? "unavailable"
            : "error",
        );
      } else {
        setPredictionMetadata(predictionResult.data.items ?? []);
        setPredictionState("loaded");
      }
    })();

    return () => controller.abort();
  }, [active, reloadNonce, subscriberId]);

  return {
    aliases,
    lifecycle,
    lifecycleState,
    predictionFeaturesOpen,
    predictionMetadata,
    predictionState,
    profileGraphUnavailable,
    profileGraphError,
    setAliases,
    setLifecycle,
    setPredictionFeaturesOpen,
    retryProfileGraph: () => setReloadNonce((current) => current + 1),
    traits,
  };
}

/**
 * Complete Profile-tab controller and rendering boundary. It remains mounted
 * while tabs change so profile graph data stays warm, matching the previous
 * eager slideover behavior.
 */
export function SubscriberProfilePanel({
  ...props
}: SubscriberProfilePanelProps): ReactElement {
  const subscriberKey =
    props.subscriberId == null
      ? "none:"
      : `${typeof props.subscriberId}:${String(props.subscriberId)}`;
  return <SubscriberProfilePanelState key={subscriberKey} {...props} />;
}

function useAliasMutations({
  subscriberId,
  detail,
  canMutate,
  aliasType,
  aliasValue,
  setAliasValue,
  aliases,
  setAliases,
  onPersistedDetailChange,
  requestGeneration,
}: {
  subscriberId: string | number | null | undefined;
  detail: SubscriberDetail;
  canMutate: boolean;
  aliasType: SubscriberAlias["alias_type"];
  aliasValue: string;
  setAliasValue: Dispatch<SetStateAction<string>>;
  aliases: SubscriberAlias[];
  setAliases: Dispatch<SetStateAction<SubscriberAlias[]>>;
  onPersistedDetailChange: (updated: SubscriberDetail) => void;
  requestGeneration: MutableRefObject<number>;
}): {
  saving: boolean;
  add: () => Promise<void>;
  remove: (alias: SubscriberAlias) => Promise<void>;
} {
  const [saving, setSaving] = useState(false);
  const inFlightRef = useRef(false);

  const add = async (): Promise<void> => {
    if (subscriberId == null || !canMutate || inFlightRef.current) return;
    const value = aliasValue.trim();
    if (!value) return;
    const generation = requestGeneration.current;
    inFlightRef.current = true;
    setSaving(true);
    let result: Awaited<ReturnType<typeof api.upsertSubscriberAlias>>;
    try {
      result = await api.upsertSubscriberAlias(
        subscriberId,
        {
          alias_type: aliasType,
          alias_value: value,
          source: "desktop",
          provenance: { surface: "subscriber_slideover" },
        },
        detail.version ?? "",
      );
    } catch {
      inFlightRef.current = false;
      if (generation === requestGeneration.current) {
        setSaving(false);
        toast.error("Couldn't save alias. Check your connection and retry.");
      }
      return;
    }
    inFlightRef.current = false;
    if (generation !== requestGeneration.current) return;
    setSaving(false);
    if (result.error) {
      toast.error(`Couldn't save alias: ${result.error.message}`);
      return;
    }
    if (result.data) {
      const savedAlias = result.data;
      setAliases((previous) => [
        savedAlias,
        ...previous.filter((alias) => alias.id !== savedAlias.id),
      ]);
      onPersistedDetailChange({
        ...detail,
        version: savedAlias.subscriber_version,
        external_id: savedAlias.external_id ?? undefined,
      });
      setAliasValue("");
      toast.success("Alias saved");
    }
  };

  const remove = async (alias: SubscriberAlias): Promise<void> => {
    if (subscriberId == null || !canMutate || inFlightRef.current) return;
    const generation = requestGeneration.current;
    const previous = aliases;
    inFlightRef.current = true;
    setSaving(true);
    setAliases((items) => items.filter((item) => item.id !== alias.id));
    let result: Awaited<ReturnType<typeof api.deleteSubscriberAlias>>;
    try {
      result = await api.deleteSubscriberAlias(
        subscriberId,
        alias.id,
        detail.version ?? "",
      );
    } catch {
      inFlightRef.current = false;
      if (generation === requestGeneration.current) {
        setSaving(false);
        setAliases(previous);
        toast.error("Couldn't delete alias. Check your connection and retry.");
      }
      return;
    }
    inFlightRef.current = false;
    if (generation !== requestGeneration.current) return;
    setSaving(false);
    if (result.error) {
      setAliases(previous);
      toast.error(`Couldn't delete alias: ${result.error.message}`);
      return;
    }
    onPersistedDetailChange({
      ...detail,
      version: result.data.subscriber_version,
      external_id: result.data.external_id ?? undefined,
    });
    toast.success("Alias deleted");
  };

  return { saving, add, remove };
}

function SubscriberProfilePanelState({
  active,
  subscriberId,
  detail,
  canMutate,
  onPersistedDetailChange,
  onRefreshDetail,
  formatRelativeTime,
}: SubscriberProfilePanelProps): ReactElement | null {
  const requestGeneration = useRef(0);
  const operationRef = useRef({
    names: false,
    localization: false,
    lifecycle: false,
  });
  const [unavailableSections, setUnavailableSections] = useState<
    ReadonlySet<OptionalProfileSection>
  >(() => new Set());
  const profileGraph = useSubscriberProfileGraph(subscriberId, active);
  const [lifecycleSaving, setLifecycleSaving] = useState(false);
  const [aliasType, setAliasType] =
    useState<SubscriberAlias["alias_type"]>("external_id");
  const [aliasValue, setAliasValue] = useState("");
  const aliasMutations = useAliasMutations({
    subscriberId,
    detail,
    canMutate,
    aliasType,
    aliasValue,
    setAliasValue,
    aliases: profileGraph.aliases,
    setAliases: profileGraph.setAliases,
    onPersistedDetailChange,
    requestGeneration,
  });

  const [nameDraft, setNameDraft] = useState<NameDraft>(() => ({
    first_name: detail.first_name ?? "",
    last_name: detail.last_name ?? "",
    full_name: detail.full_name ?? "",
    display_name: detail.display_name ?? "",
  }));
  const [nameSaving, setNameSaving] = useState(false);
  const [localizationDraft, setLocalizationDraft] = useState<LocalizationDraft>(
    () => localizationDraftFrom(detail),
  );
  const [localizationSaving, setLocalizationSaving] = useState(false);

  useEffect(
    () => () => {
      requestGeneration.current += 1;
    },
    [],
  );

  useEffect(() => {
    setNameDraft({
      first_name: detail.first_name ?? "",
      last_name: detail.last_name ?? "",
      full_name: detail.full_name ?? "",
      display_name: detail.display_name ?? "",
    });
  }, [
    detail.first_name,
    detail.last_name,
    detail.full_name,
    detail.display_name,
  ]);

  useEffect(() => {
    setLocalizationDraft(localizationDraftFrom(detail));
  }, [detail.locale, detail.language, detail.country, detail.region]);

  const namesDirty =
    nameDraft.first_name !== (detail.first_name ?? "") ||
    nameDraft.last_name !== (detail.last_name ?? "") ||
    nameDraft.full_name !== (detail.full_name ?? "") ||
    nameDraft.display_name !== (detail.display_name ?? "");
  const localizationIsDirty = localizationDirty(localizationDraft, detail);
  const renderGeneration = requestGeneration.current;
  const persistDetailIfCurrent = (updated: SubscriberDetail): void => {
    if (renderGeneration === requestGeneration.current) {
      onPersistedDetailChange(updated);
    }
  };
  const markUnavailable = (section: OptionalProfileSection): void => {
    setUnavailableSections((current) => {
      if (current.has(section)) return current;
      return new Set([...current, section]);
    });
  };

  const saveNames = async (): Promise<void> => {
    if (subscriberId == null || !canMutate || operationRef.current.names)
      return;
    const generation = requestGeneration.current;
    const draftSnapshot = { ...nameDraft };
    operationRef.current.names = true;
    setNameSaving(true);
    let result: Awaited<ReturnType<typeof api.updateSubscriber>>;
    try {
      result = await api.updateSubscriber(
        subscriberId,
        {
          first_name: draftSnapshot.first_name,
          last_name: draftSnapshot.last_name,
          full_name: draftSnapshot.full_name,
          display_name: draftSnapshot.display_name,
        },
        { version: detail.version ?? "" },
      );
    } catch {
      operationRef.current.names = false;
      if (generation === requestGeneration.current) {
        setNameSaving(false);
        toast.error("Couldn't save names. Check your connection and retry.");
      }
      return;
    }
    operationRef.current.names = false;
    if (generation !== requestGeneration.current) return;
    setNameSaving(false);
    if (result.error) {
      toast.error(`Couldn't save names: ${result.error.message}`);
      return;
    }
    if (result.queued) {
      onPersistedDetailChange({
        ...detail,
        first_name: draftSnapshot.first_name,
        last_name: draftSnapshot.last_name,
        full_name: draftSnapshot.full_name,
        display_name: draftSnapshot.display_name,
      });
      toast.info(queueReceiptMessage(result.receipt));
    } else if (result.data) {
      onPersistedDetailChange(result.data);
      toast.success("Names saved");
    }
  };

  const saveLocalization = async (): Promise<void> => {
    if (
      subscriberId == null ||
      !canMutate ||
      operationRef.current.localization
    ) {
      return;
    }
    const patch = buildLocalizationPatch({ ...localizationDraft });
    const validationError = validateLocalization(patch);
    if (validationError) {
      toast.error(validationError);
      return;
    }
    const generation = requestGeneration.current;
    operationRef.current.localization = true;
    setLocalizationSaving(true);
    let result: Awaited<ReturnType<typeof api.updateSubscriber>>;
    try {
      result = await api.updateSubscriber(subscriberId, patch, {
        version: detail.version ?? "",
      });
    } catch {
      operationRef.current.localization = false;
      if (generation === requestGeneration.current) {
        setLocalizationSaving(false);
        toast.error(
          "Couldn't save localization. Check your connection and retry.",
        );
      }
      return;
    }
    operationRef.current.localization = false;
    if (generation !== requestGeneration.current) return;
    setLocalizationSaving(false);
    if (result.error) {
      toast.error(`Couldn't save localization: ${result.error.message}`);
      return;
    }
    if (result.queued) {
      onPersistedDetailChange({ ...detail, ...patch });
      toast.info(queueReceiptMessage(result.receipt));
    } else if (result.data) {
      onPersistedDetailChange(result.data);
      toast.success("Localization saved");
    }
  };

  const setLifecycle = async (
    stage: SubscriberLifecycleStage,
    score: number,
  ): Promise<void> => {
    if (
      subscriberId == null ||
      !canMutate ||
      profileGraph.lifecycleState !== "loaded" ||
      !profileGraph.lifecycle ||
      operationRef.current.lifecycle
    ) {
      return;
    }
    const generation = requestGeneration.current;
    const previous = profileGraph.lifecycle;
    operationRef.current.lifecycle = true;
    setLifecycleSaving(true);
    let result: Awaited<ReturnType<typeof api.putSubscriberLifecycle>>;
    try {
      result = await api.putSubscriberLifecycle(
        subscriberId,
        {
          stage,
          score,
          source: "desktop",
        },
        previous.subscriber_version,
      );
    } catch {
      operationRef.current.lifecycle = false;
      if (generation === requestGeneration.current) {
        setLifecycleSaving(false);
        toast.error(
          "Couldn't update lifecycle. Check your connection and retry.",
        );
      }
      return;
    }
    operationRef.current.lifecycle = false;
    if (generation !== requestGeneration.current) return;
    setLifecycleSaving(false);
    if (result.error) {
      if (result.error.kind === "http" && result.error.status === 412) {
        profileGraph.retryProfileGraph();
        onRefreshDetail();
        toast.error(
          "This subscriber changed elsewhere. The latest profile is loading; your lifecycle draft is still here to review.",
        );
      } else {
        toast.error(
          "Couldn't update lifecycle. Check your connection and retry.",
        );
      }
      return;
    }
    if (result.data) {
      profileGraph.setLifecycle(result.data);
      onPersistedDetailChange({
        ...detail,
        version: result.data.subscriber_version,
        updated_at: result.data.updated_at,
      });
    }
    toast.success(
      previous?.stage === stage
        ? `Lifecycle score updated to ${score}/5`
        : `Lifecycle moved to ${lifecycleLabel(stage)}`,
    );
  };

  if (!active) return null;

  return (
    <SubscriberProfilePanelContent
      subscriberId={subscriberId}
      detail={detail}
      canMutate={canMutate}
      profileGraph={profileGraph}
      nameDraft={nameDraft}
      nameSaving={nameSaving}
      namesDirty={namesDirty}
      localizationDraft={localizationDraft}
      localizationSaving={localizationSaving}
      localizationIsDirty={localizationIsDirty}
      lifecycleSaving={lifecycleSaving}
      aliasType={aliasType}
      aliasValue={aliasValue}
      aliasSaving={aliasMutations.saving}
      unavailableSections={unavailableSections}
      onNameChange={(key, value) =>
        setNameDraft((current) => ({ ...current, [key]: value }))
      }
      onLocalizationChange={(key, value) =>
        setLocalizationDraft((current) => ({ ...current, [key]: value }))
      }
      onSaveNames={saveNames}
      onSaveLocalization={saveLocalization}
      onLifecycleChange={setLifecycle}
      onRefreshLifecycle={profileGraph.retryProfileGraph}
      onPersistedDetailChange={persistDetailIfCurrent}
      onAliasTypeChange={setAliasType}
      onAliasValueChange={setAliasValue}
      onAddAlias={aliasMutations.add}
      onDeleteAlias={aliasMutations.remove}
      onUnavailable={markUnavailable}
      formatRelativeTime={formatRelativeTime}
    />
  );
}

function SubscriberProfilePanelContent({
  subscriberId,
  detail,
  canMutate,
  profileGraph,
  nameDraft,
  nameSaving,
  namesDirty,
  localizationDraft,
  localizationSaving,
  localizationIsDirty,
  lifecycleSaving,
  aliasType,
  aliasValue,
  aliasSaving,
  unavailableSections,
  onNameChange,
  onLocalizationChange,
  onSaveNames,
  onSaveLocalization,
  onLifecycleChange,
  onRefreshLifecycle,
  onPersistedDetailChange,
  onAliasTypeChange,
  onAliasValueChange,
  onAddAlias,
  onDeleteAlias,
  onUnavailable,
  formatRelativeTime,
}: {
  subscriberId: string | number | null | undefined;
  detail: SubscriberDetail;
  canMutate: boolean;
  profileGraph: ReturnType<typeof useSubscriberProfileGraph>;
  nameDraft: NameDraft;
  nameSaving: boolean;
  namesDirty: boolean;
  localizationDraft: LocalizationDraft;
  localizationSaving: boolean;
  localizationIsDirty: boolean;
  lifecycleSaving: boolean;
  aliasType: SubscriberAlias["alias_type"];
  aliasValue: string;
  aliasSaving: boolean;
  unavailableSections: ReadonlySet<OptionalProfileSection>;
  onNameChange: (key: keyof NameDraft, value: string) => void;
  onLocalizationChange: (key: keyof LocalizationDraft, value: string) => void;
  onSaveNames: () => Promise<void>;
  onSaveLocalization: () => Promise<void>;
  onLifecycleChange: (
    stage: SubscriberLifecycleStage,
    score: number,
  ) => Promise<void>;
  onRefreshLifecycle: () => void;
  onPersistedDetailChange: (updated: SubscriberDetail) => void;
  onAliasTypeChange: (type: SubscriberAlias["alias_type"]) => void;
  onAliasValueChange: (value: string) => void;
  onAddAlias: () => Promise<void>;
  onDeleteAlias: (alias: SubscriberAlias) => Promise<void>;
  onUnavailable: (section: OptionalProfileSection) => void;
  formatRelativeTime: SubscriberProfilePanelProps["formatRelativeTime"];
}): ReactElement {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {subscriberId == null ? null : (
        <PendingSyncStatus
          path={`/api/v1/subscribers/${encodeURIComponent(String(subscriberId))}`}
          compact
        />
      )}
      {profileGraph.profileGraphUnavailable ? (
        <div className="muted" style={{ fontSize: 12 }}>
          Profile graph routes are not available in this deployment.
        </div>
      ) : null}
      {profileGraph.profileGraphError ? (
        <div role="alert" style={{ fontSize: 12 }}>
          {profileGraph.profileGraphError}
          <div style={{ marginTop: 6 }}>
            <button
              type="button"
              className="btn btn-sm"
              onClick={profileGraph.retryProfileGraph}
            >
              Retry profile data
            </button>
          </div>
        </div>
      ) : null}
      <ProfileBasicsSections
        subscriberId={subscriberId}
        detail={detail}
        canMutate={canMutate}
        nameDraft={nameDraft}
        nameSaving={nameSaving}
        namesDirty={namesDirty}
        localizationDraft={localizationDraft}
        localizationSaving={localizationSaving}
        localizationIsDirty={localizationIsDirty}
        lifecycle={profileGraph.lifecycle}
        lifecycleState={profileGraph.lifecycleState}
        lifecycleSaving={lifecycleSaving}
        unavailableSections={unavailableSections}
        onNameChange={onNameChange}
        onLocalizationChange={onLocalizationChange}
        onSaveNames={onSaveNames}
        onSaveLocalization={onSaveLocalization}
        onLifecycleChange={onLifecycleChange}
        onRefreshLifecycle={onRefreshLifecycle}
        onPersistedDetailChange={onPersistedDetailChange}
        onUnavailable={onUnavailable}
        formatRelativeTime={formatRelativeTime}
      />
      <PredictionMetadataSection
        subscriberId={subscriberId == null ? "unknown" : String(subscriberId)}
        state={profileGraph.predictionState}
        items={profileGraph.predictionMetadata}
        openFeatures={profileGraph.predictionFeaturesOpen}
        onToggleFeatures={(id) =>
          profileGraph.setPredictionFeaturesOpen((current) => ({
            ...current,
            [id]: !current[id],
          }))
        }
        formatRelativeTime={formatRelativeTime}
      />
      <ProfileAliasesAndTraitsSections
        subscriberId={subscriberId}
        detail={detail}
        canMutate={canMutate}
        aliases={profileGraph.aliases}
        aliasType={aliasType}
        aliasValue={aliasValue}
        aliasSaving={aliasSaving}
        traits={profileGraph.traits}
        unavailableSections={unavailableSections}
        onAliasTypeChange={onAliasTypeChange}
        onAliasValueChange={onAliasValueChange}
        onAddAlias={onAddAlias}
        onDeleteAlias={onDeleteAlias}
        onUnavailable={onUnavailable}
      />
    </div>
  );
}

interface ProfileBasicsSectionsProps {
  subscriberId: string | number | null | undefined;
  detail: SubscriberDetail;
  canMutate: boolean;
  nameDraft: NameDraft;
  nameSaving: boolean;
  namesDirty: boolean;
  localizationDraft: LocalizationDraft;
  localizationSaving: boolean;
  localizationIsDirty: boolean;
  lifecycle: SubscriberLifecycle | null;
  lifecycleState: LifecycleState;
  lifecycleSaving: boolean;
  unavailableSections: ReadonlySet<OptionalProfileSection>;
  onNameChange: (key: keyof NameDraft, value: string) => void;
  onLocalizationChange: (key: keyof LocalizationDraft, value: string) => void;
  onSaveNames: () => Promise<void>;
  onSaveLocalization: () => Promise<void>;
  onLifecycleChange: (
    stage: SubscriberLifecycleStage,
    score: number,
  ) => Promise<void>;
  onRefreshLifecycle: () => void;
  onPersistedDetailChange: (updated: SubscriberDetail) => void;
  onUnavailable: (section: OptionalProfileSection) => void;
  formatRelativeTime: (timestamp: string | undefined | null) => string;
}

function ProfileBasicsSections({
  subscriberId,
  detail,
  canMutate,
  nameDraft,
  nameSaving,
  namesDirty,
  localizationDraft,
  localizationSaving,
  localizationIsDirty,
  lifecycle,
  lifecycleState,
  lifecycleSaving,
  unavailableSections,
  onNameChange,
  onLocalizationChange,
  onSaveNames,
  onSaveLocalization,
  onLifecycleChange,
  onRefreshLifecycle,
  onPersistedDetailChange,
  onUnavailable,
  formatRelativeTime,
}: ProfileBasicsSectionsProps): ReactElement {
  const nameGuidanceId = useId();
  const localizationGuidanceId = useId();
  const lifecycleGuidanceId = useId();
  const lifecycleScoreLegendId = useId();
  const [lifecycleDraftStage, setLifecycleDraftStage] =
    useState<SubscriberLifecycleStage>(lifecycle?.stage ?? "subscriber");
  const [lifecycleDraftScore, setLifecycleDraftScore] = useState(
    lifecycle?.score ?? 3,
  );
  const [pendingLifecycle, setPendingLifecycle] = useState<{
    stage: SubscriberLifecycleStage;
    score: number;
  } | null>(null);
  const lifecycleBaselineRef = useRef<SubscriberLifecycle | null>(null);
  useEffect(() => {
    if (lifecycleSaving || !lifecycle) return;
    const baseline = lifecycleBaselineRef.current;
    const hasOperatorDraft =
      baseline !== null &&
      (lifecycleDraftStage !== baseline.stage ||
        lifecycleDraftScore !== baseline.score);
    lifecycleBaselineRef.current = lifecycle;
    if (!hasOperatorDraft) {
      setLifecycleDraftStage(lifecycle.stage);
      setLifecycleDraftScore(lifecycle.score);
    }
  }, [lifecycle, lifecycleDraftScore, lifecycleDraftStage, lifecycleSaving]);
  const currentLifecycleStage = lifecycle?.stage ?? "subscriber";
  const currentLifecycleScore = lifecycle?.score ?? 3;
  const lifecycleDirty =
    lifecycleState === "loaded" &&
    lifecycle !== null &&
    (lifecycleDraftStage !== currentLifecycleStage ||
      lifecycleDraftScore !== currentLifecycleScore);
  const lifecycleEditable =
    canMutate &&
    lifecycleState === "loaded" &&
    Boolean(lifecycle?.subscriber_version);
  const nameGuidance = !canMutate
    ? "Viewer role can inspect names but can't edit them."
    : nameSaving
      ? "Saving all four name fields."
      : !namesDirty
        ? "Change at least one name field before saving."
        : "Save names updates all four name fields together.";
  const localizationGuidance = !canMutate
    ? "Viewer role can inspect localization but can't edit it."
    : localizationSaving
      ? "Saving language, country, locale, and region."
      : !localizationIsDirty
        ? "Change at least one localization field before saving."
        : "Save localization updates all four localization fields together.";
  return (
    <>
      <section>
        <div className="label">Name</div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
            gap: 8,
          }}
        >
          {(
            [
              ["first_name", "First name"],
              ["last_name", "Last name"],
              ["full_name", "Full name"],
              ["display_name", "Display name"],
            ] as Array<[keyof NameDraft, string]>
          ).map(([key, label]) => (
            <FormField key={key} label={label} error={null}>
              <input
                className="input"
                value={nameDraft[key]}
                disabled={nameSaving}
                readOnly={!canMutate}
                aria-disabled={!canMutate || undefined}
                aria-describedby={nameGuidanceId}
                onChange={(event) => onNameChange(key, event.target.value)}
                placeholder="—"
                aria-label={label}
              />
            </FormField>
          ))}
        </div>
        <div
          style={{ display: "flex", justifyContent: "flex-end", marginTop: 6 }}
        >
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={nameSaving}
            aria-disabled={!canMutate || !namesDirty || undefined}
            aria-describedby={nameGuidanceId}
            onClick={() => {
              if (canMutate && namesDirty) void onSaveNames();
            }}
          >
            {nameSaving ? "Saving…" : "Save names"}
          </button>
        </div>
        <p
          id={nameGuidanceId}
          className="muted"
          role="status"
          style={{ fontSize: 11, margin: "4px 0 0" }}
        >
          {nameGuidance}
        </p>
      </section>

      <section>
        <div className="label">Localization</div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
            gap: 8,
          }}
        >
          {(
            [
              ["language", "Language", "en"],
              ["country", "Country", "US"],
              ["locale", "Locale", "en-US"],
              ["region", "Region", "California"],
            ] as Array<[keyof LocalizationDraft, string, string]>
          ).map(([key, label, placeholder]) => (
            <FormField key={key} label={label} error={null}>
              <input
                className="input"
                value={localizationDraft[key]}
                disabled={localizationSaving}
                readOnly={!canMutate}
                aria-disabled={!canMutate || undefined}
                aria-describedby={localizationGuidanceId}
                placeholder={placeholder}
                aria-label={label}
                onChange={(event) =>
                  onLocalizationChange(key, event.target.value)
                }
              />
            </FormField>
          ))}
        </div>
        <div style={{ marginTop: 6 }}>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={localizationSaving}
            aria-disabled={!canMutate || !localizationIsDirty || undefined}
            aria-describedby={localizationGuidanceId}
            onClick={() => {
              if (canMutate && localizationIsDirty) void onSaveLocalization();
            }}
          >
            {localizationSaving ? "Saving…" : "Save localization"}
          </button>
        </div>
        <p
          id={localizationGuidanceId}
          className="muted"
          role="status"
          style={{ fontSize: 11, margin: "4px 0 0" }}
        >
          {localizationGuidance}
        </p>
      </section>

      {subscriberId != null && !unavailableSections.has("account") ? (
        <AccountSection
          subscriberId={String(subscriberId)}
          accountId={detail.account_id ?? null}
          subscriberVersion={detail.version}
          canMutate={canMutate}
          onLinked={onPersistedDetailChange}
          onUnavailable={() => onUnavailable("account")}
        />
      ) : null}
      {subscriberId != null && !unavailableSections.has("catalog") ? (
        <CatalogAttributesPanel
          subscriberId={String(subscriberId)}
          onUnavailable={() => onUnavailable("catalog")}
        />
      ) : null}
      {subscriberId != null && !unavailableSections.has("replenishment") ? (
        <ReplenishmentCadencePanel
          subscriberId={String(subscriberId)}
          onUnavailable={() => onUnavailable("replenishment")}
        />
      ) : null}
      {subscriberId != null && !unavailableSections.has("demographics") ? (
        <DemographicsPanel
          subscriberId={String(subscriberId)}
          onUnavailable={() => onUnavailable("demographics")}
        />
      ) : null}
      <section className="subscriber-lifecycle-card">
        <div className="subscriber-lifecycle-card__header">
          <div>
            <div className="label">Lifecycle</div>
            {lifecycle ? (
              <div className="subscriber-lifecycle-card__current">
                <span className="subscriber-lifecycle-stage-badge">
                  {lifecycleLabel(currentLifecycleStage)}
                </span>
                <span className="muted">
                  {LIFECYCLE_STAGE_DESCRIPTIONS[currentLifecycleStage]}
                </span>
              </div>
            ) : (
              <div
                className="subscriber-lifecycle-card__current muted"
                role="status"
              >
                {lifecycleState === "loading"
                  ? "Loading verified lifecycle state…"
                  : lifecycleState === "unavailable"
                    ? "Lifecycle is unavailable in this deployment."
                    : "Lifecycle state couldn't be verified."}
              </div>
            )}
          </div>
          <div className="subscriber-lifecycle-score">
            <strong
              className="tabular"
              aria-label={
                lifecycle
                  ? `Current lifecycle score ${currentLifecycleScore} out of 5`
                  : "Current lifecycle score unavailable"
              }
            >
              {lifecycle ? `${currentLifecycleScore}/5` : "—"}
            </strong>
            <span>Current score</span>
          </div>
        </div>

        {lifecycle ? (
          <div
            className="subscriber-lifecycle-meter"
            role="meter"
            aria-label="Lifecycle score"
            aria-valuemin={1}
            aria-valuemax={5}
            aria-valuenow={currentLifecycleScore}
            aria-valuetext={`${currentLifecycleScore} out of 5`}
          >
            {Array.from({ length: 5 }, (_, index) => (
              <span
                key={index}
                aria-hidden="true"
                data-active={index < currentLifecycleScore || undefined}
              />
            ))}
          </div>
        ) : (
          <div
            className="subscriber-lifecycle-meter subscriber-lifecycle-meter--pending"
            aria-hidden="true"
          >
            {Array.from({ length: 5 }, (_, index) => (
              <span key={index} />
            ))}
          </div>
        )}

        <div className="subscriber-lifecycle-editor">
          <FormField label="Move to stage" error={null}>
            <select
              className="input"
              value={lifecycleDraftStage}
              disabled={lifecycleSaving || !lifecycleEditable}
              aria-describedby={lifecycleGuidanceId}
              onChange={(event) =>
                setLifecycleDraftStage(
                  event.target.value as SubscriberLifecycleStage,
                )
              }
              aria-label="Lifecycle stage"
            >
              {SUBSCRIBER_LIFECYCLE_STAGES.map((stage) => (
                <option key={stage} value={stage}>
                  {lifecycleLabel(stage)}
                </option>
              ))}
            </select>
          </FormField>

          <fieldset
            className="subscriber-lifecycle-score-picker"
            disabled={lifecycleSaving || !lifecycleEditable}
            aria-describedby={lifecycleGuidanceId}
          >
            <legend id={lifecycleScoreLegendId}>Lifecycle score</legend>
            <div role="radiogroup" aria-labelledby={lifecycleScoreLegendId}>
              {[1, 2, 3, 4, 5].map((score) => (
                <label key={score}>
                  <input
                    className="sr-only"
                    type="radio"
                    name="subscriber-lifecycle-score"
                    value={score}
                    checked={lifecycleDraftScore === score}
                    onChange={() => setLifecycleDraftScore(score)}
                  />
                  <span className="tabular">{score}</span>
                </label>
              ))}
            </div>
            <p>1 low · 5 high</p>
          </fieldset>
        </div>

        <div className="subscriber-lifecycle-card__footer">
          <div>
            {lifecycleState === "loading" && lifecycle ? (
              <span className="muted">Refreshing verified state…</span>
            ) : lifecycle?.updated_at ? (
              <span className="muted">
                Updated {formatRelativeTime(lifecycle.updated_at)}
              </span>
            ) : null}
            <span className="subscriber-lifecycle-safety">
              Exact revision · durable automation intent
            </span>
          </div>
          {lifecycleState === "error" ? (
            <button
              type="button"
              className="btn btn-sm"
              onClick={onRefreshLifecycle}
            >
              Retry lifecycle
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={lifecycleSaving}
              aria-disabled={!lifecycleEditable || !lifecycleDirty || undefined}
              aria-describedby={lifecycleGuidanceId}
              onClick={() => {
                if (!lifecycleEditable || !lifecycleDirty) return;
                setPendingLifecycle({
                  stage: lifecycleDraftStage,
                  score: lifecycleDraftScore,
                });
              }}
            >
              {lifecycleSaving ? "Applying…" : "Review change"}
            </button>
          )}
        </div>

        <p
          id={lifecycleGuidanceId}
          className="muted"
          role="status"
          style={{ fontSize: 11, margin: 0 }}
        >
          {!canMutate
            ? "Viewer role can inspect lifecycle stage and score but can't change them."
            : lifecycleState === "loading"
              ? "Lifecycle editing stays locked until the server verifies the current stage, score, and exact revision."
              : lifecycleState === "error"
                ? "Lifecycle editing is locked because the current state couldn't be verified. Retry before preparing a change."
                : lifecycleState === "unavailable"
                  ? "Lifecycle editing isn't available in this deployment. No fallback value will be written."
                  : lifecycleSaving
                    ? "Applying the reviewed lifecycle change."
                    : !lifecycle?.subscriber_version
                      ? "Reload this subscriber to obtain an exact lifecycle revision before changing it."
                      : lifecycleDirty
                        ? "Review the draft before applying it. Stage transitions can start matching automations; score-only changes do not."
                        : "Choose a stage or score to prepare a reviewed change. Nothing is sent until you confirm."}
        </p>

        <ConfirmModal
          open={pendingLifecycle !== null}
          title={
            pendingLifecycle?.stage === currentLifecycleStage
              ? "Update lifecycle score?"
              : `Move ${lifecycleLabel(currentLifecycleStage)} to ${lifecycleLabel(pendingLifecycle?.stage ?? currentLifecycleStage)}?`
          }
          description={
            pendingLifecycle?.stage === currentLifecycleStage
              ? "This updates the profile score under the latest exact subscriber revision. It does not emit a stage-transition automation event."
              : "This stage transition is audited and durably queues any matching automations after the database change commits."
          }
          confirmLabel={
            pendingLifecycle?.stage === currentLifecycleStage
              ? "Update score"
              : `Move to ${lifecycleLabel(pendingLifecycle?.stage ?? currentLifecycleStage)}`
          }
          busy={lifecycleSaving}
          onClose={() => setPendingLifecycle(null)}
          onConfirm={async () => {
            const target = pendingLifecycle;
            if (!target) return;
            await onLifecycleChange(target.stage, target.score);
            setPendingLifecycle((current) =>
              current?.stage === target.stage && current.score === target.score
                ? null
                : current,
            );
          }}
        >
          {pendingLifecycle ? (
            <div className="subscriber-lifecycle-review">
              <div>
                <span>Current</span>
                <strong>{lifecycleLabel(currentLifecycleStage)}</strong>
                <small>Score {currentLifecycleScore}/5</small>
              </div>
              <span aria-hidden="true">→</span>
              <div>
                <span>Proposed</span>
                <strong>{lifecycleLabel(pendingLifecycle.stage)}</strong>
                <small>Score {pendingLifecycle.score}/5</small>
              </div>
            </div>
          ) : null}
        </ConfirmModal>
      </section>
    </>
  );
}

interface PredictionMetadataSectionProps {
  subscriberId: string;
  state: PredictionState;
  items: PredictionMetadata[];
  openFeatures: Record<string, boolean>;
  onToggleFeatures: (id: string) => void;
  formatRelativeTime: (timestamp: string | undefined | null) => string;
}

function PredictionMetadataSection({
  subscriberId,
  state,
  items,
  openFeatures,
  onToggleFeatures,
  formatRelativeTime,
}: PredictionMetadataSectionProps): ReactElement | null {
  if (state === "unavailable") return null;
  return (
    <section>
      <div className="label">Prediction metadata</div>
      {state === "loading" ? (
        <div className="muted" style={{ fontSize: 12 }} role="status">
          Loading prediction metadata…
        </div>
      ) : state === "error" ? (
        <div className="muted" style={{ fontSize: 12 }} role="alert">
          Couldn&apos;t load prediction metadata.
        </div>
      ) : items.length === 0 ? (
        <div className="muted" style={{ fontSize: 12 }} role="status">
          No model has scored this subscriber yet.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {items.map((metadata) => {
            const rawConfidence =
              typeof metadata.confidence === "number"
                ? metadata.confidence
                : null;
            const confidence =
              rawConfidence != null &&
              Number.isFinite(rawConfidence) &&
              rawConfidence >= 0 &&
              rawConfidence <= 1
                ? rawConfidence
                : null;
            const percent =
              confidence != null ? Math.round(confidence * 100) : null;
            const confidenceBand = predictionConfidenceBand(confidence);
            const featureCount = metadata.features
              ? Object.keys(metadata.features).length
              : 0;
            const open = openFeatures[metadata.id] ?? false;
            return (
              <div
                key={metadata.id}
                style={{
                  border: "1px solid var(--pw-border)",
                  borderRadius: 8,
                  padding: 10,
                  display: "flex",
                  flexDirection: "column",
                  gap: 6,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 8,
                  }}
                >
                  <span
                    style={{
                      fontSize: 12,
                      fontWeight: 600,
                      textTransform: "capitalize",
                    }}
                  >
                    {metadata.score_type} score
                  </span>
                  <span className="badge tabular" style={{ fontSize: 11 }}>
                    Model: {metadata.model_version}
                  </span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span
                    className="muted"
                    style={{ fontSize: 11, minWidth: 70 }}
                  >
                    Confidence
                  </span>
                  <div
                    style={{
                      flex: 1,
                      height: 6,
                      borderRadius: 3,
                      background:
                        "color-mix(in srgb, var(--pw-fg-muted) 18%, transparent)",
                      overflow: "hidden",
                    }}
                    role="meter"
                    aria-label={`${metadata.score_type} confidence`}
                    aria-valuenow={percent ?? undefined}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuetext={`${confidenceBand.label} confidence · ${percent ?? "unavailable"}${percent == null ? "" : "%"}`}
                  >
                    <div
                      style={{
                        width: `${percent ?? 0}%`,
                        height: "100%",
                        background: confidenceBand.color,
                        backgroundImage:
                          "repeating-linear-gradient(135deg, transparent 0 3px, color-mix(in srgb, var(--pw-bg) 45%, transparent) 3px 4px)",
                      }}
                    />
                  </div>
                  <span
                    className="tabular"
                    style={{
                      fontSize: 11,
                      minWidth: 42,
                      textAlign: "right",
                      color: confidenceBand.color,
                    }}
                  >
                    {confidence != null
                      ? `${confidenceBand.label} · ${confidence.toFixed(2)}`
                      : "Unavailable"}
                  </span>
                </div>
                <div className="muted" style={{ fontSize: 11 }}>
                  Computed{" "}
                  {metadata.computed_at
                    ? `${fmtDateTime(metadata.computed_at)} (${formatRelativeTime(metadata.computed_at)})`
                    : "—"}
                </div>
                {featureCount > 0 ? (
                  <div>
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      style={{ padding: "2px 6px", fontSize: 11 }}
                      aria-expanded={open}
                      onClick={() => onToggleFeatures(metadata.id)}
                    >
                      {open ? "▾" : "▸"} Feature snapshot ({featureCount})
                    </button>
                    {open ? (
                      <pre
                        style={{
                          margin: "6px 0 0",
                          padding: 8,
                          fontSize: 11,
                          lineHeight: 1.4,
                          maxHeight: 220,
                          overflow: "auto",
                          borderRadius: 6,
                          background:
                            "color-mix(in srgb, var(--pw-fg-muted) 8%, transparent)",
                          fontFamily: "var(--pw-font-mono)",
                          whiteSpace: "pre-wrap",
                          wordBreak: "break-word",
                        }}
                      >
                        {JSON.stringify(metadata.features, null, 2)}
                      </pre>
                    ) : null}
                  </div>
                ) : (
                  <div className="muted" style={{ fontSize: 11 }}>
                    No feature snapshot recorded.
                  </div>
                )}
              </div>
            );
          })}
          <AccessibleChartData
            title="Subscriber prediction confidence"
            summary={`${items.length} current score-type metadata records for the selected subscriber, including model version, confidence and computation time.`}
            rowHeaderLabel="Score type"
            columns={[
              { key: "model", label: "Model version" },
              { key: "confidence", label: "Confidence (fraction / percent)" },
              { key: "band", label: "Confidence band" },
              { key: "computed", label: "Computed at" },
              { key: "features", label: "Feature count" },
            ]}
            rows={items.map((metadata) => {
              const raw = metadata.confidence;
              const confidence =
                typeof raw === "number" &&
                Number.isFinite(raw) &&
                raw >= 0 &&
                raw <= 1
                  ? raw
                  : null;
              const band = predictionConfidenceBand(confidence);
              const featureCount = metadata.features
                ? Object.keys(metadata.features).length
                : 0;
              return {
                key: metadata.id,
                label: metadata.score_type,
                values: {
                  model: metadata.model_version,
                  confidence:
                    confidence == null
                      ? "Unavailable"
                      : `${confidence.toFixed(2)} (${Math.round(confidence * 100)}%)`,
                  band: band.label,
                  computed: metadata.computed_at || "Not supplied",
                  features: featureCount.toLocaleString(),
                },
                exportValues: {
                  model: metadata.model_version,
                  confidence,
                  band: band.label,
                  computed: metadata.computed_at || "",
                  features: featureCount,
                },
              };
            })}
            provenance={dux025Provenance("predictionConfidence", {
              scope: `Subscriber ${subscriberId} · ${items.length} current score types`,
              asOf: latestPredictionTimestamp(items),
            })}
            exportFileName="subscriber-prediction-confidence.csv"
            exportPrivacy="confidential"
          />
        </div>
      )}
    </section>
  );
}

function predictionConfidenceBand(confidence: number | null): {
  label: string;
  color: string;
} {
  if (confidence == null) {
    return { label: "Unavailable", color: "var(--pw-fg-muted)" };
  }
  if (confidence >= 0.75) {
    return { label: "High", color: "var(--pw-success)" };
  }
  if (confidence >= 0.5) {
    return { label: "Medium", color: "var(--pw-warning)" };
  }
  return { label: "Low", color: "var(--pw-danger)" };
}

function latestPredictionTimestamp(items: PredictionMetadata[]): string | null {
  let latest: { raw: string; time: number } | null = null;
  for (const item of items) {
    const time = Date.parse(item.computed_at);
    if (!Number.isFinite(time)) continue;
    if (latest == null || time > latest.time)
      latest = { raw: item.computed_at, time };
  }
  return latest?.raw ?? null;
}

interface ProfileAliasesAndTraitsSectionsProps {
  subscriberId: string | number | null | undefined;
  detail: SubscriberDetail;
  canMutate: boolean;
  aliases: SubscriberAlias[];
  aliasType: SubscriberAlias["alias_type"];
  aliasValue: string;
  aliasSaving: boolean;
  traits: SubscriberComputedTrait[];
  unavailableSections: ReadonlySet<OptionalProfileSection>;
  onAliasTypeChange: (type: SubscriberAlias["alias_type"]) => void;
  onAliasValueChange: (value: string) => void;
  onAddAlias: () => Promise<void>;
  onDeleteAlias: (alias: SubscriberAlias) => Promise<void>;
  onUnavailable: (section: OptionalProfileSection) => void;
}

function ProfileAliasesAndTraitsSections({
  subscriberId,
  detail,
  canMutate,
  aliases,
  aliasType,
  aliasValue,
  aliasSaving,
  traits,
  unavailableSections,
  onAliasTypeChange,
  onAliasValueChange,
  onAddAlias,
  onDeleteAlias,
  onUnavailable,
}: ProfileAliasesAndTraitsSectionsProps): ReactElement {
  const aliasGuidanceId = useId();
  const aliasReady = aliasValue.trim().length > 0 && Boolean(detail.version);
  const aliasOption =
    ALIAS_TYPE_OPTIONS.find((option) => option.value === aliasType) ??
    ALIAS_TYPE_OPTIONS[0]!;
  const [pendingAliasDelete, setPendingAliasDelete] =
    useState<SubscriberAlias | null>(null);
  return (
    <>
      {subscriberId != null && !unavailableSections.has("emails") ? (
        <SubscriberEmailsSection
          subscriberId={String(subscriberId)}
          subscriberVersion={detail.version}
          canonicalEmail={detail.primary_email?.trim() || detail.email}
          canMutate={canMutate}
          onUnavailable={() => onUnavailable("emails")}
        />
      ) : null}
      {subscriberId != null && !unavailableSections.has("federation") ? (
        <FederatedIdentityPanel
          subscriberId={String(subscriberId)}
          subscriberVersion={detail.version}
          canMutate={canMutate}
          onUnavailable={() => onUnavailable("federation")}
        />
      ) : null}

      <section>
        <div className="label">Identity aliases</div>
        {detail.profile_id ? (
          <dl
            style={{
              fontSize: 11,
              marginBottom: 6,
              display: "grid",
              gap: 2,
            }}
          >
            <dt className="muted">Resolved profile ID</dt>
            <dd
              style={{
                margin: 0,
                fontFamily: "var(--pw-font-mono)",
                overflowWrap: "anywhere",
              }}
            >
              {detail.profile_id}
            </dd>
            <dd className="muted" style={{ margin: 0 }}>
              Resolution precedence: profile ID, external ID, email, phone, then
              anonymous ID.
            </dd>
          </dl>
        ) : null}
        {aliases.length === 0 ? (
          <div className="muted" style={{ fontSize: 12 }}>
            No aliases recorded.
          </div>
        ) : (
          <div className="chip-list">
            {aliases.map((alias) => (
              <span
                key={alias.id}
                className="chip-removable"
                style={{ maxWidth: "100%" }}
              >
                <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>
                  <span className="muted">
                    {aliasTypeLabel(alias.alias_type)}:
                  </span>{" "}
                  {alias.alias_value}
                </span>
                {aliasUsesVerifiedContactWorkflow(alias.alias_type) ? (
                  <span
                    className="muted"
                    aria-label={`${aliasTypeLabel(alias.alias_type)} aliases are managed in the verified contact-method workflow`}
                    style={{ fontSize: 10, whiteSpace: "nowrap" }}
                  >
                    Verified
                  </span>
                ) : (
                  <button
                    type="button"
                    aria-label={`Delete alias ${alias.alias_value}`}
                    disabled={aliasSaving}
                    aria-disabled={!canMutate || undefined}
                    aria-describedby={aliasGuidanceId}
                    onClick={() => {
                      if (canMutate) setPendingAliasDelete(alias);
                    }}
                  >
                    ×
                  </button>
                )}
              </span>
            ))}
          </div>
        )}
        <div
          style={{
            display: "grid",
            gridTemplateColumns:
              "repeat(auto-fit, minmax(min(160px, 100%), 1fr))",
            gap: 6,
            marginTop: 8,
          }}
        >
          <select
            className="input"
            value={aliasType}
            disabled={aliasSaving}
            aria-disabled={!canMutate || undefined}
            aria-describedby={aliasGuidanceId}
            onChange={(event) => {
              if (canMutate) {
                onAliasTypeChange(
                  event.target.value as SubscriberAlias["alias_type"],
                );
              }
            }}
            aria-label="Alias type"
          >
            {ALIAS_TYPE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <input
            className="input"
            value={aliasValue}
            disabled={aliasSaving}
            readOnly={!canMutate}
            aria-disabled={!canMutate || undefined}
            aria-describedby={aliasGuidanceId}
            onChange={(event) => onAliasValueChange(event.target.value)}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                !event.nativeEvent.isComposing &&
                event.nativeEvent.keyCode !== 229 &&
                canMutate &&
                aliasReady
              ) {
                void onAddAlias();
              }
            }}
            placeholder={aliasOption.placeholder}
            aria-label="Alias value"
          />
          <button
            type="button"
            className="btn"
            disabled={aliasSaving}
            aria-disabled={!canMutate || !aliasReady || undefined}
            aria-describedby={aliasGuidanceId}
            onClick={() => {
              if (canMutate && aliasReady) void onAddAlias();
            }}
          >
            Add
          </button>
        </div>
        <p
          id={aliasGuidanceId}
          className="muted"
          role="status"
          style={{ fontSize: 11, margin: "4px 0 0" }}
        >
          {!canMutate
            ? "Viewer role can inspect aliases but can't add or delete them."
            : aliasSaving
              ? "Saving the alias change."
              : !detail.version
                ? "Reload this subscriber to obtain an exact revision before changing identity links."
                : aliasReady
                  ? "This identifier must be unique across subscriber profiles. Email and phone identities use their verified contact-method workflows."
                  : "Enter an identifier. Email and phone identities are added through their verified contact-method workflows."}
        </p>
        <ConfirmModal
          open={pendingAliasDelete !== null}
          title="Delete identity alias?"
          description={
            pendingAliasDelete?.alias_type === "external_id"
              ? "This removes the alternate identifier. If it is the canonical external customer ID, that link is cleared too. The subscriber and stable profile ID remain intact."
              : "This removes the alternate identifier from this subscriber. It does not delete the subscriber or change the stable profile ID."
          }
          confirmLabel="Delete alias"
          danger
          busy={aliasSaving}
          onClose={() => setPendingAliasDelete(null)}
          onConfirm={() => {
            const target = pendingAliasDelete;
            if (!target) return;
            void onDeleteAlias(target).finally(() => {
              setPendingAliasDelete((current) =>
                current?.id === target.id ? null : current,
              );
            });
          }}
        />
      </section>

      <IdentifierNormalizationDisclosure
        email={detail.email}
        fields={detail.custom_fields ?? detail.merge_fields ?? {}}
      />
      <section>
        <div className="label">Computed traits</div>
        {traits.length === 0 ? (
          <div className="muted" style={{ fontSize: 12 }}>
            No computed traits materialized.
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 6 }}>
            {traits.slice(0, 12).map((trait) => (
              <div
                key={trait.id || trait.key}
                style={{
                  display: "grid",
                  gridTemplateColumns: "minmax(0, 1fr) auto",
                  gap: 8,
                  padding: "6px 8px",
                  background: "var(--pw-bg-elev-2)",
                  borderRadius: 4,
                  fontSize: 12,
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 500 }}>{trait.key}</div>
                  <div
                    className="muted"
                    style={{
                      fontFamily: "var(--pw-font-mono)",
                      overflowWrap: "anywhere",
                      whiteSpace: "pre-wrap",
                    }}
                  >
                    {String(
                      typeof trait.value === "object"
                        ? JSON.stringify(trait.value)
                        : (trait.value ?? "—"),
                    )}
                  </div>
                </div>
                <div className="muted" style={{ fontSize: 11 }}>
                  {trait.source}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
