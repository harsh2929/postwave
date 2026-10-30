import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { api, type Campaign } from "../../lib/api-client";
import {
  type AudiencePreviewEvidence,
  isCurrentAudiencePreviewReady,
} from "../AudiencePreviewPanel";

export type CampaignChecklistEvidence =
  | { status: "idle"; campaignId: string | null; requestId: number }
  | { status: "loading"; campaignId: string; requestId: number }
  | { status: "ready"; campaignId: string; requestId: number }
  | { status: "not-ready"; campaignId: string; requestId: number }
  | {
      status: "error";
      campaignId: string;
      requestId: number;
      message: string;
    };

type SendEvidenceClaim =
  | { status: "ready"; campaignId: string }
  | { status: "busy" }
  | { status: "blocked" }
  | { status: "over-cap" };

// The checklist wire contract currently exposes only pass/warn/fail. Until it
// distinguishes non-overrideable legal/safety gates from review-only risks and
// records an authorized reason, a blanket desktop override must stay closed.
export const CAMPAIGN_CHECKLIST_OVERRIDE_AVAILABLE: boolean = false;

export interface CampaignSendEvidenceController {
  confirmSendOpen: boolean;
  setConfirmSendOpen: Dispatch<SetStateAction<boolean>>;
  checklistEvidence: CampaignChecklistEvidence;
  retryChecklist: () => void;
  audiencePreviewEvidence: AudiencePreviewEvidence;
  setAudiencePreviewEvidence: (evidence: AudiencePreviewEvidence) => void;
  checklistFailureOverride: boolean;
  setChecklistFailureOverride: Dispatch<SetStateAction<boolean>>;
  claimSend: () => SendEvidenceClaim;
  releaseSend: () => void;
  isCurrentCampaign: (campaignId: string) => boolean;
}

