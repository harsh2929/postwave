/**
 * TemplateDetailSlideover — right-edge panel showing a single
 * `CampaignTemplate` with editable fields + a real rendered
 * preview.
 *
 * v2 (audit-driven rewrite):
 *
 *   - Preview / Edit tab strip. Preview is the default landing tab
 *     since most "I want to use this template" intent is visual.
 *   - Real iframe preview via TemplatePreview, with desktop/mobile +
 *     light/dark toggles. Replaces the v1 raw-HTML-textarea-only flow.
 *   - Variables editor: surfaces the `variables` jsonb column that
 *     v1 had no UI for. Add / remove / rename / re-label / set
 *     fallback default per entry. Preview pane interpolates the
 *     `default` values into {{var}} placeholders so the operator
 *     sees real content, not raw syntax.
 *   - Clone button calls /api/v1/campaign-templates/{id}/clone for
 *     a server-side duplicate (preserves variables + body + SEO).
 *   - Favorite star toggles the per-user starring; the page header
 *     reconciles the parent list state via onFavoriteChanged.
 *   - "Use in campaign" now fires the /use endpoint before the
 *     handoff so the dashboard's usage analytics reflect intent.
 *
 * The slide-over re-fetches the template by id on mount so it
 * always shows fresh server state, then keeps a local working copy.
 */

import {
  type ReactElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  type ApiErr,
  type CampaignTemplate,
  type CampaignTemplateRevision,
  type CampaignTemplateRevisionPage,
  type TemplateGoal,
  type TemplateRegion,
  api,
  apiSendTimeAssets,
} from "../lib/api-client";
import { queueReceiptMessage } from "../lib/api/result";
import {
  lifecycleOperationError,
  useSingleFlightOperation,
} from "../hooks/useSettingsDraftLifecycle";
import { useSlideoverBehavior } from "../hooks/useSlideoverBehavior";
import { useTabsInteraction } from "../hooks/useTabsInteraction";
import { setSection, useCanWrite } from "../lib/store";
import { registerLifecycleGuard } from "../lib/lifecycle-coordinator";
import {
  TemplatePreview,
  TemplatePreviewToolbar,
  type PreviewDevice,
} from "./TemplatePreview";
import { toast } from "./Toast";
import { PendingSyncStatus } from "./PendingSyncStatus";
import { ConfirmModal } from "./ConfirmModal";
import {
  decodeCampaignTemplate,
  decodeCampaignTemplateRevision,
  decodeCampaignTemplateRevisionPage,
  decodeTemplateRegions,
} from "./templates/template-runtime";
import { campaignTemplatePreviewUrl } from "../lib/campaign-template-previews";
import "../styles-action-availability.css";
import "../styles-template-detail-maturity.css";

interface Props {
  template: CampaignTemplate;
  onClose: () => void;
  onUpdated: (t: CampaignTemplate) => void;
  onDeleted: (id: string) => void;
  /** Reconcile and select the exact clone confirmed by the server. */
  onDuplicate: (t: CampaignTemplate) => void;
  onAdapt?: (t: CampaignTemplate) => void;
  /**
   * Notified after a successful favorite/unfavorite. The parent uses
   * this to reconcile the list state without a full reload.
   */
  onFavoriteChanged?: (t: CampaignTemplate) => void;
}

const MONO: React.CSSProperties = {
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
};

type Tab = "preview" | "edit" | "regions" | "history";
const TEMPLATE_DETAIL_TABS: readonly { value: Tab; label: string }[] = [
  { value: "preview", label: "Preview" },
  { value: "edit", label: "Edit" },
  { value: "regions", label: "Regions" },
  { value: "history", label: "History" },
];

const GOAL_LABELS: Record<TemplateGoal, string> = {
  welcome: "Welcome",
  newsletter: "Newsletter",
  announcement: "Announcement",
  promotional: "Promotional",
  re_engagement: "Re-engagement",
  transactional: "Transactional",
  automation: "Automation",
};

const GOAL_ORDER: TemplateGoal[] = [
  "welcome",
  "newsletter",
  "announcement",
  "promotional",
  "re_engagement",
  "transactional",
  "automation",
];

const TEMPLATE_NAME_MAX_BYTES = 200;
const TEMPLATE_VARIABLE_MAX = 100;
const TEMPLATE_VARIABLE_LABEL_MAX = 200;
const TEMPLATE_VARIABLE_DEFAULT_MAX = 4096;

/**
 * Variable shape we care about for the editor UI. The backend stores
 * arbitrary `Array<Record<string, unknown>>` — we extract the three
 * fields we care about + treat the rest as opaque pass-through.
 */
interface VariableEntry {
  name: string;
  label: string;
  default: string;
}

function readVariables(t: CampaignTemplate): VariableEntry[] {
  const raw = Array.isArray(t.variables) ? t.variables : [];
  return raw.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    return [
      {
        name: String(value["name"] ?? ""),
        label: String(value["label"] ?? ""),
        default: String(value["default"] ?? ""),
      },
    ];
  });
}

function writeVariables(vars: VariableEntry[]): Array<Record<string, unknown>> {
  return vars.map((v) => ({
    name: v.name,
    label: v.label,
    default: v.default,
  }));
}

type DetailLoadState =
  | { status: "loading"; templateId: string }
  | { status: "error"; templateId: string; message: string }
  | { status: "verified"; templateId: string; verifiedAt: string };

type SaveTruth =
  | { status: "server"; acknowledgedAt: string }
  | { status: "queued"; message: string };

type SerializedMutation = <T>(operation: () => Promise<T>) => Promise<T>;

const TEMPLATE_DETAIL_OPERATION = {
  ownerId: "template-detail-mutation",
  label: "Template operation",
  detail: "Wait for the template request to finish before leaving.",
} as const;

