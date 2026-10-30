import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { type Campaign, type CampaignDetail, api } from "../../lib/api-client";
import type { AudiencePreviewEvidence } from "../AudiencePreviewPanel";
import {
  cancelCampaign,
  pauseCampaign,
  resumeCampaign,
} from "../../lib/sms-a2p-api";
import { track as trackTelemetry } from "../../lib/telemetry";
import { celebrate } from "../Celebrate";
import { toast } from "../Toast";
import { asCampaignString } from "./useCampaignDetailData";
import {
  type CampaignChecklistEvidence,
  useCampaignSendEvidence,
} from "./useCampaignSendEvidence";

export type { CampaignChecklistEvidence } from "./useCampaignSendEvidence";

type SendControlAction = "pause" | "resume" | "cancel";

interface CampaignLifecycleControllerInput {
  id: Campaign["id"];
  detail: CampaignDetail;
  setDetail: Dispatch<SetStateAction<CampaignDetail>>;
  savedFromEmail: string;
  isDraft: boolean;
  canMutate: boolean;
  canAdmin: boolean;
  authoringLocked: boolean;
  setBusy: Dispatch<SetStateAction<boolean>>;
  onChange?: (updated: CampaignDetail | null) => void;
  onClose: () => void;
  /** Fail-closed preparation that must finish before dispatch is requested. */
  beforeSend?: (() => Promise<void>) | undefined;
}

export interface CampaignLifecycleController {
  confirmSendOpen: boolean;
  setConfirmSendOpen: Dispatch<SetStateAction<boolean>>;
  checklistEvidence: CampaignChecklistEvidence;
  retryChecklist: () => void;
  audiencePreviewEvidence: AudiencePreviewEvidence;
  setAudiencePreviewEvidence: (evidence: AudiencePreviewEvidence) => void;
  checklistFailureOverride: boolean;
  setChecklistFailureOverride: Dispatch<SetStateAction<boolean>>;
  confirmDeleteOpen: boolean;
  setConfirmDeleteOpen: Dispatch<SetStateAction<boolean>>;
  confirmCancelOpen: boolean;
  setConfirmCancelOpen: Dispatch<SetStateAction<boolean>>;
  tplModalOpen: boolean;
  setTplModalOpen: Dispatch<SetStateAction<boolean>>;
  tplSlug: string;
  setTplSlug: Dispatch<SetStateAction<string>>;
  tplName: string;
  setTplName: Dispatch<SetStateAction<string>>;
  tplErr: string | null;
  setTplErr: Dispatch<SetStateAction<string | null>>;
  tplSaving: boolean;
  send: () => Promise<void>;
  runControl: (action: SendControlAction) => Promise<void>;
  duplicate: () => Promise<void>;
  openSaveAsTemplate: () => void;
  commitSaveAsTemplate: () => Promise<void>;
  remove: () => Promise<void>;
}

