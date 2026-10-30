import { useMutation } from "@tanstack/react-query";
import { type MutableRefObject, useCallback, useEffect, useRef } from "react";

import {
  type Campaign,
  type SubjectLabScoredVariant,
  api,
  createABTestCampaign,
} from "../../lib/api-client";
import {
  mutKey,
  useFailedMutations,
  usePendingMutations,
} from "../../lib/pending-mutations";
import { track as trackTelemetry } from "../../lib/telemetry";
import { consumeDesktopTaskIntent } from "../../lib/desktop-task-intents";
import {
  registerLifecycleGuard,
  signalLifecycleOwnerChanged,
} from "../../lib/lifecycle-coordinator";
import { toast } from "../../components/Toast";
import type { CampaignsData } from "./useCampaignsData";
import type { CampaignsState } from "./useCampaignsState";
import type { CampaignDraft, CreateCampaignVars } from "./campaigns-page-utils";
import {
  deleteCampaignDraft,
  purgeAmbiguousCampaignDraft,
  readCampaignDraft,
  writeCampaignDraft,
} from "./campaign-draft-storage";

function openCampaignCreate(
  state: CampaignsState,
  hasLocalDraft: boolean,
): void {
  if (!hasLocalDraft) {
    state.setDraft({
      name: "",
      subject: "",
      fromEmail: "",
      body: "",
      previewText: "",
    });
  }
  state.setSubmitErr(null);
  state.errors.clear();
  state.setBodyTab("edit");
  state.setCreateOpen(true);
}

function useCampaignCreateClose(
  state: CampaignsState,
  hasLocalDraft: boolean,
  persistCampaignDraft: () => Promise<void>,
): () => void {
  const closeRequestRef = useRef<Promise<void> | null>(null);
  return useCallback((): void => {
    if (closeRequestRef.current) return;
    const finish = (): void => {
      state.setCreateOpen(false);
      consumeDesktopTaskIntent("new-campaign");
    };
    if (!hasLocalDraft) {
      finish();
      return;
    }
    const request = persistCampaignDraft()
      .then(finish)
      .catch(() => {
        state.errors.set(
          "_form",
          "Keep this window open until encrypted draft recovery is available.",
        );
      })
      .finally(() => {
        if (closeRequestRef.current === request) closeRequestRef.current = null;
      });
    closeRequestRef.current = request;
  }, [hasLocalDraft, persistCampaignDraft, state]);
}