function sameVariables(a: VariableEntry[], b: VariableEntry[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function hasOwn<T extends object>(value: T, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function responseRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isTemplatePreconditionFailure(error: ApiErr["error"]): boolean {
  return (
    error.status === 412 ||
    error.status === 428 ||
    error.code === "precondition_failed" ||
    error.code === "precondition_required" ||
    error.code === "campaign_template_etag_required"
  );
}

const TEMPLATE_STALE_GUIDANCE =
  "This template changed after it was opened. Reload the complete server record, review the newer version, then try again.";

function decodeCampaignDraftSummary(
  value: unknown,
): { id: string; name: string } | null {
  const campaign = responseRecord(value);
  return campaign &&
    typeof campaign.id === "string" &&
    campaign.id.trim() !== "" &&
    typeof campaign.name === "string" &&
    campaign.name.trim() !== ""
    ? { id: campaign.id, name: campaign.name }
    : null;
}

interface TemplatePrimaryActionsOptions {
  working: CampaignTemplate;
  canMutate: boolean;
  contentDirty: boolean;
  runMutation: SerializedMutation;
  setCloning: (value: boolean) => void;
  setDeleting: (value: boolean) => void;
  setWorking: (template: CampaignTemplate) => void;
  markLifecycleStale: (message: string) => void;
  onAdapt?: (template: CampaignTemplate) => void;
  onClose: () => void;
  onDeleted: (id: string) => void;
  onDuplicate: (template: CampaignTemplate) => void;
  onFavoriteChanged?: (template: CampaignTemplate) => void;
  verified: boolean;
}

function useTemplatePrimaryActions({
  working,
  canMutate,
  contentDirty,
  runMutation,
  setCloning,
  setDeleting,
  setWorking,
  markLifecycleStale,
  onAdapt,
  onClose,
  onDeleted,
  onDuplicate,
  onFavoriteChanged,
  verified,
}: TemplatePrimaryActionsOptions): {
  onArchive: () => Promise<void>;
  onClone: () => Promise<void>;
  onRestore: () => Promise<void>;
  onToggleFavorite: () => Promise<void>;
  onUseInCampaign: () => Promise<void>;
} {
  const onArchive = async (): Promise<void> => {
    if (!verified || !canMutate || contentDirty) return;
    if (working.capabilities?.can_archive !== true) {
      toast.error(
        working.warnings?.find(
          (warning) => warning.recommended_action !== "campaign_template_adapt",
        )?.message ??
          "The server has not granted archive access to this template.",
      );
      return;
    }
    const target = working;
    await runMutation(async () => {
      setDeleting(true);
      try {
        const res = await api.archiveCampaignTemplate(
          target.id,
          target.etag ?? "",
        );
        if (res.error) {
          if (isTemplatePreconditionFailure(res.error)) {
            markLifecycleStale(TEMPLATE_STALE_GUIDANCE);
            toast.error(TEMPLATE_STALE_GUIDANCE);
          } else {
            toast.error(`Archive failed: ${res.error.message}`);
          }
          return;
        }
        const archived = decodeCampaignTemplate(res.data);
        if (!archived || archived.id !== target.id || !archived.archived_at) {
          toast.error(
            "The archive response could not be verified. Refresh the library before retrying; the template may already be archived.",
          );
          return;
        }
        toast.success(`Archived "${target.name}" · it remains recoverable`);
        onDeleted(target.id);
        onClose();
      } catch (error) {
        toast.error(
          `Archive failed: ${lifecycleOperationError(error, "The archive request failed.")}`,
        );
      } finally {
        setDeleting(false);
      }
    });
  };

  const onRestore = async (): Promise<void> => {
    if (!verified || !canMutate || contentDirty) return;
    if (working.capabilities?.can_restore !== true) {
      toast.error(
        working.warnings?.[0]?.message ??
          "The server has not granted restore access to this template.",
      );
      return;
    }
    const target = working;
    await runMutation(async () => {
      setDeleting(true);
      try {
        const res = await api.restoreCampaignTemplate(
          target.id,
          target.etag ?? "",
        );
        if (res.error) {
          if (isTemplatePreconditionFailure(res.error)) {
            markLifecycleStale(TEMPLATE_STALE_GUIDANCE);
            toast.error(TEMPLATE_STALE_GUIDANCE);
          } else {
            toast.error(`Restore failed: ${res.error.message}`);
          }
          return;
        }
        const restored = decodeCampaignTemplate(res.data);
        if (!restored || restored.id !== target.id || restored.archived_at) {
          toast.error(
            "The restore response could not be verified. Refresh Archived templates before retrying.",
          );
          return;
        }
        toast.success(`Restored "${target.name}" to active templates`);
        onDeleted(target.id);
        onClose();
      } catch (error) {
        toast.error(
          `Restore failed: ${lifecycleOperationError(error, "The restore request failed.")}`,
        );
      } finally {
        setDeleting(false);
      }
    });
  };

  const onUseInCampaign = async (): Promise<void> => {
    if (!verified || !canMutate) return;
    if (contentDirty) {
      toast.info("Save or discard local changes before using this template.");
      return;
    }
    if (working.template_kind === "reference") {
      if (working.capabilities?.can_adapt === true && onAdapt) {
        onAdapt(working);
        onClose();
      } else {
        toast.info(
          working.warnings?.[0]?.message ??
            "The server has not made this inspiration available for adaptation.",
        );
      }
      return;
    }
    if (working.capabilities?.can_create_campaign !== true) {
      toast.info(
        working.warnings?.[0]?.message ??
          "The server has not granted campaign creation for this template.",
      );
      return;
    }
    const target = working;
    try {
      const res = await runMutation(() =>
        api.createCampaignFromTemplate({ template_id: working.id }),
      );
      if (res.error) {
        toast.error(`Campaign draft wasn't created: ${res.error.message}`);
        return;
      }
      const campaign = decodeCampaignDraftSummary(res.data);
      if (!campaign) {
        toast.error(
          "The campaign-create response could not be verified. Check Campaigns before retrying so an ambiguous draft is not duplicated.",
        );
        return;
      }
      toast.success(`Draft "${campaign.name}" created from ${target.name}`);
      setSection("campaigns");
      onClose();
    } catch (error) {
      toast.error(
        lifecycleOperationError(
          error,
          "The campaign draft couldn't be created.",
        ),
      );
    }
  };

  const onClone = async (): Promise<void> => {
    if (!verified || !canMutate || contentDirty) return;
    if (working.capabilities?.can_clone !== true) {
      toast.info(
        working.warnings?.[0]?.message ??
          "The server has not granted clone access to this template.",
      );
      return;
    }
    const target = working;
    await runMutation(async () => {
      setCloning(true);
      try {
        const res = await api.cloneCampaignTemplate(target.id, {
          name: `${target.name} (copy)`,
        });
        if (res.error) {
          toast.error(`Clone failed: ${res.error.message}`);
          return;
        }
        const cloned = decodeCampaignTemplate(res.data);
        if (!cloned || cloned.id === target.id) {
          toast.error(
            "The clone response could not be verified. Refresh the library before retrying so an ambiguous copy is not duplicated.",
          );
          return;
        }
        toast.success(`Cloned to "${cloned.name}"`);
        onDuplicate(cloned);
      } catch (error) {
        toast.error(
          lifecycleOperationError(error, "The template couldn't be cloned."),
        );
      } finally {
        setCloning(false);
      }
    });
  };

  const onToggleFavorite = async (): Promise<void> => {
    if (!verified) return;
    const willFavorite = !working.is_favorited;
    const target = working;
    try {
      const res = await runMutation(() =>
        willFavorite
          ? api.favoriteCampaignTemplate(target.id)
          : api.unfavoriteCampaignTemplate(target.id),
      );
      if (res.error) {
        toast.error(res.error.message);
        return;
      }
      const confirmation = responseRecord(res.data);
      if (
        confirmation?.ok !== true ||
        confirmation.favorited !== willFavorite
      ) {
        toast.error(
          "The favorite response could not be verified. The local state was left unchanged.",
        );
        return;
      }
      const next = { ...target, is_favorited: willFavorite };
      setWorking(next);
      onFavoriteChanged?.(next);
    } catch (error) {
      toast.error(
        lifecycleOperationError(error, "The favorite couldn't be updated."),
      );
    }
  };

  return {
    onArchive,
    onClone,
    onRestore,
    onToggleFavorite,
    onUseInCampaign,
  };
}

type TemplatePatch = Partial<{
  name: string;
  subject: string;
  preview_text: string;
  body_html: string;
  body_mjml: string;
  category: string;
  goal: TemplateGoal | "";
  variables: Array<Record<string, unknown>>;
}>;

function useTemplateDetailController({
  template,
  onClose,
  onUpdated,
  onDeleted,
  onDuplicate,
  onAdapt,
  onFavoriteChanged,
}: Props) {
  const layerRef = useRef<HTMLDivElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const lastDetailFocusRef = useRef<HTMLElement | null>(null);
  const persistedRef = useRef<CampaignTemplate | null>(null);
  const workingRef = useRef<CampaignTemplate>(template);
  const draftRevisionRef = useRef(0);
  const loadSequenceRef = useRef(0);
  const [working, setWorking] = useState<CampaignTemplate>(template);
  const [bodyHtmlDraft, setBodyHtmlDraft] = useState(template.body_html ?? "");
  const [variables, setVariables] = useState<VariableEntry[]>(
    readVariables(template),
  );
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [loadState, setLoadState] = useState<DetailLoadState>({
    status: "loading",
    templateId: template.id,
  });
  const [saveTruth, setSaveTruth] = useState<SaveTruth | null>(null);
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);
  const [closeBlockedMessage, setCloseBlockedMessage] = useState<string | null>(
    null,
  );
  const [savingBody, setSavingBody] = useState(false);
  const [savingVars, setSavingVars] = useState(false);
  const [mjmlOpen, setMjmlOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [cloning, setCloning] = useState(false);
  const [tab, setTab] = useState<Tab>("preview");
  const [device, setDevice] = useState<PreviewDevice>("desktop");
  const [dark, setDark] = useState(false);
  const mutation = useSingleFlightOperation(TEMPLATE_DETAIL_OPERATION);
  const canMutate = useCanWrite();
  workingRef.current = working;

  const verified =
    loadState.status === "verified" && loadState.templateId === template.id;
  const persisted =
    verified && persistedRef.current?.id === template.id
      ? persistedRef.current
      : null;
  const isPlatform = !working.tenant_id || working.tenant_id.length === 0;
  const isReference = working.template_kind === "reference";
  const isArchived = Boolean(working.archived_at);
  const readOnly = working.capabilities?.can_edit_directly !== true;
  const adaptAvailable = typeof onAdapt === "function";
  const templateDirty = Boolean(
    persisted &&
    (working.name !== persisted.name ||
      (working.subject ?? "") !== (persisted.subject ?? "") ||
      (working.preview_text ?? "") !== (persisted.preview_text ?? "") ||
      (working.goal ?? "") !== (persisted.goal ?? "") ||
      bodyHtmlDraft !== (persisted.body_html ?? "") ||
      !sameVariables(variables, readVariables(persisted))),
  );
  const operationActive = mutation.active;
  const queuedUnconfirmed = saveTruth?.status === "queued";

  const editWorking: React.Dispatch<React.SetStateAction<CampaignTemplate>> =
    useCallback((next) => {
      draftRevisionRef.current += 1;
      setWorking(next);
    }, []);
  const editBody = useCallback((next: string) => {
    draftRevisionRef.current += 1;
    setBodyHtmlDraft(next);
  }, []);
  const editVariables: React.Dispatch<React.SetStateAction<VariableEntry[]>> =
    useCallback((next) => {
      draftRevisionRef.current += 1;
      setVariables(next);
    }, []);

  useEffect(() => {
    const sequence = ++loadSequenceRef.current;
    const revisionAtStart = draftRevisionRef.current;
    const expectedId = template.id;
    persistedRef.current = null;
    setLoadState({ status: "loading", templateId: expectedId });
    setSaveTruth(null);
    setDiscardConfirmOpen(false);
    setCloseBlockedMessage(null);
    setConfirmDelete(false);
    setTab("preview");
    void (async () => {
      try {
        const res = await api.getCampaignTemplate(expectedId);
        if (sequence !== loadSequenceRef.current) return;
        if (res.error) {
          setLoadState({
            status: "error",
            templateId: expectedId,
            message: res.error.message,
          });
          return;
        }
        const decoded = decodeCampaignTemplate(res.data);
        if (!decoded || decoded.id !== expectedId) {
          setLoadState({
            status: "error",
            templateId: expectedId,
            message: "The server returned an incomplete template record.",
          });
          return;
        }
        if (draftRevisionRef.current !== revisionAtStart) {
          setLoadState({
            status: "error",
            templateId: expectedId,
            message:
              "Local changes were detected while loading. Retry to verify the template without replacing them.",
          });
          return;
        }
        const acknowledgedAt = new Date().toISOString();
        persistedRef.current = decoded;
        setWorking(decoded);
        setBodyHtmlDraft(decoded.body_html ?? "");
        setVariables(readVariables(decoded));
        setSaveTruth({ status: "server", acknowledgedAt });
        setLoadState({
          status: "verified",
          templateId: expectedId,
          verifiedAt: acknowledgedAt,
        });
      } catch (error) {
        if (sequence !== loadSequenceRef.current) return;
        setLoadState({
          status: "error",
          templateId: expectedId,
          message: lifecycleOperationError(
            error,
            "The complete template couldn't be loaded.",
          ),
        });
      }
    })();
    return () => {
      if (loadSequenceRef.current === sequence) loadSequenceRef.current += 1;
    };
  }, [loadAttempt, template.id]);

  const runMutation = useCallback<SerializedMutation>(
    async <T,>(operation: () => Promise<T>): Promise<T> => {
      for (;;) {
        const request = mutation.run(operation);
        if (request) return await request;
        await mutation.wait().catch(() => undefined);
      }
    },
    [mutation.run, mutation.wait],
  );

  const markLifecycleStale = useCallback(
    (message: string): void => {
      persistedRef.current = null;
      setSaveTruth(null);
      setLoadState({
        status: "error",
        templateId: template.id,
        message,
      });
    },
    [template.id],
  );

  const acknowledgeTemplate = useCallback(
    (
      incoming: CampaignTemplate,
      baseline: CampaignTemplate,
      submitted: TemplatePatch,
    ): void => {
      const acknowledged = {
        ...incoming,
        is_favorited: workingRef.current.is_favorited,
      };
      persistedRef.current = acknowledged;
      setWorking((current) => {
        const expectedName = hasOwn(submitted, "name")
          ? submitted.name
          : baseline.name;
        const expectedSubject = hasOwn(submitted, "subject")
          ? submitted.subject
          : baseline.subject;
        const expectedPreview = hasOwn(submitted, "preview_text")
          ? submitted.preview_text
          : (baseline.preview_text ?? "");
        const expectedGoal = hasOwn(submitted, "goal")
          ? submitted.goal
          : (baseline.goal ?? "");
        return {
          ...acknowledged,
          name:
            current.name === expectedName ? acknowledged.name : current.name,
          subject:
            current.subject === expectedSubject
              ? acknowledged.subject
              : current.subject,
          preview_text:
            (current.preview_text ?? "") === expectedPreview
              ? (acknowledged.preview_text ?? "")
              : current.preview_text,
          goal:
            (current.goal ?? "") === expectedGoal
              ? (acknowledged.goal ?? "")
              : current.goal,
        };
      });
      const expectedBody = hasOwn(submitted, "body_html")
        ? (submitted.body_html ?? "")
        : (baseline.body_html ?? "");
      setBodyHtmlDraft((current) =>
        current === expectedBody ? (acknowledged.body_html ?? "") : current,
      );
      const expectedVariables = hasOwn(submitted, "variables")
        ? readVariables({
            ...baseline,
            variables: submitted.variables ?? [],
          })
        : readVariables(baseline);
      setVariables((current) =>
        sameVariables(current, expectedVariables)
          ? readVariables(acknowledged)
          : current,
      );
      onUpdated(acknowledged);
    },
    [onUpdated],
  );

  const patch = useCallback(
    async (patchBody: TemplatePatch, successMsg?: string): Promise<boolean> => {
      if (!verified) {
        toast.error("Wait for the complete template record before editing.");
        return false;
      }
      if (queuedUnconfirmed) {
        toast.info(
          "Wait for the queued template update to sync, then reopen this detail before editing again.",
        );
        return false;
      }
      if (!canMutate) {
        toast.error("Viewer role can't edit templates.");
        return false;
      }
      if (working.capabilities?.can_edit_directly !== true) {
        toast.error(
          working.warnings?.[0]?.message ??
            "The server has not granted direct edit access to this template.",
        );
        return false;
      }
      try {
        return await runMutation(async () => {
          const baseline = persistedRef.current;
          if (!baseline || baseline.id !== working.id) return false;
          const res = await api.updateCampaignTemplate(
            working.id,
            patchBody,
            { expectedVersion: baseline.etag ?? "" },
          );
          if (res.error) {
            if (isTemplatePreconditionFailure(res.error)) {
              markLifecycleStale(TEMPLATE_STALE_GUIDANCE);
              toast.error(TEMPLATE_STALE_GUIDANCE);
            } else {
              toast.error(`Save failed: ${res.error.message}`);
            }
            return false;
          }
          if (res.queued) {
            const optimistic = {
              ...baseline,
              ...patchBody,
            } as CampaignTemplate;
            acknowledgeTemplate(optimistic, baseline, patchBody);
            const message = queueReceiptMessage(res.receipt);
            setSaveTruth({ status: "queued", message });
            toast.info({
              message,
              detail:
                "This device accepted the change, but the server has not confirmed it yet.",
            });
            return true;
          }
          const acknowledged = decodeCampaignTemplate(res.data);
          if (!acknowledged || acknowledged.id !== baseline.id) {
            persistedRef.current = null;
            setLoadState({
              status: "error",
              templateId: working.id,
              message:
                "The update may have committed, but its response was invalid. Reload the complete server record before editing or retrying.",
            });
            toast.error(
              "The template update could not be verified. No unverified response was applied.",
            );
            return false;
          }
          acknowledgeTemplate(acknowledged, baseline, patchBody);
          setSaveTruth({
            status: "server",
            acknowledgedAt: new Date().toISOString(),
          });
          if (successMsg) toast.success(successMsg);
          return true;
        });
      } catch (error) {
        toast.error(
          `Save failed: ${lifecycleOperationError(error, "The template update request failed.")}`,
        );
        return false;
      }
    },
    [
      acknowledgeTemplate,
      canMutate,
      markLifecycleStale,
      runMutation,
      queuedUnconfirmed,
      verified,
      working.id,
    ],
  );

  const onSubjectBlur = (): void => {
    const baseline = persistedRef.current;
    if (!baseline || working.subject === baseline.subject) return;
    void patch({ subject: working.subject });
  };
  const onPreviewBlur = (): void => {
    const baseline = persistedRef.current;
    if (
      !baseline ||
      (working.preview_text ?? "") === (baseline.preview_text ?? "")
    ) {
      return;
    }
    void patch({ preview_text: working.preview_text ?? "" });
  };
  const onNameBlur = (): void => {
    const baseline = persistedRef.current;
    const next = working.name.trim();
    if (!baseline || next === baseline.name) return;
    if (!next) {
      toast.error("Template name is required. The local draft was not saved.");
      return;
    }
    if (new TextEncoder().encode(next).length > TEMPLATE_NAME_MAX_BYTES) {
      toast.error(
        "Template name is too long once encoded. Shorten it before saving.",
      );
      return;
    }
    if (next !== working.name) {
      editWorking((current) => ({ ...current, name: next }));
    }
    void patch({ name: next });
  };
  const onSaveBody = async (): Promise<void> => {
    setSavingBody(true);
    try {
      await patch({ body_html: bodyHtmlDraft }, "HTML body saved");
    } finally {
      setSavingBody(false);
    }
  };
  const onSaveVariables = async (): Promise<void> => {
    if (variables.length > TEMPLATE_VARIABLE_MAX) {
      toast.error(
        `Templates support at most ${TEMPLATE_VARIABLE_MAX} variables.`,
      );
      return;
    }
    const names = new Set<string>();
    for (const variable of variables) {
      const name = variable.name.trim();
      if (!/^[A-Za-z0-9_]{1,64}$/.test(name)) {
        toast.error(
          "Every variable needs a unique name using letters, numbers, or underscores.",
        );
        return;
      }
      if (names.has(name)) {
        toast.error(`Variable name "${name}" is duplicated.`);
        return;
      }
      names.add(name);
      if (
        variable.label.length > TEMPLATE_VARIABLE_LABEL_MAX ||
        variable.default.length > TEMPLATE_VARIABLE_DEFAULT_MAX
      ) {
        toast.error(
          "A variable label or default value exceeds the supported length.",
        );
        return;
      }
    }
    setSavingVars(true);
    try {
      await patch({ variables: writeVariables(variables) }, "Variables saved");
    } finally {
      setSavingVars(false);
    }
  };
  const onSaveGoal = (goal: TemplateGoal | ""): void => {
    editWorking((current) => ({ ...current, goal }));
    void patch({ goal });
  };

  const discardDraft = useCallback((): void => {
    const saved = persistedRef.current;
    if (!saved) return;
    draftRevisionRef.current += 1;
    setWorking(saved);
    setBodyHtmlDraft(saved.body_html ?? "");
    setVariables(readVariables(saved));
  }, []);
  const requestClose = useCallback((): void => {
    if (mutation.promiseRef.current) {
      setCloseBlockedMessage(
        "Wait for the current template operation to finish before closing.",
      );
      return;
    }
    if (templateDirty) {
      setDiscardConfirmOpen(true);
      return;
    }
    onClose();
  }, [mutation.promiseRef, onClose, templateDirty]);
  const discardAndClose = useCallback((): void => {
    setDiscardConfirmOpen(false);
    discardDraft();
    onClose();
  }, [discardDraft, onClose]);
  const retryLoad = useCallback((): void => {
    if (!mutation.promiseRef.current) setLoadAttempt((attempt) => attempt + 1);
  }, [mutation.promiseRef]);

  useEffect(() => {
    if (!operationActive) setCloseBlockedMessage(null);
  }, [operationActive]);
  useSlideoverBehavior({
    open: true,
    onClose: requestClose,
    dialogRef,
    isolationRef: layerRef,
    disableEscape: false,
  });
  useEffect(() => {
    if (!verified || (!templateDirty && !operationActive)) return;
    return registerLifecycleGuard({
      id: `template-editor-${working.id}`,
      label: "Template changes",
      inspect: (intent) =>
        intent.disposition === "hide"
          ? null
          : operationActive
            ? {
                level: "blocking",
                detail: "The template operation is still in progress.",
                canDiscard: false,
              }
            : {
                level: "blocking",
                detail: "The template has unsaved local changes.",
              },
      discard: () => {
        discardDraft();
        onClose();
      },
    });
  }, [
    discardDraft,
    onClose,
    operationActive,
    templateDirty,
    verified,
    working.id,
  ]);

  const setFavoriteWorking = useCallback((next: CampaignTemplate): void => {
    if (persistedRef.current?.id === next.id) {
      persistedRef.current = {
        ...persistedRef.current,
        is_favorited: next.is_favorited,
      };
    }
    setWorking(next);
  }, []);
  const {
    onArchive,
    onClone,
    onRestore,
    onToggleFavorite,
    onUseInCampaign,
  } =
    useTemplatePrimaryActions({
      working,
      canMutate,
      contentDirty: templateDirty || queuedUnconfirmed,
      runMutation,
      setCloning,
      setDeleting,
      setWorking: setFavoriteWorking,
      markLifecycleStale,
      onAdapt,
      onClose,
      onDeleted,
      onDuplicate,
      onFavoriteChanged,
      verified,
    });

  const previewVars = useMemo<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    for (const variable of variables) {
      if (variable.name) {
        out[variable.name] = variable.default || `{{${variable.name}}}`;
      }
    }
    return out;
  }, [variables]);

  return {
    actions: {
      discardAndClose,
      onArchive,
      onClone,
      onRestore,
      onNameBlur,
      onPreviewBlur,
      onSaveBody,
      onSaveGoal,
      onSaveVariables,
      onSubjectBlur,
      onToggleFavorite,
      onUseInCampaign,
      requestClose,
      retryLoad,
    },
    draft: {
      bodyHtmlDraft,
      dark,
      device,
      mjmlOpen,
      setBodyHtmlDraft: editBody,
      setDark,
      setDevice,
      setMjmlOpen,
      setVariables: editVariables,
      setWorking: editWorking,
      variables,
      working,
    },
    flags: {
      adaptAvailable,
      canMutate,
      confirmDelete,
      discardConfirmOpen,
      isArchived,
      isReference,
      isPlatform,
      queuedUnconfirmed,
      readOnly,
      templateDirty,
      verified,
    },
    loadState,
    operations: {
      cloning,
      deleting,
      operationActive,
      savingBody,
      savingVars,
    },
    preview: { previewBody: bodyHtmlDraft, previewVars },
    refs: { dialogRef, lastDetailFocusRef, layerRef },
    saveTruth,
    shell: {
      closeBlockedMessage,
      setConfirmDelete,
      setDiscardConfirmOpen,
      setTab,
      tab,
    },
  };
}

type TemplateDetailController = ReturnType<typeof useTemplateDetailController>;

export function TemplateDetailSlideover(props: Props): ReactElement {
  const controller = useTemplateDetailController(props);
  return <TemplateDetailSlideoverView controller={controller} />;
}

function TemplateDetailSlideoverView({
  controller,
}: {
  controller: TemplateDetailController;
}): ReactElement {
  const {
    actions,
    draft,
    flags,
    loadState,
    operations,
    preview,
    refs,
    saveTruth,
    shell,
  } = controller;
  const {
    discardAndClose,
    onArchive,
    onClone,
    onRestore,
    onNameBlur,
    onPreviewBlur,
    onSaveBody,
    onSaveGoal,
    onSaveVariables,
    onSubjectBlur,
    onToggleFavorite,
    onUseInCampaign,
    requestClose,
    retryLoad,
  } = actions;
  const {
    bodyHtmlDraft,
    dark,
    device,
    mjmlOpen,
    setBodyHtmlDraft,
    setDark,
    setDevice,
    setMjmlOpen,
    setVariables,
    setWorking,
    variables,
    working,
  } = draft;
  const {
    adaptAvailable,
    canMutate,
    confirmDelete,
    discardConfirmOpen,
    isArchived,
    isReference,
    isPlatform,
    queuedUnconfirmed,
    readOnly,
    templateDirty,
    verified,
  } = flags;
  const { cloning, deleting, operationActive, savingBody, savingVars } =
    operations;
  const { previewBody, previewVars } = preview;
  const { dialogRef, lastDetailFocusRef, layerRef } = refs;
  const {
    closeBlockedMessage,
    setConfirmDelete,
    setDiscardConfirmOpen,
    setTab,
    tab,
  } = shell;
  const activeTab: Tab = isReference ? "preview" : tab;
  const tabItems: readonly {
    value: Tab;
    label: string;
    disabled?: boolean;
  }[] = TEMPLATE_DETAIL_TABS.filter(
    (item) =>
      isReference
        ? item.value === "preview"
        : isArchived
          ? item.value === "preview" || item.value === "history"
          : true,
  ).map((item) =>
    item.value === "regions"
      ? {
          ...item,
          disabled: templateDirty || operationActive || queuedUnconfirmed,
        }
      : item,
  );
  const tabs = useTabsInteraction({
    activation: "manual",
    value: activeTab,
    items: tabItems,
    onChange: setTab,
  });
  const requiredCapability = isReference
    ? working.capabilities?.can_adapt
    : working.capabilities?.can_create_campaign;
  const eligibilityIssue =
    requiredCapability === true
      ? null
      : working.warnings?.[0]?.message ??
        "Action availability could not be verified from the server. Refresh this template before continuing.";
  const contentActionDisabled =
    !verified ||
    !canMutate ||
    templateDirty ||
    queuedUnconfirmed ||
    operationActive ||
    eligibilityIssue !== null ||
    (isReference && !adaptAvailable);
  const cloneDisabled =
    !verified ||
    !canMutate ||
    templateDirty ||
    queuedUnconfirmed ||
    operationActive ||
    working.capabilities?.can_clone !== true;
  const templateActionGuidance = operationActive
    ? "Wait for the current template operation to finish."
    : queuedUnconfirmed
      ? "This device queued an update that the server has not confirmed. Reopen this detail after sync before editing or taking consequential actions."
      : templateDirty
        ? "Preview shows your local draft. Save or discard it before using, duplicating, archiving, or inspecting saved regions."
        : !canMutate
          ? "Viewer role can inspect verified templates and immutable history, but can't edit, archive, restore, or create campaign content."
          : isArchived
            ? "This template is safely archived. Restore it to edit, duplicate, favorite, or create a campaign; its immutable history remains available."
          : eligibilityIssue
            ? eligibilityIssue
            : isReference
              ? adaptAvailable
                ? "Make it mine creates a new editable template while this inspiration and its source details stay unchanged."
                : "Making an editable version isn't available from this screen."
              : isPlatform
                ? "Clone creates an editable workspace copy; the verified platform original stays read-only."
                : "Campaign creation and duplication use the saved server version shown below.";

  return (
    <div
      ref={layerRef}
      className="template-detail-layer"
      onFocusCapture={(event) => {
        const target = event.target;
        if (
          target instanceof HTMLElement &&
          target.closest(".template-detail-panel") != null
        ) {
          lastDetailFocusRef.current = target;
        }
      }}
    >
      <div
        className="slideover-overlay"
        onClick={requestClose}
        aria-hidden="true"
      />
      <div
        ref={dialogRef}
        className="slideover template-detail-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="template-slideover-title"
        aria-busy={!verified || operationActive ? "true" : undefined}
        tabIndex={-1}
      >
        <button
          type="button"
          className="slideover-close"
          onClick={requestClose}
          aria-label="Close template details"
        >
          ×
        </button>

        {!verified ? (
          <TemplateDetailLoadBoundary state={loadState} onRetry={retryLoad} />
        ) : (
          <>
            <div>
              <div
                className="row template-detail-heading"
                style={{ alignItems: "center", gap: 8, marginBottom: 4 }}
              >
                <input
                  id="template-slideover-title"
                  className="input"
                  aria-label="Template name"
                  value={working.name}
                  maxLength={TEMPLATE_NAME_MAX_BYTES}
                  onChange={(event) =>
                    setWorking((current) => ({
                      ...current,
                      name: event.target.value,
                    }))
                  }
                  onBlur={onNameBlur}
                  disabled={readOnly || !canMutate || queuedUnconfirmed}
                  style={{
                    fontSize: 16,
                    fontWeight: 600,
                    border: "none",
                    background: "transparent",
                    padding: 0,
                    height: "auto",
                    flex: 1,
                  }}
                />
                <button
                  type="button"
                  className="tpl-fav"
                  aria-pressed={!!working.is_favorited}
                  aria-label={
                    working.is_favorited
                      ? "Remove from favorites"
                      : "Add to favorites"
                  }
                  disabled={
                    operationActive ||
                    working.capabilities?.can_favorite !== true
                  }
                  aria-disabled={
                    operationActive ||
                    working.capabilities?.can_favorite !== true
                  }
                  onClick={() => void onToggleFavorite()}
                >
                  <FavIcon filled={!!working.is_favorited} />
                </button>
              </div>
              <div
                className="row"
                style={{ marginTop: 4, gap: 6, flexWrap: "wrap" }}
              >
                {isPlatform ? (
                  <span className="badge accent">Moosewave</span>
                ) : null}
                {isReference ? (
                  <span className="badge warning">Inspiration</span>
                ) : null}
                {isArchived ? (
                  <span className="badge warning">Archived · recoverable</span>
                ) : null}
                {working.is_featured ? (
                  <span className="badge accent">Featured</span>
                ) : null}
                {working.goal ? (
                  <span className="goal-pill" data-goal={working.goal}>
                    <span className="goal-pill-dot" aria-hidden="true" />
                    {GOAL_LABELS[working.goal as TemplateGoal] ?? working.goal}
                  </span>
                ) : null}
                {working.category ? (
                  <span className="badge">{working.category}</span>
                ) : null}
                <span className="badge">{kindOf(working)}</span>
                {readOnly ? (
                  <span className="badge warning">read-only</span>
                ) : null}
                {(working.usage_count ?? 0) > 0 ? (
                  <span className="badge tabular">
                    Used {working.usage_count?.toLocaleString()}
                    {working.last_used_at
                      ? ` · last ${new Date(working.last_used_at).toLocaleDateString()}`
                      : ""}
                  </span>
                ) : null}
                <span className="muted tabular template-detail-slug">
                  {working.slug}
                </span>
              </div>
              <PendingSyncStatus
                path={`/api/v1/campaign-templates/${encodeURIComponent(String(working.id))}`}
                compact
              />
            </div>

            <TemplateSaveTruth
              dirty={templateDirty}
              operationActive={operationActive}
              saveTruth={saveTruth}
              verifiedAt={
                loadState.status === "verified"
                  ? loadState.verifiedAt
                  : undefined
              }
            />
            {closeBlockedMessage ? (
              <div
                className="pw-action-status"
                role="status"
                aria-live="polite"
              >
                {closeBlockedMessage}
              </div>
            ) : null}

            <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
              {isArchived ? (
                <button
                  type="button"
                  className="btn btn-sm btn-primary pw-discoverable-unavailable"
                  onClick={() => void onRestore()}
                  disabled={
                    operationActive ||
                    working.capabilities?.can_restore !== true
                  }
                  aria-describedby="template-action-guidance"
                >
                  {deleting ? "Restoring…" : "Restore template"}
                </button>
              ) : null}
              <button
                type="button"
                className="btn btn-sm btn-primary pw-discoverable-unavailable"
                onClick={() => void onUseInCampaign()}
                disabled={contentActionDisabled}
                aria-disabled={contentActionDisabled}
                aria-describedby="template-action-guidance"
              >
                {isReference ? "Make it mine" : "Use in campaign"}
              </button>
              {!isReference ? (
                <button
                  type="button"
                  className="btn btn-sm pw-discoverable-unavailable"
                  onClick={() => void onClone()}
                  disabled={cloneDisabled}
                  aria-disabled={cloneDisabled}
                  aria-describedby="template-action-guidance"
                >
                  {cloning
                    ? "Cloning…"
                    : isPlatform
                      ? "Clone to edit"
                      : "Duplicate"}
                </button>
              ) : null}
              <span className="spacer" />
            </div>
            <div id="template-action-guidance" className="pw-action-status">
              {templateActionGuidance}
            </div>

            <div
              ref={tabs.listRef}
              className="row"
              {...tabs.listProps}
              aria-label="Template view"
              style={{
                gap: 4,
                margin: "12px 0 8px",
                borderBottom: "1px solid var(--pw-border)",
              }}
            >
              {tabItems.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  {...tabs.getTabProps(item.value)}
                  className={`tpl-tab${activeTab === item.value ? " is-active" : ""}`}
                  disabled={item.disabled}
                >
                  {item.label}
                </button>
              ))}
            </div>

            {tabItems
              .filter((item) => item.value !== activeTab)
              .map((item) => (
                <section key={item.value} {...tabs.getPanelProps(item.value)} />
              ))}
            <section {...tabs.getPanelProps(activeTab)}>
              {activeTab === "preview" ? (
                <PreviewPane
                  template={working}
                  html={previewBody}
                  mjml={working.body_mjml}
                  device={device}
                  dark={dark}
                  onDeviceChange={setDevice}
                  onDarkChange={setDark}
                  variables={previewVars}
                />
              ) : activeTab === "regions" ? (
                <RegionsPane
                  templateId={working.id}
                  onEditDefault={() => setTab("edit")}
                />
              ) : activeTab === "history" ? (
                <TemplateRevisionPane template={working} />
              ) : (
                <EditPane
                  working={working}
                  readOnly={readOnly}
                  canMutate={canMutate}
                  bodyHtmlDraft={bodyHtmlDraft}
                  setBodyHtmlDraft={setBodyHtmlDraft}
                  savingBody={savingBody}
                  operationActive={operationActive}
                  queuedUnconfirmed={queuedUnconfirmed}
                  onSaveBody={onSaveBody}
                  onSubjectBlur={onSubjectBlur}
                  onPreviewBlur={onPreviewBlur}
                  setWorking={setWorking}
                  onSaveGoal={onSaveGoal}
                  mjmlOpen={mjmlOpen}
                  setMjmlOpen={setMjmlOpen}
                  variables={variables}
                  setVariables={setVariables}
                  onSaveVariables={onSaveVariables}
                  savingVars={savingVars}
                />
              )}
            </section>

            {working.capabilities?.can_archive === true && canMutate ? (
              <div className="template-detail-danger-zone">
                <div className="label">Lifecycle</div>
                <button
                  type="button"
                  className="btn btn-sm btn-danger"
                  onClick={() => setConfirmDelete(true)}
                  aria-disabled={
                    templateDirty || operationActive || queuedUnconfirmed
                  }
                  disabled={
                    templateDirty || operationActive || queuedUnconfirmed
                  }
                  aria-describedby="template-action-guidance"
                >
                  Archive template
                </button>
                <p className="muted" style={{ margin: "6px 0 0" }}>
                  Archiving is recoverable and preserves campaign lineage and
                  immutable revision history.
                </p>
              </div>
            ) : null}
          </>
        )}
      </div>
      <ConfirmModal
        open={discardConfirmOpen}
        title="Discard template changes and close?"
        description="The local name, subject, preview text, goal, HTML, or variable changes will be lost. The saved server version will not be changed."
        confirmLabel="Discard changes"
        cancelLabel="Keep editing"
        danger
        returnFocusRef={lastDetailFocusRef}
        onConfirm={discardAndClose}
        onClose={() => setDiscardConfirmOpen(false)}
      />
      <ConfirmModal
        open={confirmDelete}
        title="Archive this template?"
        description="The template will leave active views and become read-only, but it remains recoverable in Archived with its campaign lineage and revision history."
        confirmLabel="Archive template"
        cancelLabel="Keep template"
        danger
        busy={deleting}
        returnFocusRef={lastDetailFocusRef}
        onConfirm={onArchive}
        onClose={() => setConfirmDelete(false)}
      />
    </div>
  );
}