export function useCampaignLifecycleController({
  id,
  detail,
  setDetail,
  savedFromEmail,
  isDraft,
  canMutate,
  canAdmin,
  authoringLocked,
  setBusy,
  onChange,
  onClose,
  beforeSend,
}: CampaignLifecycleControllerInput): CampaignLifecycleController {
  const sendEvidence = useCampaignSendEvidence({ id, isDraft });
  const mountedRef = useRef(true);
  const campaignId = id == null ? null : String(id);
  const campaignIdRef = useRef(campaignId);
  const detailRef = useRef(detail);
  const savedFromEmailRef = useRef(savedFromEmail);
  const isDraftRef = useRef(isDraft);
  const canMutateRef = useRef(canMutate);
  const canAdminRef = useRef(canAdmin);
  const authoringLockedRef = useRef(authoringLocked);
  const previousCampaignIdRef = useRef(campaignId);
  const [confirmDeleteOpen, setConfirmDeleteOpenState] = useState(false);
  const [confirmCancelOpen, setConfirmCancelOpenState] = useState(false);
  const [tplModalOpen, setTplModalOpenState] = useState(false);
  const [tplSlug, setTplSlugState] = useState("");
  const [tplName, setTplNameState] = useState("");
  const [tplErr, setTplErrState] = useState<string | null>(null);
  const [tplSaving, setTplSaving] = useState(false);
  const confirmDeleteOpenRef = useRef(confirmDeleteOpen);
  const confirmCancelOpenRef = useRef(confirmCancelOpen);
  const tplModalOpenRef = useRef(tplModalOpen);
  const tplSlugRef = useRef(tplSlug);
  const tplNameRef = useRef(tplName);

  campaignIdRef.current = campaignId;
  detailRef.current = detail;
  savedFromEmailRef.current = savedFromEmail;
  isDraftRef.current = isDraft;
  canMutateRef.current = canMutate;
  canAdminRef.current = canAdmin;
  authoringLockedRef.current = authoringLocked;
  confirmDeleteOpenRef.current = confirmDeleteOpen;
  confirmCancelOpenRef.current = confirmCancelOpen;
  tplModalOpenRef.current = tplModalOpen;
  tplSlugRef.current = tplSlug;
  tplNameRef.current = tplName;

  const mutationBlockReason = useCallback(
    ({
      admin = false,
      persistedAuthoring = false,
      draftOnly = false,
    }: {
      admin?: boolean;
      persistedAuthoring?: boolean;
      draftOnly?: boolean;
    } = {}): string | null => {
      if (!canMutateRef.current) {
        return "Your current role cannot change campaigns or control sends.";
      }
      if (admin && !canAdminRef.current) {
        return "Your current role cannot perform this admin-only campaign action.";
      }
      if (persistedAuthoring && authoringLockedRef.current) {
        return "Save or cancel the open campaign editor before acting on the persisted campaign.";
      }
      if (draftOnly && !isDraftRef.current) {
        return "This action is only available while the campaign is a draft.";
      }
      if (campaignIdRef.current == null) {
        return "Campaign identity is unavailable. Reopen the campaign and try again.";
      }
      return null;
    },
    [],
  );

  const allowMutation = useCallback(
    (options: Parameters<typeof mutationBlockReason>[0] = {}): boolean => {
      const reason = mutationBlockReason(options);
      if (reason == null) return true;
      toast.error(reason);
      return false;
    },
    [mutationBlockReason],
  );

  const setConfirmSendOpen = useCallback<Dispatch<SetStateAction<boolean>>>(
    (value) => {
      const next =
        typeof value === "function"
          ? value(sendEvidence.confirmSendOpen)
          : value;
      if (
        next &&
        !allowMutation({ persistedAuthoring: true, draftOnly: true })
      ) {
        return;
      }
      sendEvidence.setConfirmSendOpen(next);
    },
    [allowMutation, sendEvidence],
  );

  const setConfirmDeleteOpen = useCallback<Dispatch<SetStateAction<boolean>>>(
    (value) => {
      const next =
        typeof value === "function"
          ? value(confirmDeleteOpenRef.current)
          : value;
      if (next && !allowMutation({ persistedAuthoring: true })) return;
      confirmDeleteOpenRef.current = next;
      setConfirmDeleteOpenState(next);
    },
    [allowMutation],
  );
  const setConfirmCancelOpen = useCallback<Dispatch<SetStateAction<boolean>>>(
    (value) => {
      const next =
        typeof value === "function"
          ? value(confirmCancelOpenRef.current)
          : value;
      if (next && !allowMutation()) return;
      confirmCancelOpenRef.current = next;
      setConfirmCancelOpenState(next);
    },
    [allowMutation],
  );
  const setTplModalOpen = useCallback<Dispatch<SetStateAction<boolean>>>(
    (value) => {
      const next =
        typeof value === "function" ? value(tplModalOpenRef.current) : value;
      if (next && !allowMutation({ admin: true, persistedAuthoring: true })) {
        return;
      }
      tplModalOpenRef.current = next;
      setTplModalOpenState(next);
    },
    [allowMutation],
  );
  const setTplName = useCallback<Dispatch<SetStateAction<string>>>((value) => {
    if (!canMutateRef.current || !canAdminRef.current) return;
    const next =
      typeof value === "function" ? value(tplNameRef.current) : value;
    tplNameRef.current = next;
    setTplNameState(next);
  }, []);
  const setTplSlug = useCallback<Dispatch<SetStateAction<string>>>((value) => {
    if (!canMutateRef.current || !canAdminRef.current) return;
    const next =
      typeof value === "function" ? value(tplSlugRef.current) : value;
    tplSlugRef.current = next;
    setTplSlugState(next);
  }, []);
  const setTplErr = useCallback<Dispatch<SetStateAction<string | null>>>(
    (value) => {
      if (!canMutateRef.current || !canAdminRef.current) return;
      setTplErrState(value);
    },
    [],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (previousCampaignIdRef.current === campaignId) return;
    previousCampaignIdRef.current = campaignId;
    // A destructive ceremony belongs to exactly one campaign identity. If a
    // parent ever reuses this controller, close it instead of silently loading
    // evidence for a different row into the already-open dialog.
    sendEvidence.setConfirmSendOpen(false);
    confirmDeleteOpenRef.current = false;
    setConfirmDeleteOpenState(false);
    confirmCancelOpenRef.current = false;
    setConfirmCancelOpenState(false);
    tplModalOpenRef.current = false;
    setTplModalOpenState(false);
  }, [campaignId, sendEvidence]);

  const send = async (): Promise<void> => {
    if (!allowMutation({ persistedAuthoring: true, draftOnly: true })) return;
    const claim = sendEvidence.claimSend();
    if (claim.status === "busy") return;
    if (claim.status === "blocked") {
      toast.error(
        "Send is locked until the current checklist and audience verification are complete.",
      );
      return;
    }
    if (claim.status === "over-cap") {
      toast.error(
        "Send is locked because this audience exceeds today's warmup cap.",
      );
      return;
    }

    const claimedCampaignId = claim.campaignId;
    setBusy(true);
    let result: Awaited<ReturnType<typeof api.sendCampaign>>;
    try {
      if (beforeSend) await beforeSend();
      result = await api.sendCampaign(claimedCampaignId);
    } catch (error) {
      sendEvidence.releaseSend();
      if (!mountedRef.current) return;
      setBusy(false);
      toast.error(
        `Couldn't send: ${
          error instanceof Error && error.message.trim()
            ? error.message
            : "The send request failed unexpectedly."
        }`,
      );
      return;
    }
    sendEvidence.releaseSend();
    if (!mountedRef.current) return;
    setBusy(false);
    if (!sendEvidence.isCurrentCampaign(claimedCampaignId)) return;
    if (result.error) {
      toast.error(`Couldn't send: ${result.error.message}`);
      return;
    }
    sendEvidence.setConfirmSendOpen(false);
    if (result.data?.status === "approval_required") {
      toast.info(
        result.data.message ??
          "This send needs approval before it goes out — check Approvals.",
      );
      onChange?.(detailRef.current);
      return;
    }
    const next: CampaignDetail = { ...detailRef.current, status: "sending" };
    setDetail(next);
    onChange?.(next);
    if (
      result.data?.assurance_rollout_mode === "warn" &&
      result.data.assurance_status !== "ok"
    ) {
      toast.info(
        "Campaign queued with a Campaign Assurance advisory. Review the current assurance result before the warning rollout advances to blocking.",
      );
    } else {
      toast.success("On its way — your campaign is sending.");
    }
    try {
      if (!localStorage.getItem("pw:celebrated:first-send")) {
        celebrate();
        localStorage.setItem("pw:celebrated:first-send", "1");
      }
    } catch {
      // A blocked local store must never interfere with the send.
    }
    trackTelemetry("campaign_sent", { source: "slideover" });
  };

  const runControl = async (action: SendControlAction): Promise<void> => {
    if (!allowMutation()) return;
    const currentCampaignId = campaignIdRef.current;
    if (currentCampaignId == null) return;
    setBusy(true);
    const request =
      action === "pause"
        ? pauseCampaign
        : action === "resume"
          ? resumeCampaign
          : cancelCampaign;
    let result: Awaited<ReturnType<typeof request>>;
    try {
      result = await request(currentCampaignId);
    } catch (error) {
      if (!mountedRef.current) return;
      setBusy(false);
      toast.error(
        `Couldn't ${action} the send: ${
          error instanceof Error && error.message.trim()
            ? error.message
            : "The campaign control request failed unexpectedly."
        }`,
      );
      return;
    }
    if (!mountedRef.current) return;
    setBusy(false);
    if (campaignIdRef.current !== currentCampaignId) return;
    if (action === "cancel") setConfirmCancelOpenState(false);
    if (result.error) {
      toast.error(`Couldn't ${action} the send: ${result.error.message}`);
      return;
    }
    const nextStatus =
      result.data?.status ??
      (action === "pause"
        ? "paused"
        : action === "resume"
          ? "sending"
          : "cancelled");
    const next: CampaignDetail = { ...detailRef.current, status: nextStatus };
    setDetail(next);
    onChange?.(next);
    toast.success(
      action === "pause"
        ? "Send paused — no further messages will go out until you resume."
        : action === "resume"
          ? "Send resumed."
          : "Send cancelled.",
    );
  };

  const duplicate = async (): Promise<void> => {
    if (!allowMutation({ persistedAuthoring: true, draftOnly: true })) return;
    const currentCampaignId = campaignIdRef.current;
    const currentDetail = detailRef.current;
    if (!currentDetail.name || currentCampaignId == null) return;
    if (currentDetail.status && currentDetail.status !== "draft") {
      toast.error(
        `Can't duplicate a ${currentDetail.status} campaign — clone from the draft instead, or duplicate the original after it finishes.`,
      );
      return;
    }
    setBusy(true);
    let result: Awaited<ReturnType<typeof api.createCampaign>>;
    try {
      result = await api.createCampaign({
        name: `${currentDetail.name} (copy)`,
        subject: currentDetail.subject ?? "",
        from_email: savedFromEmailRef.current,
        body: asCampaignString(currentDetail.body_html ?? ""),
      });
    } catch (error) {
      if (!mountedRef.current) return;
      setBusy(false);
      toast.error(
        `Couldn't duplicate: ${
          error instanceof Error && error.message.trim()
            ? error.message
            : "The duplicate request failed unexpectedly."
        }`,
      );
      return;
    }
    if (!mountedRef.current) return;
    setBusy(false);
    if (campaignIdRef.current !== currentCampaignId) return;
    if (result.error) {
      toast.error(`Couldn't duplicate: ${result.error.message}`);
      return;
    }
    onChange?.(null);
    toast.success(`Duplicated as "${currentDetail.name} (copy)"`);
  };

  const openSaveAsTemplate = (): void => {
    if (!allowMutation({ admin: true, persistedAuthoring: true })) return;
    const baseName = detailRef.current.name || "Untitled campaign";
    const defaultSlug = baseName
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80);
    tplSlugRef.current = defaultSlug;
    setTplSlugState(defaultSlug);
    const defaultName = `${baseName} template`;
    tplNameRef.current = defaultName;
    setTplNameState(defaultName);
    setTplErrState(null);
    tplModalOpenRef.current = true;
    setTplModalOpenState(true);
  };

  const commitSaveAsTemplate = async (): Promise<void> => {
    if (!allowMutation({ admin: true, persistedAuthoring: true })) return;
    const currentCampaignId = campaignIdRef.current;
    if (currentCampaignId == null) return;
    const slug = tplSlugRef.current.trim();
    const name = tplNameRef.current.trim();
    if (!slug) {
      setTplErrState("Slug is required.");
      return;
    }
    if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
      setTplErrState(
        "Slug must be lowercase letters, digits, and dashes (no leading dash).",
      );
      return;
    }
    if (!name) {
      setTplErrState("Name is required.");
      return;
    }
    setTplSaving(true);
    setTplErrState(null);
    let result: Awaited<ReturnType<typeof api.saveCampaignAsTemplate>>;
    try {
      result = await api.saveCampaignAsTemplate(currentCampaignId, {
        slug,
        name,
      });
    } catch (error) {
      if (!mountedRef.current) return;
      setTplSaving(false);
      setTplErrState(
        error instanceof Error && error.message.trim()
          ? error.message
          : "The template request failed unexpectedly.",
      );
      return;
    }
    if (!mountedRef.current) return;
    setTplSaving(false);
    if (campaignIdRef.current !== currentCampaignId) return;
    if (result.error) {
      setTplErrState(result.error.message);
      return;
    }
    tplModalOpenRef.current = false;
    setTplModalOpenState(false);
    toast.success(`Saved as template "${result.data.name}"`);
  };

  const remove = async (): Promise<void> => {
    if (!allowMutation({ persistedAuthoring: true })) return;
    const currentCampaignId = campaignIdRef.current;
    if (currentCampaignId == null) return;
    setBusy(true);
    let result: Awaited<ReturnType<typeof api.deleteCampaign>>;
    try {
      result = await api.deleteCampaign(currentCampaignId);
    } catch (error) {
      if (!mountedRef.current) return;
      setBusy(false);
      toast.error(
        `Couldn't delete: ${
          error instanceof Error && error.message.trim()
            ? error.message
            : "The delete request failed unexpectedly."
        }`,
      );
      return;
    }
    if (!mountedRef.current) return;
    setBusy(false);
    if (campaignIdRef.current !== currentCampaignId) return;
    if (result.error) {
      toast.error(`Couldn't delete: ${result.error.message}`);
      return;
    }
    confirmDeleteOpenRef.current = false;
    setConfirmDeleteOpenState(false);
    onChange?.(null);
    toast.success("Campaign deleted");
    onClose();
  };

  return {
    confirmSendOpen: sendEvidence.confirmSendOpen,
    setConfirmSendOpen,
    checklistEvidence: sendEvidence.checklistEvidence,
    retryChecklist: sendEvidence.retryChecklist,
    audiencePreviewEvidence: sendEvidence.audiencePreviewEvidence,
    setAudiencePreviewEvidence: sendEvidence.setAudiencePreviewEvidence,
    checklistFailureOverride: sendEvidence.checklistFailureOverride,
    setChecklistFailureOverride: sendEvidence.setChecklistFailureOverride,
    confirmDeleteOpen,
    setConfirmDeleteOpen,
    confirmCancelOpen,
    setConfirmCancelOpen,
    tplModalOpen,
    setTplModalOpen,
    tplSlug,
    setTplSlug,
    tplName,
    setTplName,
    tplErr,
    setTplErr,
    tplSaving,
    send,
    runControl,
    duplicate,
    openSaveAsTemplate,
    commitSaveAsTemplate,
    remove,
  };
}
