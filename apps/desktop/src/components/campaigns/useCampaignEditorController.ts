import {
  type Dispatch,
  type RefObject,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import {
  type Campaign,
  type CampaignDetail,
  type CampaignUpdateInput,
  type EmailBlockInstance,
  type SubjectLabScoredVariant,
  api,
  createABTestCampaign,
} from "../../lib/api-client";
import { queueReceiptMessage } from "../../lib/api/result";
import { track as trackTelemetry } from "../../lib/telemetry";
import { registerLifecycleGuard } from "../../lib/lifecycle-coordinator";
import {
  type CampaignBodyTab,
  type CampaignEditorDraft,
  type CampaignEditorMode,
} from "../CampaignDetailEditor";
import { toast } from "../Toast";
import { asCampaignString } from "./useCampaignDetailData";

interface CampaignEditorControllerInput {
  id: Campaign["id"];
  detail: CampaignDetail;
  setDetail: Dispatch<SetStateAction<CampaignDetail>>;
  savedFromEmail: string;
  canMutate: boolean;
  onChange?: (updated: CampaignDetail | null) => void;
}

export interface CampaignEditorController {
  editing: boolean;
  draftDirty: boolean;
  draft: CampaignEditorDraft;
  setDraft: Dispatch<SetStateAction<CampaignEditorDraft>>;
  saving: boolean;
  freezingAudience: boolean;
  saveErr: string | null;
  bodyTab: CampaignBodyTab;
  setBodyTab: Dispatch<SetStateAction<CampaignBodyTab>>;
  editorMode: CampaignEditorMode;
  setEditorMode: Dispatch<SetStateAction<CampaignEditorMode>>;
  blockInstances: EmailBlockInstance[];
  setBlockInstances: Dispatch<SetStateAction<EmailBlockInstance[]>>;
  lastComposedMjml: string;
  setLastComposedMjml: Dispatch<SetStateAction<string>>;
  confirmModeSwitch: boolean;
  setConfirmModeSwitch: Dispatch<SetStateAction<boolean>>;
  translateOpen: boolean;
  setTranslateOpen: Dispatch<SetStateAction<boolean>>;
  utmOpen: boolean;
  setUtmOpen: Dispatch<SetStateAction<boolean>>;
  editorWrapRef: RefObject<HTMLDivElement | null>;
  openEdit: () => void;
  discardEdit: () => void;
  saveEdit: () => Promise<void>;
  freezeAudience: () => Promise<void>;
  pickSubjectFromLab: (text: string) => Promise<void>;
  runSubjectBandit: (top3: SubjectLabScoredVariant[]) => Promise<void>;
}

const EMPTY_DRAFT: CampaignEditorDraft = {
  name: "",
  subject: "",
  fromName: "",
  fromEmail: "",
  body: "",
  previewText: "",
  goalEvent: "",
  goalWindowHours: 0,
  audienceMode: "dynamic",
  sourceMode: "legacy_html",
  contentSchemaVersion: 1,
  semanticNodesJSON: "[]",
  factContractJSON: "{}",
};

const MAX_SEMANTIC_SOURCE_BYTES = 1 << 20;

export function parseSemanticCampaignDraft(draft: CampaignEditorDraft): {
  content_blocks: Array<Record<string, unknown>>;
  fact_contract: Record<string, unknown>;
} {
  if (
    new TextEncoder().encode(draft.semanticNodesJSON ?? "[]").byteLength >
      MAX_SEMANTIC_SOURCE_BYTES ||
    new TextEncoder().encode(draft.factContractJSON ?? "{}").byteLength >
      MAX_SEMANTIC_SOURCE_BYTES
  ) {
    throw new Error("Semantic source exceeds the 1 MiB authoring limit.");
  }
  let nodes: unknown;
  let contract: unknown;
  try {
    nodes = JSON.parse(draft.semanticNodesJSON ?? "[]");
    contract = JSON.parse(draft.factContractJSON ?? "{}");
  } catch {
    throw new Error("Semantic source and Fact Contract must be valid JSON.");
  }
  if (
    !Array.isArray(nodes) ||
    nodes.length === 0 ||
    nodes.some(
      (node) =>
        node === null || typeof node !== "object" || Array.isArray(node),
    )
  ) {
    throw new Error("Semantic source must be a non-empty JSON object array.");
  }
  if (
    contract === null ||
    typeof contract !== "object" ||
    Array.isArray(contract)
  ) {
    throw new Error("Fact Contract must be one JSON object.");
  }
  return {
    content_blocks: nodes as Array<Record<string, unknown>>,
    fact_contract: contract as Record<string, unknown>,
  };
}

/**
 * The editor draft the SAVED record produces.
 *
 * Exported for the ECO-03 draft checkpoint: deciding whether a stored draft
 * holds unsaved work means comparing it with what the record itself would put
 * in the editor, and re-deriving that mapping in a second place is how the two
 * drift into disagreeing about whether an edit exists.
 */
export function draftFromDetail(
  detail: CampaignDetail,
  savedFromEmail: string,
): CampaignEditorDraft {
  return {
    name: detail.name ?? "",
    subject: detail.subject ?? "",
    fromName: detail.from_name ?? "",
    fromEmail: savedFromEmail,
    body: asCampaignString(detail.body_html ?? detail.plain_text ?? ""),
    previewText: detail.preview_text ?? "",
    goalEvent: detail.goal_event ?? "",
    goalWindowHours: detail.goal_window_hours ?? 0,
    audienceMode: detail.audience_mode ?? "dynamic",
    sourceMode: detail.source_mode === "semantic" ? "semantic" : "legacy_html",
    contentSchemaVersion:
      detail.source_mode === "semantic"
        ? 2
        : (detail.content_schema_version ?? 1),
    semanticNodesJSON: JSON.stringify(detail.content_blocks ?? [], null, 2),
    factContractJSON: JSON.stringify(detail.fact_contract ?? {}, null, 2),
  };
}

export function useCampaignEditorController({
  id,
  detail,
  setDetail,
  savedFromEmail,
  canMutate,
  onChange,
}: CampaignEditorControllerInput): CampaignEditorController {
  const [editing, setEditingState] = useState(false);
  const [draft, setDraftState] = useState<CampaignEditorDraft>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);
  const [freezingAudience, setFreezingAudience] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [bodyTab, setBodyTab] = useState<CampaignBodyTab>("edit");
  const [editorMode, setEditorModeState] = useState<CampaignEditorMode>("html");
  const [blockInstances, setBlockInstancesState] = useState<
    EmailBlockInstance[]
  >([]);
  const [lastComposedMjml, setLastComposedMjmlState] = useState("");
  const [confirmModeSwitch, setConfirmModeSwitchState] = useState(false);
  const [translateOpen, setTranslateOpenState] = useState(false);
  const [utmOpen, setUtmOpenState] = useState(false);
  const editorWrapRef = useRef<HTMLDivElement | null>(null);
  const mountedRef = useRef(true);
  const campaignIdRef = useRef(id == null ? null : String(id));
  const detailRef = useRef(detail);
  const savedFromEmailRef = useRef(savedFromEmail);
  const canMutateRef = useRef(canMutate);
  const editingRef = useRef(editing);
  const draftRef = useRef(draft);
  const editorModeRef = useRef(editorMode);
  const blockInstancesRef = useRef(blockInstances);
  const lastComposedMjmlRef = useRef(lastComposedMjml);
  const savingRef = useRef(saving);
  const freezingAudienceRef = useRef(false);
  const saveRequestRef = useRef(0);
  const freezeRequestRef = useRef(0);

  campaignIdRef.current = id == null ? null : String(id);
  detailRef.current = detail;
  savedFromEmailRef.current = savedFromEmail;
  canMutateRef.current = canMutate;
  editingRef.current = editing;
  draftRef.current = draft;
  editorModeRef.current = editorMode;
  blockInstancesRef.current = blockInstances;
  lastComposedMjmlRef.current = lastComposedMjml;
  savingRef.current = saving;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      saveRequestRef.current += 1;
      freezeRequestRef.current += 1;
    };
  }, []);

  const setDraft = useCallback<Dispatch<SetStateAction<CampaignEditorDraft>>>(
    (value) => {
      if (
        !canMutateRef.current ||
        savingRef.current ||
        freezingAudienceRef.current
      )
        return;
      const next =
        typeof value === "function" ? value(draftRef.current) : value;
      draftRef.current = next;
      setDraftState(next);
    },
    [],
  );
  const setEditorMode = useCallback<
    Dispatch<SetStateAction<CampaignEditorMode>>
  >((value) => {
    if (
      !canMutateRef.current ||
      savingRef.current ||
      freezingAudienceRef.current
    )
      return;
    const next =
      typeof value === "function" ? value(editorModeRef.current) : value;
    editorModeRef.current = next;
    setEditorModeState(next);
  }, []);
  const setBlockInstances = useCallback<
    Dispatch<SetStateAction<EmailBlockInstance[]>>
  >((value) => {
    if (
      !canMutateRef.current ||
      savingRef.current ||
      freezingAudienceRef.current
    )
      return;
    const next =
      typeof value === "function" ? value(blockInstancesRef.current) : value;
    blockInstancesRef.current = next;
    setBlockInstancesState(next);
  }, []);
  const setLastComposedMjml = useCallback<Dispatch<SetStateAction<string>>>(
    (value) => {
      if (
        !canMutateRef.current ||
        savingRef.current ||
        freezingAudienceRef.current
      )
        return;
      const next =
        typeof value === "function"
          ? value(lastComposedMjmlRef.current)
          : value;
      lastComposedMjmlRef.current = next;
      setLastComposedMjmlState(next);
    },
    [],
  );
  const setConfirmModeSwitch = useCallback<Dispatch<SetStateAction<boolean>>>(
    (value) => {
      setConfirmModeSwitchState((current) => {
        const next = typeof value === "function" ? value(current) : value;
        return next &&
          (!canMutateRef.current ||
            savingRef.current ||
            freezingAudienceRef.current)
          ? current
          : next;
      });
    },
    [],
  );
  const setTranslateOpen = useCallback<Dispatch<SetStateAction<boolean>>>(
    (value) => {
      setTranslateOpenState((current) => {
        const next = typeof value === "function" ? value(current) : value;
        return next &&
          (!canMutateRef.current ||
            savingRef.current ||
            freezingAudienceRef.current)
          ? current
          : next;
      });
    },
    [],
  );
  const setUtmOpen = useCallback<Dispatch<SetStateAction<boolean>>>((value) => {
    setUtmOpenState((current) => {
      const next = typeof value === "function" ? value(current) : value;
      return next &&
        (!canMutateRef.current ||
          savingRef.current ||
          freezingAudienceRef.current)
        ? current
        : next;
    });
  }, []);

  const openEdit = (): void => {
    if (!canMutateRef.current) {
      toast.error("Your current role cannot edit this campaign.");
      return;
    }
    if (savingRef.current || freezingAudienceRef.current) return;
    if ((detailRef.current.status ?? "draft").toLowerCase() !== "draft") {
      toast.error("Only draft campaigns can be edited.");
      return;
    }
    const nextDraft = draftFromDetail(
      detailRef.current,
      savedFromEmailRef.current,
    );
    draftRef.current = nextDraft;
    setDraftState(nextDraft);
    setSaveErr(null);
    setBodyTab("edit");
    editorModeRef.current = "html";
    setEditorModeState("html");
    blockInstancesRef.current = [];
    setBlockInstancesState([]);
    lastComposedMjmlRef.current = "";
    setLastComposedMjmlState("");
    setConfirmModeSwitchState(false);
    editingRef.current = true;
    setEditingState(true);
  };

  const discardEdit = useCallback((): void => {
    if (savingRef.current || freezingAudienceRef.current) return;
    const nextDraft = draftFromDetail(
      detailRef.current,
      savedFromEmailRef.current,
    );
    draftRef.current = nextDraft;
    setDraftState(nextDraft);
    setSaveErr(null);
    setBodyTab("edit");
    editorModeRef.current = "html";
    setEditorModeState("html");
    blockInstancesRef.current = [];
    setBlockInstancesState([]);
    lastComposedMjmlRef.current = "";
    setLastComposedMjmlState("");
    setConfirmModeSwitchState(false);
    editingRef.current = false;
    setEditingState(false);
  }, []);

  const saveEdit = async (): Promise<void> => {
    if (!canMutateRef.current) {
      setSaveErr(
        "Your role changed. Copy any text you need, then cancel these local edits.",
      );
      return;
    }
    if (savingRef.current || freezingAudienceRef.current) return;
    const currentCampaignId = campaignIdRef.current;
    if (currentCampaignId == null || !editingRef.current) return;
    const draftSnapshot = draftRef.current;
    const detailSnapshot = detailRef.current;
    const editorModeSnapshot = editorModeRef.current;
    const name = draftSnapshot.name.trim();
    const subject = draftSnapshot.subject.trim();
    const fromEmail = draftSnapshot.fromEmail.trim();
    if (!name) {
      setSaveErr("Name is required.");
      return;
    }
    if (!subject) {
      setSaveErr("Subject is required.");
      return;
    }
    const semantic = draftSnapshot.sourceMode === "semantic";
    let semanticSource:
      | ReturnType<typeof parseSemanticCampaignDraft>
      | undefined;
    if (semantic) {
      try {
        semanticSource = parseSemanticCampaignDraft(draftSnapshot);
      } catch (error) {
        setSaveErr(
          error instanceof Error
            ? error.message
            : "Semantic source is invalid.",
        );
        return;
      }
    }
    const requestId = ++saveRequestRef.current;
    savingRef.current = true;
    setSaving(true);
    setSaveErr(null);
    const patch: CampaignUpdateInput = {
      name,
      subject,
      ...(semantic
        ? {
            source_mode: "semantic" as const,
            content_schema_version: 2,
            ...semanticSource,
          }
        : editorModeSnapshot === "blocks"
          ? {
              source_mode: "legacy_html" as const,
              content_schema_version: 1,
              body_mjml: draftSnapshot.body,
              body_html: "",
            }
          : {
              source_mode: "legacy_html" as const,
              content_schema_version: 1,
              body_html: draftSnapshot.body,
            }),
      preview_text: draftSnapshot.previewText.trim(),
      goal_event: draftSnapshot.goalEvent.trim(),
      goal_window_hours: draftSnapshot.goalEvent.trim()
        ? draftSnapshot.goalWindowHours || 24
        : 0,
      audience_mode: draftSnapshot.audienceMode,
      from_name: draftSnapshot.fromName.trim(),
    };
    const currentDelivery = (
      detailSnapshot as { delivery_settings?: Record<string, unknown> }
    ).delivery_settings;
    patch.delivery_settings = {
      ...(currentDelivery ?? {}),
      from_email: fromEmail,
    };
    let result: Awaited<ReturnType<typeof api.updateCampaign>>;
    try {
      result = await api.updateCampaign(currentCampaignId, patch);
    } catch (error) {
      if (
        mountedRef.current &&
        requestId === saveRequestRef.current &&
        campaignIdRef.current === currentCampaignId
      ) {
        savingRef.current = false;
        setSaving(false);
        setSaveErr(
          error instanceof Error && error.message.trim()
            ? error.message
            : "The save request failed unexpectedly.",
        );
      }
      return;
    }
    if (
      !mountedRef.current ||
      requestId !== saveRequestRef.current ||
      campaignIdRef.current !== currentCampaignId
    ) {
      return;
    }
    savingRef.current = false;
    setSaving(false);
    if (result.error) {
      setSaveErr(result.error.message);
      return;
    }
    if (!canMutateRef.current) {
      setSaveErr(
        "The save completed as your role changed. Your local draft is still visible; cancel it, then reopen the campaign to verify the saved version.",
      );
      return;
    }
    if (result.queued) {
      const optimistic = { ...detailSnapshot, ...patch } as CampaignDetail;
      setDetail(optimistic);
      onChange?.(optimistic);
      editingRef.current = false;
      setEditingState(false);
      toast.info({
        message: queueReceiptMessage(result.receipt),
        detail: "The editor shows your local draft until server confirmation.",
      });
      return;
    }
    if (result.data) setDetail(result.data);
    onChange?.(result.data ?? detailSnapshot);
    editingRef.current = false;
    setEditingState(false);
    toast.success("Campaign saved");
  };

  const freezeAudience = async (): Promise<void> => {
    if (!canMutateRef.current) {
      toast.error("Your current role cannot freeze this campaign audience.");
      return;
    }
    if (savingRef.current || freezingAudienceRef.current) return;
    const currentCampaignId = campaignIdRef.current;
    if (currentCampaignId == null || !editingRef.current) return;
    if (draftRef.current.audienceMode !== "static") {
      toast.error("Choose Static audience mode before freezing recipients.");
      return;
    }
    const requestId = ++freezeRequestRef.current;
    freezingAudienceRef.current = true;
    setFreezingAudience(true);
    try {
      const result = await api.freezeCampaignAudience(currentCampaignId);
      if (
        !mountedRef.current ||
        requestId !== freezeRequestRef.current ||
        campaignIdRef.current !== currentCampaignId
      ) {
        return;
      }
      if (result.error) {
        toast.error(`Couldn't freeze: ${result.error.message}`);
        return;
      }
      toast.success(
        `Audience frozen — ${result.data.frozen_members} recipients snapshotted`,
      );
    } catch (error) {
      if (
        mountedRef.current &&
        requestId === freezeRequestRef.current &&
        campaignIdRef.current === currentCampaignId
      ) {
        toast.error(
          `Couldn't freeze: ${
            error instanceof Error && error.message.trim()
              ? error.message
              : "The freeze request failed unexpectedly."
          }`,
        );
      }
    } finally {
      if (
        mountedRef.current &&
        requestId === freezeRequestRef.current &&
        campaignIdRef.current === currentCampaignId
      ) {
        freezingAudienceRef.current = false;
        setFreezingAudience(false);
      }
    }
  };

  const draftDirty =
    editing &&
    (JSON.stringify(draft) !==
      JSON.stringify(draftFromDetail(detail, savedFromEmail)) ||
      editorMode !== "html" ||
      blockInstances.length > 0 ||
      lastComposedMjml !== "");
  useEffect(() => {
    if (!draftDirty && !saving && !freezingAudience) return;
    return registerLifecycleGuard({
      id: `campaign-detail-${String(id)}`,
      label: "Campaign changes",
      inspect: (intent) =>
        intent.disposition === "hide"
          ? null
          : saving || freezingAudience
            ? {
                level: "blocking",
                detail: saving
                  ? "The campaign changes are still being saved."
                  : "The campaign audience snapshot is still being frozen.",
                canDiscard: false,
              }
            : {
                level: "blocking",
                detail:
                  "The campaign subject, sender, body, goal, or audience mode has unsaved local changes.",
              },
      prepare: saving || freezingAudience || !canMutate ? undefined : saveEdit,
      discard: discardEdit,
    });
  }, [
    canMutate,
    discardEdit,
    draftDirty,
    freezingAudience,
    id,
    saveEdit,
    saving,
  ]);

  const pickSubjectFromLab = async (text: string): Promise<void> => {
    if (!canMutateRef.current) {
      toast.error("Your current role cannot change this campaign.");
      return;
    }
    if (savingRef.current || freezingAudienceRef.current) {
      toast.error("Wait for the current campaign operation to finish.");
      return;
    }
    if (editingRef.current) {
      setDraft((current) => ({ ...current, subject: text }));
      toast.success("Subject updated in the editor — save to persist it");
      return;
    }
    const currentCampaignId = campaignIdRef.current;
    const detailSnapshot = detailRef.current;
    if (currentCampaignId == null) return;
    const result = await api.updateCampaign(currentCampaignId, {
      subject: text,
    });
    if (campaignIdRef.current !== currentCampaignId) return;
    if (result.error) {
      toast.error(`Couldn't update subject: ${result.error.message}`);
      return;
    }
    if (result.queued) {
      const optimistic = { ...detailSnapshot, subject: text };
      setDetail(optimistic);
      onChange?.(optimistic);
      toast.info(queueReceiptMessage(result.receipt));
      return;
    }
    if (result.data) setDetail(result.data);
    onChange?.(result.data ?? { ...detailSnapshot, subject: text });
    toast.success("Subject updated");
  };

  const runSubjectBandit = async (
    top3: SubjectLabScoredVariant[],
  ): Promise<void> => {
    if (!canMutateRef.current) {
      toast.error("Your current role cannot create campaign experiments.");
      return;
    }
    if (
      editingRef.current ||
      savingRef.current ||
      freezingAudienceRef.current
    ) {
      toast.error(
        "Save or cancel the open campaign editor before creating an experiment from the persisted campaign.",
      );
      return;
    }
    const currentCampaignId = campaignIdRef.current;
    const detailSnapshot = detailRef.current;
    if (currentCampaignId == null) return;
    const name = detailSnapshot.name?.trim();
    if (!name) {
      toast.error("Name the campaign before running an A/B test.");
      return;
    }
    const abName = `${name} (subject test)`;
    const result = await createABTestCampaign({
      name: abName,
      subject_variants: top3.map((variant) => variant.text),
      body_html: asCampaignString(detailSnapshot.body_html ?? ""),
      from_name: detailSnapshot.from_name ?? undefined,
      delivery_settings: {
        ab_test: {
          bandit: true,
          policy: "thompson_opens",
          explore_floor: 0.1,
        },
      },
    });
    if (result.error) {
      toast.error(`Couldn't create A/B test: ${result.error.message}`);
      return;
    }
    if (campaignIdRef.current !== currentCampaignId) return;
    toast.success({
      message: `A/B test "${abName}" created`,
      detail: `${result.data.children.length} bandit arms ready to send — this campaign is unchanged.`,
    });
    trackTelemetry("campaign_ab_test_created", {
      variant_count: result.data.children.length,
      source: "copilot_rail",
    });
    onChange?.(detailSnapshot);
  };

  return {
    editing,
    draftDirty,
    draft,
    setDraft,
    saving,
    freezingAudience,
    saveErr,
    bodyTab,
    setBodyTab,
    editorMode,
    setEditorMode,
    blockInstances,
    setBlockInstances,
    lastComposedMjml,
    setLastComposedMjml,
    confirmModeSwitch,
    setConfirmModeSwitch,
    translateOpen,
    setTranslateOpen,
    utmOpen,
    setUtmOpen,
    editorWrapRef,
    openEdit,
    discardEdit,
    saveEdit,
    freezeAudience,
    pickSubjectFromLab,
    runSubjectBandit,
  };
}