function TemplateDetailLoadBoundary({
  state,
  onRetry,
}: {
  state: DetailLoadState;
  onRetry: () => void;
}): ReactElement {
  const failed = state.status === "error";
  return (
    <div className="template-detail-load-boundary">
      <h2 id="template-slideover-title" className="template-detail-load-title">
        {failed ? "Template details unavailable" : "Loading template details"}
      </h2>
      {failed ? (
        <div role="alert" className="notice danger">
          <strong>The complete template could not be verified.</strong>
          <span>{state.message}</span>
        </div>
      ) : (
        <div role="status" aria-live="polite" className="pw-action-status">
          Loading the complete saved record…
        </div>
      )}
      <p className="muted">
        Editing and consequential actions stay locked until the full template
        record has loaded successfully.
      </p>
      {failed ? (
        <button type="button" className="btn btn-primary" onClick={onRetry}>
          Retry loading template
        </button>
      ) : null}
    </div>
  );
}

function TemplateSaveTruth({
  dirty,
  operationActive,
  saveTruth,
  verifiedAt,
}: {
  dirty: boolean;
  operationActive: boolean;
  saveTruth: SaveTruth | null;
  verifiedAt?: string;
}): ReactElement {
  let message = "Saved server version";
  if (operationActive) message = "Saving or applying a template operation…";
  else if (dirty) {
    message =
      "Unsaved local changes · Preview shows the draft; consequential actions use only saved content and are locked.";
  } else if (saveTruth?.status === "queued") {
    message = `${saveTruth.message} · Not yet confirmed by the server.`;
  } else if (saveTruth?.status === "server" || verifiedAt) {
    const acknowledgedAt =
      saveTruth?.status === "server"
        ? saveTruth.acknowledgedAt
        : (verifiedAt ?? "");
    const acknowledgement =
      acknowledgedAt === verifiedAt
        ? "Full record verified"
        : "Changes acknowledged by server";
    message = `Saved server version · ${acknowledgement} ${new Date(
      acknowledgedAt,
    ).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    })}`;
  }
  return (
    <div
      className={`template-detail-truth${dirty ? " is-dirty" : ""}`}
      role="status"
      aria-live="polite"
    >
      {message}
    </div>
  );
}

