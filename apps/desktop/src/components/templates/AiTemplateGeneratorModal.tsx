import {
  type ReactElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  type BrandVoiceProfile,
  type Campaign,
  type CampaignTemplate,
  api,
} from "../../lib/api-client";
import {
  type CampaignTemplateDesignDraft,
  type CampaignTemplateDesignCreateAttemptRecord,
  type CampaignTemplateDesignOutput,
  type CampaignTemplateDesignRevision,
  type CampaignTemplateDesignSummary,
  type CreateCampaignTemplateDesignInput,
  campaignTemplateDesignsApi,
  clearCampaignTemplateDesignCreateAttempt,
  clearCampaignTemplateDesignResume,
  isCampaignTemplateDesignActive,
  pollCampaignTemplateDesign,
  readCampaignTemplateDesignCreateAttempt,
  readCampaignTemplateDesignResume,
  writeCampaignTemplateDesignCreateAttempt,
  writeCampaignTemplateDesignResume,
} from "../../lib/api/campaign-template-designs";
import {
  type CampaignTemplateDesignMutationOperation,
  type CampaignTemplateDesignMutationPayload,
  type CampaignTemplateDesignPendingMutation,
  clearCampaignTemplateDesignPendingMutation,
  prepareCampaignTemplateDesignMutation,
  readCampaignTemplateDesignPendingMutation,
} from "../../lib/campaign-template-design-mutation-recovery";
import { newUUIDv7 } from "../../lib/http-fetch";
import { registerLifecycleGuard } from "../../lib/lifecycle-coordinator";
import { ConfirmModal } from "../ConfirmModal";
import { Modal } from "../Modal";
import { type PreviewDevice } from "../TemplatePreview";
import { toast } from "../Toast";
import {
  type BrandChoice,
  type FinishMode,
  type RetainedTemplateVersion,
  TemplateBriefStep,
  TemplateReviewStep,
  TemplateWizardProgress,
  type TemplateWizardStage,
} from "./AiTemplateGeneratorWizardSteps";
import {
  type TemplateFidelity,
  type TemplateGenKind,
  TEMPLATE_ADAPT_INSTRUCTIONS_MAX,
  aiTemplateSlug,
  buildTemplateDirection,
  describeTemplateGenError,
  validateTemplateGenInput,
} from "./template-ai";
import { decodeCampaignTemplate } from "./template-runtime";

interface Props {
  open: boolean;
  onClose: () => void;
  adaptSource?: CampaignTemplate | null;
  workspaceScope?: string;
  onSaved: (template: CampaignTemplate) => void;
  onCampaignCreated: (campaign: Campaign) => void;
  onOpenCampaigns: () => void;
}

type DesignMutation = "create" | "refine" | "retry" | null;

const FIDELITY_API_VALUE: Record<
  TemplateFidelity,
  "close" | "balanced" | "inspired"
> = {
  layout: "close",
  vibe: "balanced",
  fresh: "inspired",
};

function kindForTemplate(template: CampaignTemplate | null): TemplateGenKind {
  if (template?.goal === "promotional") return "promo";
  if (template?.goal === "announcement") return "announcement";
  return "newsletter";
}

function contentDirection(
  keySections: string,
  cta: string,
): Record<string, unknown> | undefined {
  const content: Record<string, unknown> = {};
  if (keySections.trim()) content["key_sections"] = keySections.trim();
  if (cta.trim()) content["call_to_action"] = cta.trim();
  return Object.keys(content).length > 0 ? content : undefined;
}

function brandDirection(
  choice: BrandChoice,
  profile: BrandVoiceProfile | null,
): Record<string, unknown> | undefined {
  if (choice !== "profile" || !profile) return undefined;
  return {
    descriptors: profile.descriptors,
    writing_rules: profile.writing_rules,
    sample_snippets: profile.sample_snippets,
  };
}

function validBrandProfile(
  value: BrandVoiceProfile | undefined,
): value is BrandVoiceProfile {
  return Boolean(
    value &&
    value.is_active === true &&
    Array.isArray(value.descriptors) &&
    value.descriptors.every((item) => typeof item === "string") &&
    Array.isArray(value.writing_rules) &&
    value.writing_rules.every((item) => typeof item === "string") &&
    Array.isArray(value.sample_snippets) &&
    value.sample_snippets.every((item) => typeof item === "string"),
  );
}

function reviewedDraftError(
  draft: CampaignTemplateDesignOutput,
  name: string,
): string | null {
  const reviewedName = name.trim();
  if (!reviewedName) return "Enter a template name before finishing.";
  if (new TextEncoder().encode(reviewedName).length > 200) {
    return "The template name is too long once encoded. Shorten it before finishing.";
  }
  if (!draft.subject.trim()) return "Enter a subject before finishing.";
  return null;
}

function campaignSummary(value: unknown): Campaign | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const campaign = value as Record<string, unknown>;
  const id = campaign["id"];
  if (
    !(
      (typeof id === "string" && id.trim() !== "") ||
      (typeof id === "number" && Number.isFinite(id))
    )
  ) {
    return null;
  }
  return {
    id,
    ...(typeof campaign["name"] === "string" ? { name: campaign["name"] } : {}),
    ...(typeof campaign["subject"] === "string"
      ? { subject: campaign["subject"] }
      : {}),
    ...(typeof campaign["status"] === "string"
      ? { status: campaign["status"] }
      : {}),
  };
}

function generatedVariableValues(
  value: CampaignTemplateDesignOutput,
): Record<string, string | number | boolean | null> {
  const defaults =
    value.variables && typeof value.variables === "object"
      ? value.variables
      : {};
  const names = new Set<string>([
    ...Object.keys(defaults),
    ...value.unresolved_variables,
  ]);
  const values: Record<string, string | number | boolean | null> = {};
  for (const rawName of names) {
    const name = rawName.trim();
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name)) continue;
    const raw = defaults[name];
    values[name] =
      raw === null ||
      typeof raw === "string" ||
      typeof raw === "boolean" ||
      (typeof raw === "number" && Number.isFinite(raw))
        ? raw
        : "";
  }
  return values;
}

function retainedVersion(
  revision: CampaignTemplateDesignRevision,
): RetainedTemplateVersion {
  return {
    draft: revision.output,
    name: revision.output.name,
    revision: revision.revision,
    outputHash: revision.output_hash,
    validation: revision.validation,
    warnings: revision.warnings,
  };
}

function conflictMessage(code: string | undefined): string | null {
  if (code === "design_revision_conflict") {
    return "A newer server revision exists. Moosewave refreshed the review; check it before trying again.";
  }
  if (code === "design_output_hash_mismatch") {
    return "The reviewed output hash no longer matches the server. Moosewave refreshed the immutable revision; check it before trying again.";
  }
  return null;
}