export function useCampaignSendEvidence({
  id,
  isDraft,
}: {
  id: Campaign["id"];
  isDraft: boolean;
}): CampaignSendEvidenceController {
  const campaignId = id == null ? null : String(id);
  const [confirmSendOpenState, setConfirmSendOpenState] = useState(false);
  const confirmSendOpenRef = useRef(false);
  const [checklistEvidenceState, setChecklistEvidenceState] =
    useState<CampaignChecklistEvidence>({
      status: "idle",
      campaignId: null,
      requestId: 0,
    });
  const checklistEvidenceRef = useRef(checklistEvidenceState);
  const checklistRequestRef = useRef(0);
  const [audienceEvidenceState, setAudienceEvidenceState] =
    useState<AudiencePreviewEvidence>({
      status: "idle",
      campaignId: null,
      requestId: 0,
    });
  const audienceEvidenceRef = useRef(audienceEvidenceState);
  const [failureOverrideState, setFailureOverrideState] = useState(false);
  const failureOverrideRef = useRef(false);
  const currentCampaignIdRef = useRef(campaignId);
  const sendInFlightRef = useRef(false);
  const mountedRef = useRef(true);

  currentCampaignIdRef.current = campaignId;
  confirmSendOpenRef.current = confirmSendOpenState;

  const setChecklistEvidence = useCallback(
    (evidence: CampaignChecklistEvidence): void => {
      checklistEvidenceRef.current = evidence;
      setChecklistEvidenceState(evidence);
    },
    [],
  );
  const setAudiencePreviewEvidence = useCallback(
    (evidence: AudiencePreviewEvidence): void => {
      audienceEvidenceRef.current = evidence;
      setAudienceEvidenceState(evidence);
    },
    [],
  );
  const setChecklistFailureOverride = useCallback<
    Dispatch<SetStateAction<boolean>>
  >((value) => {
    const next =
      typeof value === "function" ? value(failureOverrideRef.current) : value;
    failureOverrideRef.current = next;
    setFailureOverrideState(next);
  }, []);

  const resetEvidence = useCallback((): void => {
    checklistRequestRef.current += 1;
    setChecklistEvidence({
      status: "idle",
      campaignId: null,
      requestId: checklistRequestRef.current,
    });
    setAudiencePreviewEvidence({
      status: "idle",
      campaignId: null,
      requestId: 0,
    });
    setChecklistFailureOverride(false);
  }, [
    setAudiencePreviewEvidence,
    setChecklistEvidence,
    setChecklistFailureOverride,
  ]);

  const setConfirmSendOpen = useCallback<Dispatch<SetStateAction<boolean>>>(
    (value) => {
      const next =
        typeof value === "function" ? value(confirmSendOpenRef.current) : value;
      if (!next && sendInFlightRef.current) return;
      confirmSendOpenRef.current = next;
      if (!next) resetEvidence();
      setConfirmSendOpenState(next);
    },
    [resetEvidence],
  );

  const loadChecklist = useCallback((): void => {
    if (!confirmSendOpenRef.current || !isDraft || campaignId == null) {
      resetEvidence();
      return;
    }
    const requestId = ++checklistRequestRef.current;
    setChecklistFailureOverride(false);
    setChecklistEvidence({ status: "loading", campaignId, requestId });

    void api
      .getCampaignChecklist(campaignId)
      .then((result) => {
        if (!requestIsCurrent(requestId, campaignId)) return;
        if (result.error) {
          setChecklistEvidence({
            status: "error",
            campaignId,
            requestId,
            message: result.error.message,
          });
          return;
        }
        const problem = checklistProblem(result.data, campaignId);
        if (problem) {
          setChecklistEvidence({
            status: "error",
            campaignId,
            requestId,
            message: problem,
          });
          return;
        }
        setChecklistEvidence({
          status: result.data.ready ? "ready" : "not-ready",
          campaignId,
          requestId,
        });
      })
      .catch((error: unknown) => {
        if (!requestIsCurrent(requestId, campaignId)) return;
        setChecklistEvidence({
          status: "error",
          campaignId,
          requestId,
          message:
            error instanceof Error && error.message.trim()
              ? error.message
              : "The checklist request failed unexpectedly.",
        });
      });

    function requestIsCurrent(request: number, currentId: string): boolean {
      return (
        mountedRef.current &&
        request === checklistRequestRef.current &&
        currentCampaignIdRef.current === currentId &&
        confirmSendOpenRef.current
      );
    }
  }, [
    campaignId,
    isDraft,
    resetEvidence,
    setChecklistEvidence,
    setChecklistFailureOverride,
  ]);

  useEffect(() => {
    if (!confirmSendOpenState || !isDraft || campaignId == null) {
      resetEvidence();
      return;
    }
    loadChecklist();
    return () => {
      checklistRequestRef.current += 1;
    };
  }, [confirmSendOpenState, isDraft, loadChecklist, campaignId, resetEvidence]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      checklistRequestRef.current += 1;
    };
  }, []);

  const claimSend = useCallback((): SendEvidenceClaim => {
    const currentId = currentCampaignIdRef.current;
    if (sendInFlightRef.current) return { status: "busy" };
    if (currentId == null || !confirmSendOpenRef.current) {
      return { status: "blocked" };
    }
    const checklist = checklistEvidenceRef.current;
    const checklistConfirmed =
      checklist.campaignId === currentId &&
      (checklist.status === "ready" ||
        (CAMPAIGN_CHECKLIST_OVERRIDE_AVAILABLE &&
          checklist.status === "not-ready" &&
          failureOverrideRef.current));
    if (
      !checklistConfirmed ||
      !isCurrentAudiencePreviewReady(audienceEvidenceRef.current, currentId)
    ) {
      return { status: "blocked" };
    }
    if (
      audienceEvidenceRef.current.status !== "ready" ||
      audienceEvidenceRef.current.preview.over_cap
    ) {
      return { status: "over-cap" };
    }
    sendInFlightRef.current = true;
    return { status: "ready", campaignId: currentId };
  }, []);

  const releaseSend = useCallback((): void => {
    sendInFlightRef.current = false;
  }, []);
  const isCurrentCampaign = useCallback(
    (currentId: string): boolean => currentCampaignIdRef.current === currentId,
    [],
  );

  return {
    confirmSendOpen: confirmSendOpenState,
    setConfirmSendOpen,
    checklistEvidence: checklistEvidenceState,
    retryChecklist: loadChecklist,
    audiencePreviewEvidence: audienceEvidenceState,
    setAudiencePreviewEvidence,
    checklistFailureOverride: failureOverrideState,
    setChecklistFailureOverride,
    claimSend,
    releaseSend,
    isCurrentCampaign,
  };
}

function checklistProblem(
  checklist: {
    campaign_id: string;
    ready: boolean;
    checks: { status: "pass" | "warn" | "fail" }[];
  },
  campaignId: string,
): string | null {
  if (String(checklist.campaign_id) !== campaignId) {
    return "The checklist result belongs to a different campaign.";
  }
  if (
    typeof checklist.ready !== "boolean" ||
    !Array.isArray(checklist.checks) ||
    checklist.checks.length === 0 ||
    checklist.checks.some(
      (check) => !new Set(["pass", "warn", "fail"]).has(check.status),
    )
  ) {
    return "The checklist response was incomplete.";
  }
  const hasFailure = checklist.checks.some((check) => check.status === "fail");
  if (checklist.ready === hasFailure) {
    return "The checklist summary did not match its check results.";
  }
  return null;
}