/* ---------- preview pane --------------------------------------------- */

interface PreviewPaneProps {
  template: CampaignTemplate;
  html: string;
  mjml?: string;
  device: PreviewDevice;
  dark: boolean;
  onDeviceChange: (d: PreviewDevice) => void;
  onDarkChange: (b: boolean) => void;
  variables: Record<string, string>;
}

function PreviewPane({
  template,
  html,
  mjml,
  device,
  dark,
  onDeviceChange,
  onDarkChange,
  variables,
}: PreviewPaneProps): ReactElement {
  const hostedPreview = campaignTemplatePreviewUrl(
    template,
    device === "mobile"
      ? ["mobile", "desktop", "card"]
      : ["desktop", "card", "mobile"],
  );
  const hasStoredMarkup =
    template.template_kind !== "reference" &&
    Boolean(html.trim() || mjml?.trim());
  return (
    <div>
      <TemplatePreviewToolbar
        device={device}
        onDeviceChange={onDeviceChange}
        dark={dark}
        onDarkChange={onDarkChange}
      />
      {hasStoredMarkup ? (
        <TemplatePreview
          html={html}
          mjml={mjml}
          device={device}
          dark={dark}
          variables={variables}
          height={560}
        />
      ) : hostedPreview ? (
        <figure style={{ margin: 0 }}>
          <div
            style={{
              maxWidth: device === "mobile" ? 375 : 760,
              height: 560,
              marginInline: "auto",
              overflow: "auto",
              border: "1px solid var(--pw-border)",
              borderRadius: 8,
              background: "var(--pw-bg-elev-2)",
            }}
          >
            <img
              src={hostedPreview}
              alt={`Hosted ${device} preview of ${template.name}`}
              decoding="async"
              referrerPolicy="no-referrer"
              style={{ display: "block", width: "100%", height: "auto" }}
            />
          </div>
          <figcaption className="muted" style={{ marginTop: 6, fontSize: 11 }}>
            Sanitized Moosewave-hosted capture. The original provider page is
            never loaded. Dark mode does not recolor a stored screenshot.
          </figcaption>
        </figure>
      ) : (
        <div className="empty-state" role="status">
          <h3>Preview unavailable</h3>
          <p>
            No trusted Moosewave-hosted capture or governed template markup is
            available. Third-party source URLs are intentionally blocked.
          </p>
        </div>
      )}
    </div>
  );
}