function useCampaignDraftRecovery(
  identityScope: string | null,
  state: CampaignsState,
  latestDraftRef: MutableRefObject<CampaignDraft>,
  journalFingerprintRef: MutableRefObject<string | null>,
  journalErrorRef: MutableRefObject<boolean>,
  journalHealthConfirmedRef: MutableRefObject<boolean>,
): void {
  useEffect(() => {
    purgeAmbiguousCampaignDraft();
    let cancelled = false;
    void readCampaignDraft(identityScope).then((result) => {
      if (cancelled) return;
      if (result.status === "unavailable") {
        journalHealthConfirmedRef.current = false;
        journalErrorRef.current = true;
        toast.critical("campaign-draft-recovery-unavailable");
        signalLifecycleOwnerChanged();
        return;
      }
      if (result.status === "invalid-identity") {
        journalHealthConfirmedRef.current = false;
        journalErrorRef.current = true;
        signalLifecycleOwnerChanged();
        return;
      }
      journalHealthConfirmedRef.current = true;
      journalErrorRef.current = false;
      toast.resolveCritical("campaign-draft-recovery-unavailable");
      if (result.status === "invalid") {
        toast.error({
          message: "Saved campaign draft was discarded",
          detail:
            "The encrypted recovery record was malformed or exceeded safe limits.",
        });
        return;
      }
      if (
        result.status !== "ready" ||
        Object.values(latestDraftRef.current).some(
          (value) => value.trim().length > 0,
        )
      ) {
        return;
      }
      journalFingerprintRef.current = JSON.stringify(result.draft);
      state.setDraft(result.draft);
      state.setCreateOpen(true);
      toast.info({
        message: "Recovered your campaign draft",
        detail: "Moosewave restored the encrypted local recovery copy.",
      });
    });
    return () => {
      cancelled = true;
    };
    // CampaignsWorkspace is keyed by identity, so this lookup and every state
    // owner are remounted together on account/workspace changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identityScope]);
}

export function useCampaignCreation(
  state: CampaignsState,
  data: CampaignsData,
  canMutate: boolean,
  identityScope: string | null,
) {
  const canMutateRef = useRef(canMutate);
  canMutateRef.current = canMutate;
  const createCampaignMut = useMutation<Campaign, Error, CreateCampaignVars>({
    mutationKey: mutKey("campaigns", "create"),
    mutationFn: async (variables) => {
      if (!canMutateRef.current) {
        throw new Error("Your role can't create campaigns.");
      }
      const response = await api.createCampaign(variables);
      if (response.error) throw new Error(response.error.message);
      return response.data!;
    },
  });
  const pendingCampaignCreates = usePendingMutations<CreateCampaignVars>(
    "campaigns",
    "create",
  );
  const failedCampaignCreates = useFailedMutations<CreateCampaignVars>(
    "campaigns",
    "create",
  );
  const hasLocalDraft = Object.values(state.draft).some(
    (value) => value.trim().length > 0,
  );
  const latestDraftRef = useRef(state.draft);
  latestDraftRef.current = state.draft;
  const journalFingerprintRef = useRef<string | null>(null);
  const journalErrorRef = useRef(false);
  const journalHealthConfirmedRef = useRef(false);

  useCampaignDraftRecovery(
    identityScope,
    state,
    latestDraftRef,
    journalFingerprintRef,
    journalErrorRef,
    journalHealthConfirmedRef,
  );

  const persistCampaignDraft = useCallback(
    async (
      payload = latestDraftRef.current,
      fingerprint = JSON.stringify(payload),
    ): Promise<void> => {
      try {
        await writeCampaignDraft(identityScope, payload);
        journalFingerprintRef.current = fingerprint;
        if (!journalHealthConfirmedRef.current || journalErrorRef.current) {
          toast.resolveCritical("campaign-draft-recovery-unavailable");
        }
        journalHealthConfirmedRef.current = true;
        journalErrorRef.current = false;
      } catch {
        if (!journalErrorRef.current) {
          toast.critical("campaign-draft-recovery-unavailable");
        }
        journalHealthConfirmedRef.current = false;
        journalErrorRef.current = true;
        throw new Error("campaign_draft_journal_unavailable");
      } finally {
        signalLifecycleOwnerChanged();
      }
    },
    [identityScope],
  );

  useEffect(() => {
    if (!hasLocalDraft) return;
    const payload = state.draft;
    const fingerprint = JSON.stringify(payload);
    const timer = window.setTimeout(() => {
      void persistCampaignDraft(payload, fingerprint).catch(() => undefined);
    }, 400);
    return () => window.clearTimeout(timer);
  }, [hasLocalDraft, persistCampaignDraft, state.draft]);

  useEffect(() => {
    if (!hasLocalDraft && !state.submitting) return;
    return registerLifecycleGuard({
      id: `campaign-create-draft-${identityScope ?? "identity-unavailable"}`,
      label: "New campaign draft",
      inspect: (intent) =>
        intent.disposition === "hide"
          ? null
          : state.submitting
            ? {
                level: "blocking",
                detail: "The campaign draft is still being submitted.",
                canDiscard: false,
              }
            : {
                level:
                  journalFingerprintRef.current ===
                    JSON.stringify(state.draft) && !journalErrorRef.current
                    ? "warning"
                    : "blocking",
                detail:
                  journalFingerprintRef.current ===
                    JSON.stringify(state.draft) && !journalErrorRef.current
                    ? "An encrypted recovery copy of this campaign draft is saved on this device."
                    : "Moosewave has not yet verified an encrypted recovery copy of this campaign draft.",
              },
      prepare: state.submitting ? undefined : () => persistCampaignDraft(),
      discard: () => {
        deleteCampaignDraft(identityScope);
        toast.resolveCritical("campaign-draft-recovery-unavailable");
        journalFingerprintRef.current = null;
        state.setCreateOpen(false);
        state.setLabOpen(false);
        state.setDraft({
          name: "",
          subject: "",
          fromEmail: "",
          body: "",
          previewText: "",
        });
      },
    });
  }, [
    hasLocalDraft,
    identityScope,
    state.createOpen,
    state.labOpen,
    persistCampaignDraft,
    state.setCreateOpen,
    state.setDraft,
    state.setLabOpen,
    state.submitting,
  ]);

  const openCreate = (): void => {
    if (!canMutateRef.current) {
      toast.error({
        message: "Campaign creation is read-only for your current role",
        detail: "Ask a workspace editor or admin for campaign creation access.",
      });
      return;
    }
    openCampaignCreate(state, hasLocalDraft);
  };
  const closeCreate = useCampaignCreateClose(
    state,
    hasLocalDraft,
    persistCampaignDraft,
  );

  const submitCreate = async (): Promise<void> => {
    if (!canMutateRef.current) {
      state.errors.set("_form", "Your role can't create campaigns.");
      return;
    }
    const name = state.draft.name.trim();
    const subject = state.draft.subject.trim();
    const fromEmail = state.draft.fromEmail.trim();
    state.errors.clear();
    if (!name) {
      state.errors.set("name", "Name is required.");
      return;
    }
    if (!subject) {
      state.errors.set("subject", "Subject is required.");
      return;
    }
    if (!fromEmail) {
      state.errors.set("fromEmail", "From email is required.");
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fromEmail)) {
      state.errors.set("fromEmail", "Enter a valid From address.");
      return;
    }
    state.setSubmitting(true);
    state.setSubmitErr(null);
    state.setCreateOpen(false);
    try {
      await createCampaignMut.mutateAsync({
        name,
        subject,
        from_email: fromEmail,
        body: state.draft.body,
        preview_text: state.draft.previewText.trim() || undefined,
      });
      deleteCampaignDraft(identityScope);
      toast.resolveCritical("campaign-draft-recovery-unavailable");
      journalFingerprintRef.current = null;
      consumeDesktopTaskIntent("new-campaign");
      toast.success(`Campaign "${name}" created`);
      trackTelemetry("campaign_created", { source: "page" });
      await data.load();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Preserve and re-open the exact draft after a failed submission; the
      // operator should never have to reconstruct it from a toast.
      state.setCreateOpen(true);
      toast.error(`Couldn't create "${name}": ${message}`);
    } finally {
      state.setSubmitting(false);
    }
  };

  const runAbTestFromVariants = (variants: string[], source: string): void => {
    if (!canMutateRef.current) {
      state.setSubmitErr("Your role can't create campaigns.");
      return;
    }
    const name = state.draft.name.trim();
    if (!name) {
      state.setSubmitErr("Name is required.");
      return;
    }
    if (variants.length < 2) {
      state.setSubmitErr("Need at least 2 distinct variants.");
      return;
    }
    state.setSubmitting(true);
    state.setSubmitErr(null);
    void (async () => {
      const fromNameVariants = state.abFromNames
        .split("\n")
        .map((value) => value.trim())
        .filter(Boolean);
      const response = await createABTestCampaign({
        name,
        subject_variants: variants,
        body_html: state.draft.body,
        from_name: undefined,
        ...(fromNameVariants.length >= 2
          ? { from_name_variants: fromNameVariants }
          : {}),
      });
      state.setSubmitting(false);
      if (response.error) {
        state.setSubmitErr(response.error.message);
        return;
      }
      state.setCreateOpen(false);
      consumeDesktopTaskIntent("new-campaign");
      deleteCampaignDraft(identityScope);
      toast.resolveCritical("campaign-draft-recovery-unavailable");
      journalFingerprintRef.current = null;
      toast.success({
        message: `A/B test "${name}" created`,
        detail: `${response.data.children.length} variants ready to send.`,
      });
      trackTelemetry("campaign_ab_test_created", {
        variant_count: response.data.children.length,
        source,
      });
      await data.load();
    })();
  };

  const runBandit = (topThree: SubjectLabScoredVariant[]): void => {
    if (!canMutateRef.current) {
      toast.error("Your role can't create campaigns.");
      return;
    }
    const name = state.draft.name.trim();
    if (!name) {
      toast.error("Name the campaign before running an A/B test.");
      return;
    }
    state.setLabOpen(false);
    void (async () => {
      const response = await createABTestCampaign({
        name,
        subject_variants: topThree.map((variant) => variant.text),
        body_html: state.draft.body,
        from_name: undefined,
        delivery_settings: {
          ab_test: {
            bandit: true,
            policy: "thompson_opens",
            explore_floor: 0.1,
          },
        },
      });
      if (response.error) {
        toast.error(`Couldn't create A/B test: ${response.error.message}`);
        return;
      }
      state.setCreateOpen(false);
      consumeDesktopTaskIntent("new-campaign");
      deleteCampaignDraft(identityScope);
      toast.resolveCritical("campaign-draft-recovery-unavailable");
      journalFingerprintRef.current = null;
      toast.success({
        message: `A/B test "${name}" created`,
        detail: `${response.data.children.length} bandit arms ready to send.`,
      });
      trackTelemetry("campaign_ab_test_created", {
        variant_count: response.data.children.length,
        source: "subject_lab",
      });
      await data.load();
    })();
  };

  return {
    closeCreate,
    createCampaignMut,
    failedCampaignCreates,
    openCreate,
    pendingCampaignCreates,
    runAbTestFromVariants,
    runBandit,
    submitCreate,
  };
}

export type CampaignCreation = ReturnType<typeof useCampaignCreation>;