function mutationFailureIsDefinitive(result: {
  error?: { code?: string; status?: number };
}): boolean {
  if (!result.error) return false;
  // requireOnline rejects this before dispatch, so no server mutation exists.
  if (result.error.code === "offline") return true;
  if (result.error.code === "design_mutation_replay_ambiguous") return false;
  const status = result.error.status ?? 0;
  // A final 4xx response is a definitive rejection/outcome except for request
  // timeout and rate limiting, where retaining the exact key is safer.
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

function mutationRecoveryError(
  reason:
    | "fingerprint-unavailable"
    | "identity-unavailable"
    | "pending-mutation-conflict"
    | "recovery-record-invalid"
    | "storage-unavailable",
): string {
  if (reason === "pending-mutation-conflict") {
    return "A previous design action still needs server reconciliation. Reopen this design before starting a different action.";
  }
  if (reason === "recovery-record-invalid") {
    return "Moosewave found an unreadable recovery checkpoint. No request was sent, because replacing it could duplicate a save or campaign.";
  }
  if (reason === "identity-unavailable") {
    return "Moosewave could not verify the current workspace and user. No request was sent.";
  }
  return "Recovery storage is unavailable. No request was sent; enable local app storage or restart Moosewave before trying again.";
}

function pendingMutationAcknowledged(
  pending: CampaignTemplateDesignPendingMutation,
  draft: CampaignTemplateDesignDraft,
): boolean {
  if (draft.id !== pending.payload.design_id) return false;
  const revision = pending.payload.revision;
  if (pending.operation === "archive") return draft.status === "archived";
  if (pending.operation === "refine") {
    const baseRevision = pending.payload.base_revision;
    return (
      typeof baseRevision === "number" && draft.current_revision > baseRevision
    );
  }
  if (pending.operation === "retry") {
    const attemptCount = pending.payload.attempt_count;
    return (
      typeof attemptCount === "number" && draft.attempt_count > attemptCount
    );
  }
  if (pending.operation === "save") {
    return (
      typeof revision === "number" &&
      Boolean(draft.saved_template_id) &&
      draft.saved_revision === revision
    );
  }
  return (
    typeof revision === "number" &&
    Boolean(draft.created_campaign_id) &&
    draft.campaign_revision === revision
  );
}

function pendingMutationCanReplay(
  pending: CampaignTemplateDesignPendingMutation,
  draft: CampaignTemplateDesignDraft,
): boolean {
  if (draft.id !== pending.payload.design_id) return false;
  if (pending.operation === "archive") {
    return (
      draft.status !== "archived" &&
      pending.payload.status === draft.status &&
      draft.capabilities.can_archive
    );
  }
  if (pending.operation === "refine") {
    return (
      typeof pending.payload.base_revision === "number" &&
      draft.current_revision === pending.payload.base_revision &&
      draft.capabilities.can_refine
    );
  }
  if (pending.operation === "retry") {
    return (
      typeof pending.payload.attempt_count === "number" &&
      draft.attempt_count === pending.payload.attempt_count &&
      draft.capabilities.can_retry
    );
  }
  return (
    typeof pending.payload.revision === "number" &&
    draft.current_revision === pending.payload.revision &&
    typeof pending.payload.output_hash === "string" &&
    pending.payload.output_hash === draft.revision?.output_hash &&
    (pending.operation === "save"
      ? draft.capabilities.can_save
      : draft.capabilities.can_create_campaign)
  );
}

function pendingMutationLabel(
  operation: CampaignTemplateDesignMutationOperation,
): string {
  if (operation === "create-campaign") return "campaign creation";
  if (operation === "save") return "template save";
  if (operation === "retry") return "design retry";
  if (operation === "refine") return "refinement";
  return "discard";
}

export function AiTemplateGeneratorModal({
  open,
  onClose,
  adaptSource = null,
  workspaceScope,
  onSaved,
  onCampaignCreated,
  onOpenCampaigns,
}: Props): ReactElement {
  const verifiedWorkspaceScope = workspaceScope?.trim() || null;
  const resumeScope = verifiedWorkspaceScope ?? "";
  const [activeSource, setActiveSource] = useState<CampaignTemplate | null>(
    adaptSource,
  );
  const [brief, setBrief] = useState("");
  const [audience, setAudience] = useState("");
  const [keySections, setKeySections] = useState("");
  const [cta, setCta] = useState("");
  const [kind, setKind] = useState<TemplateGenKind>("newsletter");
  const [tone, setTone] = useState("");
  const [fidelity, setFidelity] = useState<TemplateFidelity>("fresh");
  const [brandChoice, setBrandChoice] = useState<BrandChoice>("default");
  const [brandProfile, setBrandProfile] = useState<BrandVoiceProfile | null>(
    null,
  );
  const [brandLoading, setBrandLoading] = useState(false);
  const [brandError, setBrandError] = useState<string | null>(null);
  const [design, setDesign] = useState<CampaignTemplateDesignDraft | null>(
    null,
  );
  const [revisions, setRevisions] = useState<CampaignTemplateDesignRevision[]>(
    [],
  );
  const [selectedRevision, setSelectedRevision] =
    useState<CampaignTemplateDesignRevision | null>(null);
  const [draft, setDraft] = useState<CampaignTemplateDesignOutput | null>(null);
  const [draftName, setDraftName] = useState("");
  const [refinement, setRefinement] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [mutation, setMutation] = useState<DesignMutation>(null);
  const [resuming, setResuming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [resumePersistenceFailed, setResumePersistenceFailed] = useState(false);
  const [finishMode, setFinishMode] = useState<FinishMode>(null);
  const [campaignAlreadyExists, setCampaignAlreadyExists] = useState(false);
  const [savedTemplateResult, setSavedTemplateResult] =
    useState<CampaignTemplate | null>(null);
  const [createdCampaignResult, setCreatedCampaignResult] =
    useState<Campaign | null>(null);
  const [pendingCreateConfirmation, setPendingCreateConfirmation] =
    useState<CampaignTemplateDesignCreateAttemptRecord | null>(null);
  const [serverRecoveryCandidates, setServerRecoveryCandidates] = useState<
    CampaignTemplateDesignSummary[]
  >([]);
  const [serverRecoveryCursor, setServerRecoveryCursor] = useState<
    string | null
  >(null);
  const [serverRecoveryLoading, setServerRecoveryLoading] = useState(false);
  const [device, setDevice] = useState<PreviewDevice>("desktop");
  const [dark, setDark] = useState(false);
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);
  const [startOverConfirmOpen, setStartOverConfirmOpen] = useState(false);
  const requestSeq = useRef(0);
  const brandRequestSeq = useRef(0);
  const revisionRequestSeq = useRef(0);
  const serverRecoveryRequestSeq = useRef(0);
  const finishInFlight = useRef(false);
  const createDispatchInFlight = useRef(false);
  const createAttemptRef =
    useRef<CampaignTemplateDesignCreateAttemptRecord | null>(null);
  const resumeAttemptRef = useRef("");
  const mutationRecoveryAttemptRef = useRef("");

  const checkpointMutation = useCallback(
    async (
      operation: CampaignTemplateDesignMutationOperation,
      payload: CampaignTemplateDesignMutationPayload,
    ): Promise<CampaignTemplateDesignPendingMutation | null> => {
      const prepared = await prepareCampaignTemplateDesignMutation(
        verifiedWorkspaceScope,
        operation,
        payload,
        newUUIDv7,
      );
      if (!prepared.ok) {
        setErr(mutationRecoveryError(prepared.reason));
        return null;
      }
      return prepared.mutation;
    },
    [verifiedWorkspaceScope],
  );

  const acknowledgeMutation = useCallback(
    async (
      pending: CampaignTemplateDesignPendingMutation,
    ): Promise<boolean> => {
      const cleared = await clearCampaignTemplateDesignPendingMutation(
        verifiedWorkspaceScope,
        pending,
      );
      if (!cleared) {
        setErr(
          `The server confirmed the ${pendingMutationLabel(pending.operation)}, but Moosewave could not clear its local recovery checkpoint. Reopen this design after local storage is available before starting another action.`,
        );
      }
      return cleared;
    },
    [verifiedWorkspaceScope],
  );

  const retireDefinitiveMutationFailure = useCallback(
    async (
      pending: CampaignTemplateDesignPendingMutation,
      result: { error?: { code?: string; status?: number } },
    ): Promise<boolean> => {
      if (!mutationFailureIsDefinitive(result)) return true;
      const cleared = await clearCampaignTemplateDesignPendingMutation(
        verifiedWorkspaceScope,
        pending,
      );
      if (!cleared) {
        setErr(
          `The server returned a definitive result for the ${pendingMutationLabel(pending.operation)}, but its local recovery checkpoint could not be cleared. Restore local storage and reopen this design before starting another action.`,
        );
      }
      return cleared;
    },
    [verifiedWorkspaceScope],
  );

  const setRevisionForReview = useCallback(
    (revision: CampaignTemplateDesignRevision): void => {
      setSelectedRevision(revision);
      setDraft({ ...revision.output });
      setDraftName(revision.output.name);
      setRefinement("");
    },
    [],
  );

  const persistResumePointer = useCallback(
    (next: CampaignTemplateDesignDraft): boolean => {
      if (!resumeScope) {
        setResumePersistenceFailed(true);
        return false;
      }
      const persisted = writeCampaignTemplateDesignResume(resumeScope, next);
      setResumePersistenceFailed(!persisted);
      return persisted;
    },
    [resumeScope],
  );

  const loadRevisions = useCallback(
    async (
      designId: string,
      latest?: CampaignTemplateDesignRevision,
    ): Promise<void> => {
      const seq = ++revisionRequestSeq.current;
      const result = await campaignTemplateDesignsApi.revisions(designId);
      if (seq !== revisionRequestSeq.current) return;
      if (result.error) {
        setErr(
          `The design is ready, but its revision history could not be loaded: ${result.error.message}`,
        );
        if (latest) {
          setRevisions([latest]);
        }
        return;
      }
      const history = [...result.data.items].sort(
        (left, right) => right.revision - left.revision,
      );
      const matchingLatest = latest
        ? history.find((item) => item.revision === latest.revision)
        : undefined;
      if (
        latest &&
        matchingLatest &&
        (matchingLatest.id !== latest.id ||
          matchingLatest.draft_id !== latest.draft_id ||
          matchingLatest.output_hash !== latest.output_hash)
      ) {
        setRevisions([latest]);
        setErr(
          "The server revision history disagrees with the exact revision being reviewed. Moosewave kept the verified current revision and blocked the inconsistent history.",
        );
        return;
      }
      const completeHistory =
        latest && !matchingLatest ? [latest, ...history] : history;
      setRevisions(completeHistory);
      const current =
        latest ??
        completeHistory.find(
          (revision) =>
            revision.revision ===
            Math.max(0, ...completeHistory.map((item) => item.revision)),
        );
      // applyDesign selects `latest` synchronously. Do not select it again
      // after this background request: the operator may already have edited
      // the reviewed name, subject, or preview text while history was loading.
      if (!latest && current) setRevisionForReview(current);
    },
    [setRevisionForReview],
  );

  const applyDesign = useCallback(
    (
      next: CampaignTemplateDesignDraft,
      options: { selectLatest?: boolean } = {},
    ): void => {
      setDesign(next);
      setCampaignAlreadyExists(Boolean(next.created_campaign_id));
      if (resumeScope) {
        if (next.status === "archived") {
          clearCampaignTemplateDesignResume(resumeScope, next.id);
          setResumePersistenceFailed(false);
        } else {
          persistResumePointer(next);
        }
      } else if (next.status !== "archived") {
        setResumePersistenceFailed(true);
      }
      if (
        options.selectLatest !== false &&
        next.revision &&
        !isCampaignTemplateDesignActive(next.status)
      ) {
        setRevisionForReview(next.revision);
        void loadRevisions(next.id, next.revision);
      }
    },
    [loadRevisions, persistResumePointer, resumeScope, setRevisionForReview],
  );

  const clearDesign = useCallback(
    (
      options: {
        preserveResume?: boolean;
        preserveCreateAttempt?: boolean;
      } = {},
    ): void => {
      const designId = design?.id;
      if (designId && resumeScope && !options.preserveResume) {
        clearCampaignTemplateDesignResume(resumeScope, designId);
      }
      if (resumeScope && !options.preserveCreateAttempt) {
        void clearCampaignTemplateDesignCreateAttempt(resumeScope);
      }
      requestSeq.current += 1;
      revisionRequestSeq.current += 1;
      finishInFlight.current = false;
      createAttemptRef.current = null;
      setDesign(null);
      setRevisions([]);
      setSelectedRevision(null);
      setDraft(null);
      setDraftName("");
      setRefinement("");
      setErr(null);
      setMutation(null);
      setResuming(false);
      setSaving(false);
      setResumePersistenceFailed(false);
      setFinishMode(null);
      setCampaignAlreadyExists(false);
      setSavedTemplateResult(null);
      setCreatedCampaignResult(null);
      setPendingCreateConfirmation(null);
      setServerRecoveryCandidates([]);
      setServerRecoveryCursor(null);
      setServerRecoveryLoading(false);
    },
    [design?.id, resumeScope],
  );

  const reset = useCallback(
    (options: { preserveResume?: boolean } = {}): void => {
      clearDesign(options);
      brandRequestSeq.current += 1;
      setActiveSource(null);
      setBrief("");
      setAudience("");
      setKeySections("");
      setCta("");
      setKind("newsletter");
      setTone("");
      setFidelity("fresh");
      setBrandChoice("default");
      setBrandProfile(null);
      setBrandLoading(false);
      setBrandError(null);
      setDevice("desktop");
      setDark(false);
      setDiscardConfirmOpen(false);
      setStartOverConfirmOpen(false);
    },
    [clearDesign],
  );

  const refreshCurrentDesign = useCallback(
    async (message?: string): Promise<void> => {
      if (!design) return;
      const result = await campaignTemplateDesignsApi.get(design.id);
      if (result.error) {
        setErr(
          message ??
            `The design could not be refreshed: ${result.error.message}`,
        );
        return;
      }
      if (result.data.status === "archived") {
        if (resumeScope) {
          clearCampaignTemplateDesignResume(resumeScope, result.data.id);
        }
        clearDesign();
        setErr(
          "This saved design session was archived. Start a new direction.",
        );
        return;
      }
      applyDesign(result.data);
      if (message) setErr(message);
    },
    [applyDesign, clearDesign, design, resumeScope],
  );

  useEffect(() => {
    if (!open) {
      // A recovery pass is per opening. Otherwise an empty result, dismissed
      // chooser, or interrupted request suppresses recovery until the entire
      // Templates page is unmounted.
      resumeAttemptRef.current = "";
      mutationRecoveryAttemptRef.current = "";
      serverRecoveryRequestSeq.current += 1;
      setServerRecoveryCandidates([]);
      setServerRecoveryCursor(null);
      setServerRecoveryLoading(false);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (adaptSource && !design) {
      setActiveSource(adaptSource);
      setKind(kindForTemplate(adaptSource));
      setFidelity("vibe");
    } else if (!design && !activeSource) {
      setKind("newsletter");
      setFidelity("fresh");
    }
  }, [adaptSource, design, activeSource, open]);

  useEffect(() => {
    if (!open) {
      brandRequestSeq.current += 1;
      return;
    }
    const seq = ++brandRequestSeq.current;
    setBrandLoading(true);
    setBrandError(null);
    void (async () => {
      try {
        const res = await api.getBrandVoiceProfile();
        if (seq !== brandRequestSeq.current) return;
        if (res.error) {
          setBrandProfile(null);
          setBrandChoice("default");
          if (res.error.status !== 404) {
            setBrandError("The workspace brand profile could not be loaded.");
          }
          return;
        }
        if (!validBrandProfile(res.data)) {
          setBrandProfile(null);
          setBrandChoice("default");
          setBrandError("No active workspace brand profile was found.");
          return;
        }
        setBrandProfile(res.data);
        setBrandChoice("profile");
      } catch {
        if (seq !== brandRequestSeq.current) return;
        setBrandProfile(null);
        setBrandChoice("default");
        setBrandError("The workspace brand profile could not be loaded.");
      } finally {
        if (seq === brandRequestSeq.current) setBrandLoading(false);
      }
    })();
  }, [open, resumeScope]);

  useEffect(() => {
    if (!open || design || !resumeScope) return;
    const attemptKey = `${resumeScope}:${open ? "open" : "closed"}`;
    if (resumeAttemptRef.current === attemptKey) return;
    resumeAttemptRef.current = attemptKey;
    const resume = readCampaignTemplateDesignResume(resumeScope);
    const seq = ++requestSeq.current;
    const controller = new AbortController();
    void (async () => {
      const [pendingCreate, pendingMutation] = await Promise.all([
        resume
          ? Promise.resolve(null)
          : readCampaignTemplateDesignCreateAttempt(resumeScope),
        readCampaignTemplateDesignPendingMutation(verifiedWorkspaceScope),
      ]);
      if (controller.signal.aborted || seq !== requestSeq.current) return;
      if (pendingCreate) createAttemptRef.current = pendingCreate;
      if (pendingMutation.state === "invalid") {
        setErr(
          "Moosewave found an unreadable design-action checkpoint. It was left untouched; no request will be replayed, but server designs can still be reopened for inspection.",
        );
      }
      if (pendingMutation.state === "unavailable") {
        setErr(
          "Recovery storage is unavailable. Design actions are paused, but Moosewave can still look for server designs that are safe to inspect.",
        );
      }
      const pendingDesignId =
        pendingMutation.state === "ready"
          ? pendingMutation.mutation.payload.design_id
          : null;
      const resumePointerMismatch = Boolean(
        resume && pendingDesignId && resume.designId !== pendingDesignId,
      );
      const designIdToResume = pendingDesignId ?? resume?.designId ?? null;
      if (!designIdToResume && pendingCreate) {
        setPendingCreateConfirmation(pendingCreate);
        setErr(
          "Moosewave found an unfinished design request. It was not replayed automatically. Resume that exact request, or discard it before starting a different direction.",
        );
        return;
      }
      if (!designIdToResume) {
        const recoverySeq = ++serverRecoveryRequestSeq.current;
        setServerRecoveryLoading(true);
        const recovery = await campaignTemplateDesignsApi.list({
          limit: 20,
          signal: controller.signal,
        });
        if (
          controller.signal.aborted ||
          seq !== requestSeq.current ||
          recoverySeq !== serverRecoveryRequestSeq.current
        ) {
          return;
        }
        setServerRecoveryLoading(false);
        if (recovery.error) {
          if (recovery.error.status !== 404) {
            setErr(
              `Saved design recovery is temporarily unavailable: ${recovery.error.message}`,
            );
          }
          return;
        }
        setServerRecoveryCandidates(recovery.data.items);
        setServerRecoveryCursor(recovery.data.next_cursor ?? null);
        return;
      }
      setResuming(true);
      setErr(null);
      const result = await campaignTemplateDesignsApi.get(designIdToResume, {
        signal: controller.signal,
      });
      if (controller.signal.aborted || seq !== requestSeq.current) return;
      if (result.error) {
        if (
          designIdToResume &&
          (result.error.code === "design_draft_not_found" ||
            result.error.status === 404)
        ) {
          if (resume) {
            clearCampaignTemplateDesignResume(resumeScope, resume.designId);
          }
        }
        setErr(
          designIdToResume
            ? `The saved design session could not be resumed: ${result.error.message}`
            : `The pending design request could not be recovered yet: ${result.error.message}`,
        );
        return;
      }
      if (result.data.status === "archived") {
        let archivedMessage =
          "This saved design session was archived. Start a new direction.";
        if (
          pendingMutation.state === "ready" &&
          pendingMutation.mutation.payload.design_id === result.data.id &&
          pendingMutationAcknowledged(pendingMutation.mutation, result.data)
        ) {
          const cleared = await clearCampaignTemplateDesignPendingMutation(
            verifiedWorkspaceScope,
            pendingMutation.mutation,
          );
          if (!cleared) {
            archivedMessage = `This design is archived and the server confirms its previous ${pendingMutationLabel(pendingMutation.mutation.operation)}, but the local recovery checkpoint could not be cleared. Restore local storage and reopen this window before starting another design action.`;
          }
        } else if (
          pendingMutation.state === "ready" &&
          pendingMutation.mutation.payload.design_id === result.data.id
        ) {
          archivedMessage = `This design is archived, but its previous ${pendingMutationLabel(pendingMutation.mutation.operation)} could not be proven from the final server state. The checkpoint was retained to prevent a duplicate.`;
        }
        clearCampaignTemplateDesignResume(resumeScope, result.data.id);
        clearDesign();
        setErr(archivedMessage);
        return;
      }
      applyDesign(result.data);
      if (
        result.data.source_template_id &&
        activeSource?.id !== result.data.source_template_id
      ) {
        const sourceResult = await api.getCampaignTemplate(
          result.data.source_template_id,
        );
        if (seq !== requestSeq.current || sourceResult.error) return;
        const source = decodeCampaignTemplate(sourceResult.data);
        if (source) setActiveSource(source);
      }
      toast.info(
        resumePointerMismatch
          ? "A pending action took priority over an older local design pointer. The pending design was reopened for safe reconciliation."
          : pendingDesignId
            ? "Your design was reopened to reconcile its pending action."
            : "Your server-backed template design was resumed.",
      );
    })()
      .catch(() => {
        if (!controller.signal.aborted && seq === requestSeq.current) {
          setErr(
            resume
              ? "The saved design session could not be resumed. Check the connection and reopen this window."
              : "The pending design request still has no acknowledgement. Reopen this window when the connection is available; Moosewave will reuse the same request key.",
          );
        }
      })
      .finally(() => {
        if (seq === requestSeq.current) {
          setResuming(false);
          setServerRecoveryLoading(false);
        }
      });
    return () => controller.abort();
  }, [
    activeSource?.id,
    applyDesign,
    clearDesign,
    design,
    open,
    resumeScope,
    verifiedWorkspaceScope,
  ]);

  useEffect(() => {
    if (!open || !design || !verifiedWorkspaceScope) return;
    const recoveryKey = `${verifiedWorkspaceScope}:${design.id}:${design.status}:${design.current_revision}:${design.attempt_count}:${design.saved_template_id ?? ""}:${design.created_campaign_id ?? ""}`;
    if (mutationRecoveryAttemptRef.current === recoveryKey) return;
    mutationRecoveryAttemptRef.current = recoveryKey;
    let cancelled = false;
    void (async () => {
      const pending = await readCampaignTemplateDesignPendingMutation(
        verifiedWorkspaceScope,
      );
      if (cancelled || pending.state === "empty") return;
      if (pending.state === "invalid") {
        setErr(
          "Moosewave found an unreadable design-action checkpoint. It was left untouched to avoid duplicating a mutation.",
        );
        return;
      }
      if (pending.state === "unavailable") {
        setErr(
          "Recovery storage is unavailable. No design action will be sent until its retry identity can be persisted.",
        );
        return;
      }
      if (pending.mutation.payload.design_id !== design.id) {
        setErr(
          "A pending action belongs to another design in this workspace. Moosewave will not replay it here.",
        );
        return;
      }
      if (pendingMutationAcknowledged(pending.mutation, design)) {
        const cleared = await clearCampaignTemplateDesignPendingMutation(
          verifiedWorkspaceScope,
          pending.mutation,
        );
        if (!cancelled) {
          if (cleared) {
            toast.info(
              `The server confirmed the previous ${pendingMutationLabel(pending.mutation.operation)}; recovery is complete.`,
            );
          } else {
            setErr(
              `The server confirmed the previous ${pendingMutationLabel(pending.mutation.operation)}, but its local recovery checkpoint could not be cleared. Restore local storage and reopen this design before starting another action.`,
            );
          }
        }
        return;
      }
      if (pendingMutationCanReplay(pending.mutation, design)) {
        if (
          pending.mutation.operation === "refine" &&
          typeof pending.mutation.payload.instructions === "string"
        ) {
          setRefinement(pending.mutation.payload.instructions);
        }
        if (
          pending.mutation.operation === "save" ||
          pending.mutation.operation === "create-campaign"
        ) {
          if (typeof pending.mutation.payload.name === "string") {
            setDraftName(pending.mutation.payload.name);
          }
          setDraft((current) =>
            current
              ? {
                  ...current,
                  ...(typeof pending.mutation.payload.subject === "string"
                    ? { subject: pending.mutation.payload.subject }
                    : {}),
                  ...(typeof pending.mutation.payload.preview_text === "string"
                    ? {
                        preview_text: pending.mutation.payload.preview_text,
                      }
                    : {}),
                }
              : current,
          );
        }
        setErr(
          `The previous ${pendingMutationLabel(pending.mutation.operation)} was not confirmed. The server lineage is unchanged; repeat that exact action to safely reuse its request key.`,
        );
        return;
      }
      setErr(
        `The previous ${pendingMutationLabel(pending.mutation.operation)} could not be matched to the current server lineage. It was not replayed or discarded.`,
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [design, open, verifiedWorkspaceScope]);

  const designId = design?.id ?? "";
  const designStatus = design?.status;
  useEffect(() => {
    if (!open || !design || !isCampaignTemplateDesignActive(design.status)) {
      return;
    }
    const initial = design;
    const controller = new AbortController();
    void pollCampaignTemplateDesign(initial.id, {
      initial,
      signal: controller.signal,
      onUpdate: (next) => {
        setDesign(next);
        persistResumePointer(next);
      },
    })
      .then((result) => {
        if (controller.signal.aborted) return;
        if (result.error) {
          if (result.error.code === "design_expired") {
            clearDesign();
          }
          setErr(result.error.message);
          return;
        }
        if (result.data.status === "archived") {
          clearDesign();
          setErr("This design was archived and can no longer be changed.");
          return;
        }
        applyDesign(result.data);
        if (result.data.status === "failed") {
          setErr(
            result.data.last_error_message ||
              "The design job failed. Your direction is still available and the server says whether retry is allowed.",
          );
        } else {
          setErr(null);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setErr(
            "Live design updates paused because the connection dropped. Keep this window open and refresh the server design before continuing.",
          );
        }
      });
    return () => controller.abort();
    // Status is intentionally included so the queued → generating transition
    // replaces the old poller with a fresh server hint and backoff window.
  }, [
    applyDesign,
    clearDesign,
    designId,
    designStatus,
    open,
    persistResumePointer,
    resumeScope,
  ]);

  const generating =
    resuming ||
    mutation !== null ||
    (design !== null && isCampaignTemplateDesignActive(design.status));
  const localDirectionDirty =
    brief.trim().length > 0 ||
    audience.trim().length > 0 ||
    keySections.trim().length > 0 ||
    cta.trim().length > 0 ||
    tone.trim().length > 0;
  const generatorDirty = open && (design !== null || localDirectionDirty);

  const requestClose = useCallback((): void => {
    if (saving || mutation === "create") {
      setErr(
        mutation === "create"
          ? "Keep this window open until the server returns a durable design ID."
          : "Wait for the server to acknowledge this design action before closing.",
      );
      return;
    }
    if (design) {
      toast.info(
        resumePersistenceFailed
          ? `Design ${design.id} exists on the server, but automatic reopening is unavailable on this device.`
          : "Design saved on the server. Reopen this window to continue.",
      );
      onClose();
      return;
    }
    if (localDirectionDirty) {
      setDiscardConfirmOpen(true);
      return;
    }
    onClose();
  }, [
    design,
    localDirectionDirty,
    mutation,
    onClose,
    resumePersistenceFailed,
    saving,
  ]);

  const archiveDesign = useCallback(
    async (closeAfter: boolean): Promise<void> => {
      if (!design) {
        reset();
        if (closeAfter) onClose();
        return;
      }
      if (!design.capabilities.can_archive) {
        setErr(
          isCampaignTemplateDesignActive(design.status)
            ? "This job is still running. Close the window to let it continue, then discard it after it finishes."
            : "The server has not made this design available for archiving.",
        );
        setDiscardConfirmOpen(false);
        setStartOverConfirmOpen(false);
        return;
      }
      setSaving(true);
      setErr(null);
      try {
        const pending = await checkpointMutation("archive", {
          design_id: design.id,
          status: design.status,
        });
        if (!pending) return;
        const result = await campaignTemplateDesignsApi.archive(design.id, {
          idempotencyKey: pending.key,
        });
        if (result.error) {
          if (!(await retireDefinitiveMutationFailure(pending, result))) {
            return;
          }
          setErr(`The design could not be discarded: ${result.error.message}`);
          return;
        }
        if (!(await acknowledgeMutation(pending))) {
          return;
        }
        if (resumeScope) {
          clearCampaignTemplateDesignResume(resumeScope, design.id);
        }
        if (closeAfter) {
          reset();
          onClose();
        } else {
          clearDesign();
        }
      } catch {
        setErr(
          "The discard request did not complete. The design remains resumable until the server confirms archival.",
        );
      } finally {
        setSaving(false);
        setDiscardConfirmOpen(false);
        setStartOverConfirmOpen(false);
      }
    },
    [
      clearDesign,
      checkpointMutation,
      design,
      onClose,
      reset,
      retireDefinitiveMutationFailure,
      resumeScope,
      acknowledgeMutation,
    ],
  );

  useEffect(() => {
    if (!generatorDirty && !saving && mutation === null) return;
    return registerLifecycleGuard({
      id: "ai-template-generator",
      label: "AI template draft",
      inspect: (intent) => {
        if (design) return null;
        return intent.disposition === "hide"
          ? null
          : mutation === "create" || saving
            ? {
                level: "blocking",
                detail:
                  "Wait for the server to acknowledge the template design before leaving.",
                canDiscard: false,
              }
            : {
                level: "blocking",
                detail:
                  "The unsent creative direction exists only in this window.",
              };
      },
      discard: () => {
        reset();
        onClose();
      },
    });
  }, [design, generatorDirty, mutation, onClose, reset, saving]);

  const reopenServerDesign = async (designId: string): Promise<void> => {
    if (
      design ||
      resuming ||
      saving ||
      mutation !== null ||
      !serverRecoveryCandidates.some((candidate) => candidate.id === designId)
    ) {
      return;
    }
    const seq = ++requestSeq.current;
    serverRecoveryRequestSeq.current += 1;
    setResuming(true);
    setServerRecoveryLoading(false);
    setErr(null);
    try {
      const result = await campaignTemplateDesignsApi.get(designId);
      if (seq !== requestSeq.current) return;
      if (result.error) {
        if (
          result.error.status === 404 ||
          result.error.code === "design_draft_not_found"
        ) {
          setServerRecoveryCandidates((current) =>
            current.filter((candidate) => candidate.id !== designId),
          );
        }
        setErr(
          `The saved design could not be reopened: ${result.error.message}`,
        );
        return;
      }
      if (result.data.status === "archived") {
        setServerRecoveryCandidates((current) =>
          current.filter((candidate) => candidate.id !== designId),
        );
        setErr("That design was archived and is no longer recoverable.");
        return;
      }
      setServerRecoveryCandidates([]);
      setServerRecoveryCursor(null);
      applyDesign(result.data);
      if (
        result.data.source_template_id &&
        activeSource?.id !== result.data.source_template_id
      ) {
        const sourceResult = await api.getCampaignTemplate(
          result.data.source_template_id,
        );
        if (seq !== requestSeq.current || sourceResult.error) return;
        const source = decodeCampaignTemplate(sourceResult.data);
        if (source) setActiveSource(source);
      }
      toast.info("Your server-backed template design was reopened.");
    } catch {
      if (seq === requestSeq.current) {
        setErr(
          "The saved design could not be reopened. Check the connection and try again.",
        );
      }
    } finally {
      if (seq === requestSeq.current) setResuming(false);
    }
  };

  const loadOlderServerDesigns = async (): Promise<void> => {
    if (!serverRecoveryCursor || serverRecoveryLoading) return;
    const cursor = serverRecoveryCursor;
    const seq = ++serverRecoveryRequestSeq.current;
    setServerRecoveryLoading(true);
    setErr(null);
    try {
      const result = await campaignTemplateDesignsApi.list({
        limit: 20,
        cursor,
      });
      if (seq !== serverRecoveryRequestSeq.current) return;
      if (result.error) {
        setErr(`Older designs could not be loaded: ${result.error.message}`);
        return;
      }
      setServerRecoveryCandidates((current) => {
        const seen = new Set(current.map((candidate) => candidate.id));
        return [
          ...current,
          ...result.data.items.filter((candidate) => !seen.has(candidate.id)),
        ];
      });
      setServerRecoveryCursor(result.data.next_cursor ?? null);
    } catch {
      if (seq === serverRecoveryRequestSeq.current) {
        setErr("Older designs could not be loaded. Check the connection.");
      }
    } finally {
      if (seq === serverRecoveryRequestSeq.current) {
        setServerRecoveryLoading(false);
      }
    }
  };

  const resumePendingCreate = async (): Promise<void> => {
    const pending = pendingCreateConfirmation;
    if (
      !pending ||
      !resumeScope ||
      !verifiedWorkspaceScope ||
      mutation !== null ||
      saving ||
      design ||
      createDispatchInFlight.current
    ) {
      return;
    }
    createDispatchInFlight.current = true;
    const seq = ++requestSeq.current;
    setMutation("create");
    setResuming(true);
    setErr(null);
    try {
      const result = await campaignTemplateDesignsApi.create(pending.input, {
        idempotencyKey: pending.idempotencyKey,
      });
      if (seq !== requestSeq.current) return;
      if (result.error) {
        if (mutationFailureIsDefinitive(result)) {
          const cleared = await clearCampaignTemplateDesignCreateAttempt(
            resumeScope,
            pending.idempotencyKey,
          );
          if (cleared) {
            createAttemptRef.current = null;
            setPendingCreateConfirmation(null);
            setErr(
              `The server did not apply the pending request: ${result.error.message}. You can revise the direction and try again.`,
            );
          } else {
            setErr(
              "The server did not apply the pending request, but its local checkpoint could not be cleared. Restore local storage before starting another direction.",
            );
          }
        } else {
          setErr(
            `The exact pending request was not acknowledged: ${result.error.message}. It will not be replayed without another confirmation.`,
          );
        }
        return;
      }
      const checkpointCleared = await clearCampaignTemplateDesignCreateAttempt(
        resumeScope,
        pending.idempotencyKey,
      );
      createAttemptRef.current = checkpointCleared ? null : pending;
      setPendingCreateConfirmation(null);
      applyDesign(result.data);
      if (!checkpointCleared) {
        setErr(
          "The design exists on the server, but its old create checkpoint could not be cleared from this device. Keep this server design until local storage is available again.",
        );
      }
      if (
        result.data.source_template_id &&
        activeSource?.id !== result.data.source_template_id
      ) {
        const sourceResult = await api.getCampaignTemplate(
          result.data.source_template_id,
        );
        if (seq !== requestSeq.current || sourceResult.error) return;
        const source = decodeCampaignTemplate(sourceResult.data);
        if (source) setActiveSource(source);
      }
      toast.info(
        "Your exact pending template design request was safely resumed.",
      );
    } catch {
      if (seq === requestSeq.current) {
        setErr(
          "The server still did not acknowledge the exact pending request. It remains paused until you choose Resume again.",
        );
      }
    } finally {
      createDispatchInFlight.current = false;
      if (seq === requestSeq.current) {
        setResuming(false);
        setMutation(null);
      }
    }
  };

  const discardPendingCreate = async (): Promise<void> => {
    if (!pendingCreateConfirmation || !resumeScope) return;
    const cleared = await clearCampaignTemplateDesignCreateAttempt(
      resumeScope,
      pendingCreateConfirmation.idempotencyKey,
    );
    if (!cleared) {
      setErr(
        "The unfinished request checkpoint could not be discarded from this device. No request was sent; restore local storage and try again.",
      );
      return;
    }
    createAttemptRef.current = null;
    setPendingCreateConfirmation(null);
    setErr(null);
  };

  const startDesign = async (): Promise<void> => {
    if (generating || saving || design || createDispatchInFlight.current)
      return;
    if (!verifiedWorkspaceScope) {
      setErr(
        "Moosewave could not verify the current workspace and user. No design request was sent.",
      );
      return;
    }
    const source = activeSource;
    if (source && source.capabilities?.can_adapt !== true) {
      setErr(
        source.warnings?.[0]?.message ??
          "The server has not granted adaptation access to this inspiration.",
      );
      return;
    }
    const instructions = buildTemplateDirection({
      brief,
      ...(source ? { fidelity } : {}),
      audience,
      keySections,
      cta,
    });
    const validation = validateTemplateGenInput({
      brief: instructions,
      tone,
      ...(source ? { briefMax: TEMPLATE_ADAPT_INSTRUCTIONS_MAX } : {}),
    });
    if (validation) {
      setErr(validation);
      return;
    }
    createDispatchInFlight.current = true;
    const seq = ++requestSeq.current;
    const brand = brandDirection(brandChoice, brandProfile);
    const content = contentDirection(keySections, cta);
    const sections = keySections
      .split("\n")
      .map((section) => section.trim())
      .filter(Boolean)
      .slice(0, 12);
    setMutation("create");
    setErr(null);
    try {
      const input: CreateCampaignTemplateDesignInput = {
        mode: source ? "adapt" : "generate",
        ...(source
          ? {
              source_template_id: source.id,
              instructions,
            }
          : { brief: instructions, kind }),
        fidelity: FIDELITY_API_VALUE[fidelity],
        ...(tone.trim() ? { tone: tone.trim() } : {}),
        ...(audience.trim() ? { audience: audience.trim() } : {}),
        ...(sections.length > 0 ? { sections } : {}),
        ...(cta.trim() ? { cta: cta.trim() } : {}),
        ...(brand ? { brand } : {}),
        ...(content ? { content } : {}),
      };
      const serializedInput = JSON.stringify(input);
      const priorAttempt =
        createAttemptRef.current ??
        (await readCampaignTemplateDesignCreateAttempt(resumeScope));
      if (priorAttempt && priorAttempt.serializedInput !== serializedInput) {
        createAttemptRef.current = priorAttempt;
        setPendingCreateConfirmation(priorAttempt);
        setErr(
          "A different design request is still awaiting reconciliation. Resume or discard that exact request before starting this direction.",
        );
        return;
      }
      const idempotencyKey =
        priorAttempt?.serializedInput === serializedInput
          ? priorAttempt.idempotencyKey
          : newUUIDv7();
      const durableAttempt = await writeCampaignTemplateDesignCreateAttempt(
        resumeScope,
        input,
        idempotencyKey,
      );
      if (!durableAttempt) {
        createAttemptRef.current = null;
        setErr(
          "Recovery storage is unavailable. No design request was sent; enable local app storage or restart Moosewave before trying again.",
        );
        return;
      }
      createAttemptRef.current = durableAttempt;
      const result = await campaignTemplateDesignsApi.create(input, {
        idempotencyKey,
      });
      if (seq !== requestSeq.current) return;
      if (result.error) {
        const definitive = mutationFailureIsDefinitive(result);
        const checkpointCleared =
          definitive &&
          (await clearCampaignTemplateDesignCreateAttempt(
            resumeScope,
            idempotencyKey,
          ));
        if (checkpointCleared) {
          createAttemptRef.current = null;
          setPendingCreateConfirmation(null);
        } else {
          setPendingCreateConfirmation(durableAttempt);
        }
        if (definitive && !checkpointCleared) {
          setErr(
            "The server did not apply the design request, but its local checkpoint could not be cleared. Restore local storage before starting another direction.",
          );
          return;
        }
        setErr(describeTemplateGenError(result.error));
        return;
      }
      const checkpointCleared = await clearCampaignTemplateDesignCreateAttempt(
        resumeScope,
        idempotencyKey,
      );
      createAttemptRef.current = checkpointCleared ? null : durableAttempt;
      setPendingCreateConfirmation(null);
      applyDesign(result.data);
      if (!checkpointCleared) {
        setErr(
          "The design exists on the server, but its old create checkpoint could not be cleared from this device. Keep this server design until local storage is available again.",
        );
      }
    } catch {
      if (seq === requestSeq.current) {
        if (createAttemptRef.current) {
          setPendingCreateConfirmation(createAttemptRef.current);
        }
        setErr(
          "The server did not acknowledge the design request. Check the connection before retrying so an ambiguous job is not duplicated.",
        );
      }
    } finally {
      createDispatchInFlight.current = false;
      if (seq === requestSeq.current) setMutation(null);
    }
  };

  const refineDesign = async (): Promise<void> => {
    if (
      !design ||
      !selectedRevision ||
      !refinement.trim() ||
      generating ||
      saving ||
      !design.capabilities.can_refine ||
      selectedRevision.revision !== design.current_revision
    ) {
      return;
    }
    const seq = ++requestSeq.current;
    setMutation("refine");
    setErr(null);
    try {
      const input = {
        instructions: refinement.trim(),
        base_revision: selectedRevision.revision,
      };
      const pending = await checkpointMutation("refine", {
        design_id: design.id,
        ...input,
      });
      if (!pending) return;
      const result = await campaignTemplateDesignsApi.refine(design.id, input, {
        idempotencyKey: pending.key,
      });
      if (seq !== requestSeq.current) return;
      if (result.error) {
        if (!(await retireDefinitiveMutationFailure(pending, result))) {
          return;
        }
        const conflict = conflictMessage(result.error.code);
        if (conflict) {
          await refreshCurrentDesign(conflict);
        } else {
          setErr(
            `The next version could not be queued: ${result.error.message}`,
          );
        }
        return;
      }
      await acknowledgeMutation(pending);
      setRefinement("");
      applyDesign(result.data, {
        selectLatest: !isCampaignTemplateDesignActive(result.data.status),
      });
    } catch {
      if (seq === requestSeq.current) {
        setErr(
          "The refinement request did not complete. The current immutable version is unchanged; refresh before retrying.",
        );
      }
    } finally {
      if (seq === requestSeq.current) setMutation(null);
    }
  };

  const retryDesign = async (): Promise<void> => {
    if (
      !design ||
      !design.capabilities.can_retry ||
      mutation !== null ||
      saving
    ) {
      return;
    }
    const seq = ++requestSeq.current;
    setMutation("retry");
    setErr(null);
    try {
      const pending = await checkpointMutation("retry", {
        design_id: design.id,
        attempt_count: design.attempt_count,
      });
      if (!pending) return;
      const result = await campaignTemplateDesignsApi.retry(design.id, {
        idempotencyKey: pending.key,
      });
      if (seq !== requestSeq.current) return;
      if (result.error) {
        if (!(await retireDefinitiveMutationFailure(pending, result))) {
          return;
        }
        setErr(`The failed job could not be retried: ${result.error.message}`);
        return;
      }
      await acknowledgeMutation(pending);
      applyDesign(result.data, {
        selectLatest: !isCampaignTemplateDesignActive(result.data.status),
      });
    } catch {
      if (seq === requestSeq.current) {
        setErr(
          "The retry request did not complete. Keep this window open and refresh the server design before trying again.",
        );
      }
    } finally {
      if (seq === requestSeq.current) setMutation(null);
    }
  };

  const selectVersion = (index: number): void => {
    if (generating || saving) return;
    const selected = revisions[index];
    if (!selected) return;
    setRevisionForReview(selected);
    setErr(null);
  };

  const openSavedTemplate = async (): Promise<void> => {
    if (!design?.saved_template_id || saving) return;
    if (savedTemplateResult?.id === design.saved_template_id) {
      const saved = savedTemplateResult;
      const preserveForCampaign = !design.created_campaign_id;
      if (preserveForCampaign && !persistResumePointer(design)) {
        setErr(
          "Moosewave could not save the return path for creating a campaign. Keep this window open and retry resume storage before opening the template.",
        );
        return;
      }
      reset({ preserveResume: preserveForCampaign });
      onSaved(saved);
      return;
    }
    const seq = ++requestSeq.current;
    setSaving(true);
    setFinishMode("template");
    setErr(null);
    try {
      const result = await api.getCampaignTemplate(design.saved_template_id);
      if (seq !== requestSeq.current) return;
      if (result.error) {
        setErr(
          `The saved template could not be opened: ${result.error.message}`,
        );
        return;
      }
      const savedTemplate = decodeCampaignTemplate(result.data);
      if (!savedTemplate) {
        setErr(
          "The saved template response could not be verified. Refresh My templates before trying again.",
        );
        return;
      }
      const preserveForCampaign = !design.created_campaign_id;
      if (preserveForCampaign && !persistResumePointer(design)) {
        setErr(
          "Moosewave could not save the return path for creating a campaign. Keep this window open and retry resume storage before opening the template.",
        );
        return;
      }
      reset({ preserveResume: preserveForCampaign });
      onSaved(savedTemplate);
    } catch {
      if (seq === requestSeq.current) {
        setErr(
          "The saved template could not be opened. It remains available in My templates.",
        );
      }
    } finally {
      if (seq === requestSeq.current) {
        setSaving(false);
        setFinishMode(null);
      }
    }
  };

  const finish = async (mode: Exclude<FinishMode, null>): Promise<void> => {
    if (
      !design ||
      !draft ||
      !selectedRevision ||
      finishInFlight.current ||
      selectedRevision.revision !== design.current_revision
    ) {
      return;
    }
    const validation = reviewedDraftError(draft, draftName);
    if (validation) {
      setErr(validation);
      return;
    }
    if (
      (mode === "template" && !design.capabilities.can_save) ||
      (mode === "campaign" && !design.capabilities.can_create_campaign)
    ) {
      setErr(
        "The server capability changed. Refresh this design before finishing.",
      );
      return;
    }
    const reviewedDraft = draft;
    const reviewedName = draftName.trim();
    const revision = selectedRevision;
    const seq = ++requestSeq.current;
    finishInFlight.current = true;
    setSaving(true);
    setFinishMode(mode);
    setErr(null);
    try {
      if (mode === "template") {
        const input = {
          revision: revision.revision,
          output_hash: revision.output_hash,
          slug: aiTemplateSlug(reviewedName, design.id.slice(0, 8)),
          name: reviewedName,
          subject: reviewedDraft.subject,
          preview_text: reviewedDraft.preview_text ?? "",
        };
        const pending = await checkpointMutation("save", {
          design_id: design.id,
          ...input,
        });
        if (!pending) return;
        const result = await campaignTemplateDesignsApi.save<CampaignTemplate>(
          design.id,
          input,
          { idempotencyKey: pending.key },
        );
        if (seq !== requestSeq.current) return;
        if (result.error) {
          if (!(await retireDefinitiveMutationFailure(pending, result))) {
            return;
          }
          const conflict = conflictMessage(result.error.code);
          if (conflict) await refreshCurrentDesign(conflict);
          else setErr(`Couldn't save the template: ${result.error.message}`);
          return;
        }
        const created = decodeCampaignTemplate(result.data);
        if (!created) {
          setErr(
            "The save response could not be verified. Refresh My templates before retrying so the exact commit is not duplicated.",
          );
          return;
        }
        await acknowledgeMutation(pending);
        const committedDesign: CampaignTemplateDesignDraft = {
          ...design,
          status: "saved",
          saved_template_id: created.id,
          saved_revision: revision.revision,
          capabilities: {
            ...design.capabilities,
            can_save: false,
          },
          recommended_action: "use_saved_campaign_template",
        };
        setSavedTemplateResult(created);
        applyDesign(committedDesign, { selectLatest: false });
        toast.success(
          `Template "${created.name}" saved · you can still create a campaign from this exact version`,
        );
        return;
      }
      const input = {
        revision: revision.revision,
        output_hash: revision.output_hash,
        name: reviewedName,
        subject: reviewedDraft.subject,
        preview_text: reviewedDraft.preview_text ?? "",
        variables: generatedVariableValues(reviewedDraft),
      };
      const pending = await checkpointMutation("create-campaign", {
        design_id: design.id,
        ...input,
      });
      if (!pending) return;
      const result = await campaignTemplateDesignsApi.createCampaign<Campaign>(
        design.id,
        input,
        { idempotencyKey: pending.key },
      );
      if (seq !== requestSeq.current) return;
      if (result.error) {
        if (!(await retireDefinitiveMutationFailure(pending, result))) {
          return;
        }
        const conflict = conflictMessage(result.error.code);
        if (conflict) await refreshCurrentDesign(conflict);
        else if (result.error.code === "design_campaign_already_created") {
          await refreshCurrentDesign(
            "A campaign already exists for this design. Open Campaigns to continue without creating a duplicate.",
          );
          setCampaignAlreadyExists(true);
        } else {
          setErr(`The campaign draft wasn't created: ${result.error.message}`);
        }
        return;
      }
      const campaign = campaignSummary(result.data);
      if (!campaign) {
        setErr(
          "Campaign creation could not be verified. Check Campaigns before retrying; the server preserves design lineage against duplicates.",
        );
        return;
      }
      await acknowledgeMutation(pending);
      const committedDesign: CampaignTemplateDesignDraft = {
        ...design,
        status: "campaign_created",
        created_campaign_id: String(campaign.id),
        campaign_revision: revision.revision,
        capabilities: {
          ...design.capabilities,
          can_create_campaign: false,
        },
        recommended_action: "open_campaign_draft",
      };
      setCreatedCampaignResult(campaign);
      setCampaignAlreadyExists(true);
      applyDesign(committedDesign, { selectLatest: false });
      toast.success(
        `Draft campaign created from version ${revision.revision} · you can still save this exact version as a template`,
      );
    } catch {
      if (seq === requestSeq.current) {
        setErr(
          "The finish request did not complete. Keep this window open and refresh the server design before retrying.",
        );
      }
    } finally {
      if (seq === requestSeq.current) {
        finishInFlight.current = false;
        setSaving(false);
        setFinishMode(null);
      }
    }
  };

  const openCampaigns = (): void => {
    const preserveForTemplate = Boolean(
      design &&
      (design.created_campaign_id || campaignAlreadyExists) &&
      !design.saved_template_id,
    );
    const resumableDesign = preserveForTemplate ? design : null;
    const created = createdCampaignResult;
    if (resumableDesign && !persistResumePointer(resumableDesign)) {
      setErr(
        "Moosewave could not save the return path for saving this design as a template. Keep this window open and retry resume storage before opening Campaigns.",
      );
      return;
    }
    reset({ preserveResume: Boolean(resumableDesign) });
    if (created) onCampaignCreated(created);
    else onOpenCampaigns();
  };
  const retryResumePersistence = (): void => {
    if (!design) return;
    if (persistResumePointer(design)) {
      toast.success("Automatic design resume is available on this device.");
    }
  };
  const stage: TemplateWizardStage = generating
    ? "generating"
    : draft
      ? "review"
      : "direction";
  const version = Math.max(1, design?.current_revision ?? 0);
  const previousVersions = useMemo(
    () => revisions.map(retainedVersion),
    [revisions],
  );
  const source = activeSource ?? adaptSource;
  const closeBlocked = saving || mutation === "create";

  return (
    <>
      <Modal
        open={open}
        onClose={requestClose}
        title={source ? "Make it mine" : "Generate with AI"}
        description={
          source
            ? `Create an editable version inspired by ${source.name}.`
            : "Guide an original email template, then review its immutable server revisions before committing anything."
        }
        size="lg"
        closeOnBackdrop={!closeBlocked}
        closeOnEscape={!closeBlocked}
        closeDisabled={closeBlocked}
      >
        <TemplateWizardProgress stage={stage} version={version} />
        {design && resumePersistenceFailed ? (
          <div className="notice" role="alert">
            <div>
              <strong>Automatic resume is not saved on this device</strong>
              <p style={{ margin: "4px 0 8px" }}>
                Design <code>{design.id}</code> exists on the server, but
                closing now may make it harder to reopen automatically.
              </p>
              <button
                type="button"
                className="btn btn-sm"
                onClick={retryResumePersistence}
              >
                Retry saving resume
              </button>
            </div>
          </div>
        ) : null}
        {!design &&
        serverRecoveryLoading &&
        serverRecoveryCandidates.length === 0 ? (
          <div className="notice" role="status" aria-live="polite">
            <div>
              <strong>Checking for unfinished server designs…</strong>
              <p className="muted" style={{ margin: "4px 0 0" }}>
                Recovery is scoped to this exact workspace and user.
              </p>
            </div>
          </div>
        ) : null}
        {!design && serverRecoveryCandidates.length > 0 ? (
          <div
            className="notice"
            role="region"
            aria-labelledby="tpl-ai-server-recovery-heading"
            aria-busy={serverRecoveryLoading}
          >
            <div style={{ width: "100%" }}>
              <strong id="tpl-ai-server-recovery-heading">
                {serverRecoveryCandidates.length === 1
                  ? "A saved design is ready to reopen"
                  : `${serverRecoveryCandidates.length} saved designs are ready to reopen`}
              </strong>
              <p style={{ margin: "4px 0 8px" }}>
                These sessions came from the server for this exact workspace and
                user. Reopen one, or continue with a new direction.
              </p>
              <div
                id="tpl-ai-server-recovery-list"
                style={{
                  display: "grid",
                  gap: 8,
                  maxHeight: 264,
                  overflowY: "auto",
                }}
              >
                {serverRecoveryCandidates.map((candidate) => (
                  <button
                    key={candidate.id}
                    type="button"
                    className="btn btn-sm"
                    style={{
                      justifyContent: "space-between",
                      minHeight: 44,
                      textAlign: "left",
                      whiteSpace: "normal",
                    }}
                    aria-label={`Reopen ${candidate.mode === "adapt" ? "adapted" : "generated"} design ${candidate.id}, ${candidate.status.replaceAll("_", " ")}, version ${Math.max(1, candidate.current_revision)}, updated ${candidate.updated_at}`}
                    disabled={resuming || saving || mutation !== null}
                    onClick={() => void reopenServerDesign(candidate.id)}
                  >
                    <span style={{ display: "grid", gap: 2 }}>
                      <span>
                        {candidate.mode === "adapt" ? "Adapted" : "Generated"} ·{" "}
                        {candidate.status.replaceAll("_", " ")}
                      </span>
                      <span className="muted" style={{ fontSize: 11 }}>
                        Updated{" "}
                        <time dateTime={candidate.updated_at}>
                          {new Date(candidate.updated_at).toLocaleString()}
                        </time>{" "}
                        · {candidate.id.slice(0, 8)}
                      </span>
                    </span>
                    <span className="muted">
                      v{Math.max(1, candidate.current_revision)}
                    </span>
                  </button>
                ))}
              </div>
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: 8,
                  marginTop: 8,
                }}
              >
                {serverRecoveryCursor ? (
                  <button
                    type="button"
                    className="btn btn-sm"
                    style={{ minHeight: 44 }}
                    aria-controls="tpl-ai-server-recovery-list"
                    disabled={serverRecoveryLoading}
                    onClick={() => void loadOlderServerDesigns()}
                  >
                    {serverRecoveryLoading
                      ? "Loading older designs…"
                      : "Load older designs"}
                  </button>
                ) : null}
                <button
                  type="button"
                  className="btn btn-sm"
                  style={{ minHeight: 44 }}
                  disabled={resuming}
                  onClick={() => {
                    serverRecoveryRequestSeq.current += 1;
                    setServerRecoveryCandidates([]);
                    setServerRecoveryCursor(null);
                    setServerRecoveryLoading(false);
                  }}
                >
                  Continue with a new direction
                </button>
              </div>
            </div>
          </div>
        ) : null}
        {!design && pendingCreateConfirmation ? (
          <div className="notice" role="alert">
            <div>
              <strong>Unfinished design request found</strong>
              <p style={{ margin: "4px 0 8px" }}>
                Moosewave paused this exact request instead of replaying it in
                the background. Resume it with the same request key, or discard
                the checkpoint before starting another direction.
              </p>
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: 8,
                }}
              >
                <button
                  type="button"
                  className="btn btn-sm"
                  style={{ minHeight: 44 }}
                  disabled={generating || saving}
                  onClick={() => void resumePendingCreate()}
                >
                  Resume exact request
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  style={{ minHeight: 44 }}
                  disabled={generating || saving}
                  onClick={() => void discardPendingCreate()}
                >
                  Discard checkpoint
                </button>
              </div>
            </div>
          </div>
        ) : null}
        {generating ? (
          <div className="notice" role="status" aria-live="polite">
            <div>
              <strong>
                {resuming
                  ? "Resuming your design…"
                  : mutation === "create"
                    ? "Starting a durable design…"
                    : mutation === "refine"
                      ? "Queueing the refinement…"
                      : mutation === "retry"
                        ? "Retrying the design job…"
                        : "Creating on the server…"}
              </strong>
              <p className="muted" style={{ margin: "4px 0 0" }}>
                {design
                  ? resumePersistenceFailed
                    ? "The server job continues, but automatic reopening is unavailable until the resume pointer is saved."
                    : "You can close this window. The job continues on the server and will resume here next time."
                  : "Keep this window open until the server returns a resumable design ID."}
              </p>
            </div>
          </div>
        ) : null}
        {design?.status === "failed" ? (
          <div className="notice" role="alert">
            <div>
              <strong>That attempt did not finish</strong>
              <p style={{ margin: "4px 0 8px" }}>
                {design.last_error_message ||
                  "The server retained the direction and failure state."}
              </p>
              <button
                type="button"
                className="btn btn-sm"
                disabled={!design.capabilities.can_retry || mutation !== null}
                onClick={() => void retryDesign()}
              >
                Retry failed job
              </button>
            </div>
          </div>
        ) : null}
        {draft === null ? (
          <TemplateBriefStep
            adaptSource={source}
            audience={audience}
            brief={brief}
            brandChoice={brandChoice}
            brandError={brandError}
            brandLoading={brandLoading}
            brandProfile={brandProfile}
            closeDisabled={closeBlocked}
            cta={cta}
            error={err}
            fidelity={fidelity}
            generating={generating || design !== null}
            keySections={keySections}
            kind={kind}
            tone={tone}
            onAudienceChange={setAudience}
            onBrandChoiceChange={setBrandChoice}
            onBriefChange={setBrief}
            onClose={requestClose}
            onCtaChange={setCta}
            onFidelityChange={setFidelity}
            onGenerate={() => void startDesign()}
            onKeySectionsChange={setKeySections}
            onKindChange={setKind}
            onToneChange={setTone}
          />
        ) : selectedRevision ? (
          <TemplateReviewStep
            adaptSource={source}
            campaignRetryUnsafe={campaignAlreadyExists}
            canCreateCampaign={
              design?.capabilities.can_create_campaign === true
            }
            canRefine={design?.capabilities.can_refine === true}
            canSave={design?.capabilities.can_save === true}
            currentRevision={design?.current_revision ?? 0}
            dark={dark}
            device={device}
            draft={draft}
            draftName={draftName}
            error={err}
            finishMode={finishMode}
            generating={generating}
            previousVersions={previousVersions}
            refinement={refinement}
            savedTemplateName={
              design?.saved_template_id
                ? (savedTemplateResult?.name ?? "Saved template")
                : null
            }
            saving={saving}
            serverValidation={selectedRevision.validation}
            serverWarnings={selectedRevision.warnings}
            viewedRevision={selectedRevision.revision}
            onClose={() => {
              if (design?.saved_template_id || design?.created_campaign_id) {
                requestClose();
              } else {
                setDiscardConfirmOpen(true);
              }
            }}
            onDarkChange={setDark}
            onDeviceChange={setDevice}
            onNameChange={(name) => {
              setDraftName(name);
              setErr(null);
            }}
            onOpenCampaigns={openCampaigns}
            onPreviewTextChange={(previewText) =>
              setDraft((current) =>
                current ? { ...current, preview_text: previewText } : current,
              )
            }
            onRefinementChange={setRefinement}
            onRestoreVersion={selectVersion}
            onSave={() => {
              if (design?.saved_template_id) void openSavedTemplate();
              else void finish("template");
            }}
            onStartOver={() => setStartOverConfirmOpen(true)}
            onSubjectChange={(subject) =>
              setDraft((current) =>
                current ? { ...current, subject } : current,
              )
            }
            onTryAnother={() => void refineDesign()}
            onUseInCampaign={() => void finish("campaign")}
          />
        ) : null}
      </Modal>
      <ConfirmModal
        open={discardConfirmOpen}
        title={
          design ? "Archive this template design?" : "Discard this direction?"
        }
        description={
          design
            ? "This archives the durable design job and its review session. Immutable revision records remain available to workspace audit systems, but this wizard will no longer resume it."
            : "This direction has not reached the server and will be discarded."
        }
        confirmLabel={design ? "Archive design" : "Discard direction"}
        danger
        onConfirm={() => {
          if (design) void archiveDesign(true);
          else {
            reset();
            onClose();
          }
        }}
        onClose={() => setDiscardConfirmOpen(false)}
      />
      <ConfirmModal
        open={startOverConfirmOpen}
        title="Change the creative direction?"
        description="The current durable design will be archived before you start again. Its immutable revision audit remains on the server."
        confirmLabel="Archive and start over"
        danger
        onConfirm={() => void archiveDesign(false)}
        onClose={() => setStartOverConfirmOpen(false)}
      />
    </>
  );
}