/* ---------- immutable lifecycle history ----------------------------- */

function transitionLabel(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) =>
    letter.toUpperCase(),
  );
}

function TemplateRevisionPane({
  template,
}: {
  template: CampaignTemplate;
}): ReactElement {
  const [pageNumber, setPageNumber] = useState(1);
  const [page, setPage] = useState<CampaignTemplateRevisionPage | null>(null);
  const [selected, setSelected] =
    useState<CampaignTemplateRevision | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedLoading, setSelectedLoading] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void api
      .listCampaignTemplateRevisions(template.id, {
        page: pageNumber,
        per_page: 20,
      })
      .then((result) => {
        if (cancelled) return;
        if (result.error) {
          setPage(null);
          setError(result.error.message);
          return;
        }
        const decoded = decodeCampaignTemplateRevisionPage(result.data);
        if (!decoded) {
          setPage(null);
          setError(
            "The server returned an invalid revision history. No unverified history was shown.",
          );
          return;
        }
        setPage(decoded);
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setPage(null);
          setError(
            lifecycleOperationError(
              cause,
              "The immutable revision history could not be loaded.",
            ),
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [loadAttempt, pageNumber, template.id, template.version]);

  const inspectRevision = async (version: number): Promise<void> => {
    if (selectedLoading !== null) return;
    setSelectedLoading(version);
    setError(null);
    try {
      const result = await api.getCampaignTemplateRevision(
        template.id,
        version,
      );
      if (result.error) {
        setError(result.error.message);
        return;
      }
      const decoded = decodeCampaignTemplateRevision(result.data);
      if (!decoded || decoded.snapshot.id !== template.id) {
        setError(
          "The selected revision response was invalid. No unverified snapshot was shown.",
        );
        return;
      }
      setSelected(decoded);
    } catch (cause) {
      setError(
        lifecycleOperationError(
          cause,
          "The selected immutable snapshot could not be loaded.",
        ),
      );
    } finally {
      setSelectedLoading(null);
    }
  };

  if (loading && !page) {
    return (
      <div className="muted" role="status">
        Loading immutable revision history…
      </div>
    );
  }
  if (!page) {
    return (
      <div className="notice" role="alert">
        <span>{error ?? "Revision history is unavailable."}</span>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => setLoadAttempt((attempt) => attempt + 1)}
        >
          Retry history
        </button>
      </div>
    );
  }

  const lastPage = Math.max(1, Math.ceil(page.total / page.per_page));
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div className="notice" role="note">
        <div>
          <strong>Read-only, immutable history</strong>
          <p className="muted" style={{ margin: "4px 0 0" }}>
            Every edit, archive, and restore advances the strong version. A
            historical snapshot can be inspected but never overwritten.
          </p>
        </div>
      </div>
      {error ? (
        <div className="field-error" role="alert">
          {error}
        </div>
      ) : null}
      <ol style={{ display: "grid", gap: 8, margin: 0, padding: 0 }}>
        {page.items.map((revision) => (
          <li
            key={`${revision.version}-${revision.etag}`}
            className="card"
            style={{ display: "grid", gap: 5, padding: 10 }}
          >
            <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
              <strong>Version {revision.version}</strong>
              <span className="badge">
                {transitionLabel(revision.transition)}
              </span>
              {revision.archived_at ? (
                <span className="badge warning">Archived state</span>
              ) : null}
              <span className="spacer" />
              <button
                type="button"
                className="btn btn-sm"
                disabled={selectedLoading !== null}
                onClick={() => void inspectRevision(revision.version)}
              >
                {selectedLoading === revision.version
                  ? "Loading…"
                  : "Inspect snapshot"}
              </button>
            </div>
            <span>{revision.name}</span>
            <span className="muted">{revision.subject || "No subject"}</span>
            <time
              className="muted"
              dateTime={revision.snapshot_time}
              style={{ fontSize: 11 }}
            >
              {new Date(revision.snapshot_time).toLocaleString()}
            </time>
          </li>
        ))}
      </ol>
      {page.total === 0 ? (
        <p className="muted">No immutable revisions were returned.</p>
      ) : null}
      {lastPage > 1 ? (
        <div className="row" style={{ justifyContent: "center", gap: 8 }}>
          <button
            type="button"
            className="btn btn-sm"
            disabled={loading || pageNumber <= 1}
            onClick={() => setPageNumber((current) => Math.max(1, current - 1))}
          >
            Previous
          </button>
          <span className="muted">
            Page {pageNumber} of {lastPage}
          </span>
          <button
            type="button"
            className="btn btn-sm"
            disabled={loading || pageNumber >= lastPage}
            onClick={() =>
              setPageNumber((current) => Math.min(lastPage, current + 1))
            }
          >
            Next
          </button>
        </div>
      ) : null}
      {selected ? (
        <section
          className="card"
          aria-labelledby="template-revision-snapshot-heading"
          style={{ padding: 12 }}
        >
          <h3 id="template-revision-snapshot-heading" style={{ fontSize: 13 }}>
            Version {selected.version} snapshot
          </h3>
          <p className="muted">
            {transitionLabel(selected.transition)} ·{" "}
            {new Date(selected.snapshot_time).toLocaleString()}
          </p>
          <dl className="tpl-metadata-list">
            <div>
              <dt>Name</dt>
              <dd>{selected.snapshot.name}</dd>
            </div>
            <div>
              <dt>Subject</dt>
              <dd>{selected.snapshot.subject || "No subject"}</dd>
            </div>
          </dl>
          {selected.snapshot.body_html?.trim() ||
          selected.snapshot.body_mjml?.trim() ? (
            <TemplatePreview
              html={selected.snapshot.body_html ?? ""}
              mjml={selected.snapshot.body_mjml}
              device="desktop"
              dark={false}
              height={360}
            />
          ) : (
            <p className="muted">
              This snapshot contains lifecycle metadata but no governed markup.
            </p>
          )}
        </section>
      ) : null}
    </div>
  );
}

/* ---------- edit pane ------------------------------------------------ */

interface EditPaneProps {
  working: CampaignTemplate;
  readOnly: boolean;
  canMutate: boolean;
  bodyHtmlDraft: string;
  setBodyHtmlDraft: (s: string) => void;
  savingBody: boolean;
  operationActive: boolean;
  queuedUnconfirmed: boolean;
  onSaveBody: () => Promise<void>;
  onSubjectBlur: () => void;
  onPreviewBlur: () => void;
  setWorking: React.Dispatch<React.SetStateAction<CampaignTemplate>>;
  onSaveGoal: (g: TemplateGoal | "") => void;
  mjmlOpen: boolean;
  setMjmlOpen: React.Dispatch<React.SetStateAction<boolean>>;
  variables: VariableEntry[];
  setVariables: React.Dispatch<React.SetStateAction<VariableEntry[]>>;
  onSaveVariables: () => Promise<void>;
  savingVars: boolean;
}

function EditPane({
  working,
  readOnly,
  canMutate,
  bodyHtmlDraft,
  setBodyHtmlDraft,
  savingBody,
  operationActive,
  queuedUnconfirmed,
  onSaveBody,
  onSubjectBlur,
  onPreviewBlur,
  setWorking,
  onSaveGoal,
  mjmlOpen,
  setMjmlOpen,
  variables,
  setVariables,
  onSaveVariables,
  savingVars,
}: EditPaneProps): ReactElement {
  const editDisabled = readOnly || !canMutate || queuedUnconfirmed;
  const bodyUnchanged = bodyHtmlDraft === (working.body_html ?? "");
  const saveBodyReason = savingBody
    ? "Saving the HTML body…"
    : queuedUnconfirmed
      ? "A queued update is still awaiting server confirmation. Reopen this detail after sync before editing again."
      : readOnly
        ? working.template_kind === "reference"
          ? "Inspiration is read-only; choose Make it mine to create an editable version."
          : "Platform templates are read-only; clone one to edit its HTML."
        : !canMutate
          ? "Viewer role can't edit templates."
          : bodyUnchanged
            ? "Change the HTML body to enable saving."
            : null;

  return (
    <div>
      {/* subject */}
      <div className="field">
        <label className="field-label" htmlFor="tpl-subject">
          Subject
        </label>
        <input
          id="tpl-subject"
          className="input"
          value={working.subject ?? ""}
          disabled={editDisabled}
          maxLength={998}
          onChange={(e) =>
            setWorking((w) => ({ ...w, subject: e.target.value }))
          }
          onBlur={onSubjectBlur}
        />
      </div>

      {/* preview text */}
      <div className="field">
        <label className="field-label" htmlFor="tpl-preview">
          Preview text
        </label>
        <input
          id="tpl-preview"
          className="input"
          value={working.preview_text ?? ""}
          disabled={editDisabled}
          maxLength={500}
          placeholder="Shown beside the subject in most inbox clients"
          onChange={(e) =>
            setWorking((w) => ({ ...w, preview_text: e.target.value }))
          }
          onBlur={onPreviewBlur}
        />
      </div>

      {/* goal */}
      {!readOnly ? (
        <div className="field">
          <label className="field-label" htmlFor="tpl-goal">
            Goal
          </label>
          <select
            id="tpl-goal"
            className="input"
            value={working.goal ?? ""}
            disabled={editDisabled}
            onChange={(e) => onSaveGoal(e.target.value as TemplateGoal | "")}
          >
            <option value="">(none)</option>
            {GOAL_ORDER.map((g) => (
              <option key={g} value={g}>
                {GOAL_LABELS[g]}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      {/* HTML body */}
      <div className="field">
        <label className="field-label" htmlFor="tpl-html">
          HTML body
        </label>
        <textarea
          id="tpl-html"
          className="input"
          rows={14}
          value={bodyHtmlDraft}
          disabled={editDisabled}
          maxLength={1_048_576}
          onChange={(e) => setBodyHtmlDraft(e.target.value)}
          aria-describedby="tpl-html-saved-block-hint"
          style={{
            ...MONO,
            height: "auto",
            minHeight: 280,
            padding: 10,
            lineHeight: 1.45,
            resize: "vertical",
          }}
        />
        <div
          id="tpl-html-saved-block-hint"
          className="muted"
          style={{ fontSize: 11, marginTop: 4 }}
        >
          To reuse a saved block, copy its HTML from Saved Blocks, return here,
          and paste it at the cursor. Review the result before saving.
        </div>
        <div
          className="row"
          style={{ justifyContent: "flex-end", marginTop: 8 }}
        >
          <span className="muted" style={{ fontSize: 11 }}>
            {bodyHtmlDraft.length.toLocaleString()} chars
          </span>
          <span className="spacer" />
          {saveBodyReason ? (
            <span id="tpl-save-html-reason" className="pw-action-status">
              {saveBodyReason}
            </span>
          ) : null}
          <button
            type="button"
            className="btn btn-sm btn-primary pw-discoverable-unavailable"
            onClick={() => {
              if (saveBodyReason) return;
              void onSaveBody();
            }}
            disabled={operationActive}
            aria-disabled={Boolean(saveBodyReason)}
            aria-describedby={
              saveBodyReason ? "tpl-save-html-reason" : undefined
            }
          >
            {savingBody ? "Saving…" : "Save HTML"}
          </button>
        </div>
      </div>

      {/* variables editor */}
      <VariablesEditor
        variables={variables}
        setVariables={setVariables}
        disabled={editDisabled}
        onSave={onSaveVariables}
        saving={savingVars}
        dirty={
          JSON.stringify(variables) !== JSON.stringify(readVariables(working))
        }
      />

      {/* MJML */}
      {working.body_mjml && working.body_mjml.length > 0 ? (
        <div style={{ marginTop: 12 }}>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => setMjmlOpen((v) => !v)}
            style={{ paddingLeft: 0 }}
          >
            {mjmlOpen ? "Hide" : "Show"} MJML source
          </button>
          {mjmlOpen ? (
            <pre
              style={{
                ...MONO,
                fontSize: 11,
                padding: 10,
                marginTop: 6,
                background: "var(--pw-bg)",
                border: "1px solid var(--pw-border)",
                borderRadius: 6,
                overflowX: "auto",
                whiteSpace: "pre",
                maxHeight: 240,
                color: "var(--pw-fg-muted)",
              }}
            >
              {working.body_mjml}
            </pre>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/* ---------- variables editor ----------------------------------------- */

interface VariablesEditorProps {
  variables: VariableEntry[];
  setVariables: React.Dispatch<React.SetStateAction<VariableEntry[]>>;
  disabled: boolean;
  onSave: () => Promise<void>;
  saving: boolean;
  dirty: boolean;
}

function VariablesEditor({
  variables,
  setVariables,
  disabled,
  onSave,
  saving,
  dirty,
}: VariablesEditorProps): ReactElement {
  const update = (idx: number, patch: Partial<VariableEntry>): void => {
    setVariables((prev) =>
      prev.map((v, i) => (i === idx ? { ...v, ...patch } : v)),
    );
  };
  const add = (): void => {
    if (variables.length >= TEMPLATE_VARIABLE_MAX) return;
    setVariables((prev) => [...prev, { name: "", label: "", default: "" }]);
  };
  const remove = (idx: number): void => {
    setVariables((prev) => prev.filter((_, i) => i !== idx));
  };

  return (
    <div className="field" style={{ marginTop: 16 }}>
      <div className="row" style={{ alignItems: "center", marginBottom: 6 }}>
        <div className="field-label" style={{ margin: 0 }}>
          Variables
        </div>
        <span className="muted" style={{ fontSize: 11, marginLeft: 8 }}>
          Used as <code className="mono">{`{{name}}`}</code> in the body +
          interpolated in preview.
        </span>
      </div>
      {disabled ? (
        <div id="tpl-variables-readonly" className="pw-action-status">
          Variables are read-only for this template. Clone a platform template
          or request edit access to change them.
        </div>
      ) : null}
      {variables.length === 0 ? (
        <div
          className="muted"
          style={{ fontSize: 12, padding: 12, textAlign: "center" }}
        >
          No variables defined yet. Add one to surface a merge-tag in the
          template.
        </div>
      ) : (
        <div style={{ display: "grid", gap: 6 }}>
          {variables.map((v, idx) => (
            <div
              key={idx}
              className="row tpl-vars-row"
              style={{ gap: 6, alignItems: "center" }}
            >
              <input
                className="input mono"
                placeholder="name"
                aria-label={`Variable ${idx + 1} name`}
                aria-describedby={
                  disabled ? "tpl-variables-readonly" : undefined
                }
                style={{ flex: 1 }}
                value={v.name}
                maxLength={64}
                disabled={disabled}
                onChange={(e) =>
                  update(idx, {
                    name: e.target.value
                      .replace(/[^a-zA-Z0-9_]/g, "_")
                      .slice(0, 64),
                  })
                }
              />
              <input
                className="input"
                placeholder="label"
                aria-label={`Variable ${idx + 1} label`}
                aria-describedby={
                  disabled ? "tpl-variables-readonly" : undefined
                }
                style={{ flex: 1.4 }}
                value={v.label}
                maxLength={TEMPLATE_VARIABLE_LABEL_MAX}
                disabled={disabled}
                onChange={(e) => update(idx, { label: e.target.value })}
              />
              <input
                className="input"
                placeholder="default"
                aria-label={`Variable ${idx + 1} default content`}
                aria-describedby={
                  disabled ? "tpl-variables-readonly" : undefined
                }
                style={{ flex: 1.4 }}
                value={v.default}
                maxLength={TEMPLATE_VARIABLE_DEFAULT_MAX}
                disabled={disabled}
                onChange={(e) => update(idx, { default: e.target.value })}
              />
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => remove(idx)}
                disabled={disabled}
                aria-label={`Remove variable ${v.name || idx + 1}`}
                aria-describedby={
                  disabled ? "tpl-variables-readonly" : undefined
                }
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="row" style={{ marginTop: 8 }}>
        <button
          type="button"
          className="btn btn-sm"
          onClick={add}
          disabled={disabled || variables.length >= TEMPLATE_VARIABLE_MAX}
          aria-describedby={disabled ? "tpl-variables-readonly" : undefined}
        >
          + Add variable
        </button>
        {variables.length >= TEMPLATE_VARIABLE_MAX ? (
          <span className="pw-action-status">
            Maximum {TEMPLATE_VARIABLE_MAX} variables reached.
          </span>
        ) : null}
        <span className="spacer" />
        <button
          type="button"
          className="btn btn-sm btn-primary"
          onClick={() => void onSave()}
          disabled={disabled || saving || !dirty}
          aria-describedby={disabled ? "tpl-variables-readonly" : undefined}
        >
          {saving ? "Saving…" : "Save variables"}
        </button>
      </div>
    </div>
  );
}

/* ---------- icons + helpers ------------------------------------------ */

function FavIcon({ filled }: { filled: boolean }): ReactElement {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
    </svg>
  );
}

/** Pull `kind:<v>` out of tags, or fall back to "regular". */
function kindOf(t: CampaignTemplate): string {
  if (t.kind) return t.kind;
  const tag = (t.tags ?? []).find((x) => x.startsWith("kind:"));
  if (tag) return tag.slice("kind:".length) || "regular";
  return "regular";
}

/* ---------- regions pane (Workstream 4) ------------------------------ */

/**
 * Workstream 4 (Mailchimp parity polish): regions panel.
 *
 * Lists every `{{region:NAME}}…{{/region}}` zone the template declares,
 * with a thumbnail of the default content + an "Edit default" link that
 * jumps back into the body editor. Empty state coaches operators on the
 * region syntax (Mailchimp's "Editable regions" parity).
 */
function RegionsPane({
  templateId,
  onEditDefault,
}: {
  templateId: string;
  onEditDefault: () => void;
}): ReactElement {
  const [regions, setRegions] = useState<TemplateRegion[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setRegions(null);
    setErr(null);
    void (async () => {
      try {
        const res = await apiSendTimeAssets.getTemplateRegions(templateId);
        if (cancelled) return;
        if (res.error) {
          setErr(res.error.message);
          setRegions([]);
          return;
        }
        const decoded = decodeTemplateRegions(res.data);
        if (!decoded) {
          setErr(
            "The server returned an invalid regions response. No unverified region data was shown.",
          );
          setRegions([]);
          return;
        }
        setRegions(decoded);
      } catch (error) {
        if (cancelled) return;
        setErr(
          lifecycleOperationError(
            error,
            "The saved regions couldn't be loaded.",
          ),
        );
        setRegions([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadAttempt, templateId]);

  if (regions === null) {
    return (
      <div className="muted" style={{ fontSize: 12, padding: 12 }}>
        Loading regions…
      </div>
    );
  }
  if (err) {
    return (
      <div className="notice" role="alert">
        <span>Couldn&apos;t parse regions: {err}</span>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => setLoadAttempt((attempt) => attempt + 1)}
        >
          Retry saved regions
        </button>
      </div>
    );
  }
  if (regions.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon" aria-hidden="true">
          ·
        </div>
        <h3>No editable regions</h3>
        <p>
          Wrap each editable block in{" "}
          <code>{"{{region:name}}…{{/region}}"}</code> in the template body to
          surface it here.
        </p>
        <button type="button" className="btn" onClick={onEditDefault}>
          Open editor
        </button>
      </div>
    );
  }
  return (
    <div style={{ display: "grid", gap: 10 }}>
      <div className="muted" style={{ fontSize: 12 }}>
        {regions.length} editable region{regions.length === 1 ? "" : "s"} in the
        saved HTML. Open the HTML editor to review or change their defaults.
      </div>
      {regions.map((r) => (
        <div
          key={`${r.name}-${r.position}`}
          className="card"
          style={{ padding: 10, display: "grid", gap: 6 }}
        >
          <div
            className="row"
            style={{ alignItems: "center", justifyContent: "space-between" }}
          >
            <div className="row" style={{ gap: 6, alignItems: "center" }}>
              <span className="badge accent">{r.name}</span>
              <span className="muted" style={{ fontSize: 11 }}>
                offset {r.position}, span {r.length}
              </span>
            </div>
            <button
              type="button"
              className="btn btn-sm"
              onClick={onEditDefault}
              aria-label={`Open HTML editor for region ${r.name}`}
            >
              Open HTML editor
            </button>
          </div>
          <pre
            className="mono"
            style={{
              margin: 0,
              padding: 8,
              maxHeight: 140,
              overflow: "auto",
              background: "color-mix(in srgb, var(--pw-fg) 4%, transparent)",
              border: "1px solid var(--pw-border)",
              borderRadius: 4,
              fontSize: 11,
              lineHeight: 1.5,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {r.default_html || "(empty default)"}
          </pre>
        </div>
      ))}
    </div>
  );
}
