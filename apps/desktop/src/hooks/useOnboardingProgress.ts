import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { api } from "../lib/api-client";
import type { OnboardingStep as ServerOnboardingStep } from "../lib/api-client";
import {
  CHECKLIST_STEPS,
  type ChecklistStepId,
} from "../lib/onboarding-manifest";
import { navigateDesktopRoute } from "../lib/desktop-router";
import { useOnboardingState } from "./useOnboardingState";

export type StepStatus = "complete" | "active" | "pending" | "skipped";

export interface OnboardingStep {
  id: ChecklistStepId;
  title: string;
  description: string;
  unlockedBadge: string;
  goLabel: string;
  goTo: () => void;
  status: StepStatus;
}

export interface OnboardingProgress {
  steps: OnboardingStep[];
  completedStepIds: readonly ChecklistStepId[];
  completion: number;
  ratio: { done: number; total: number };
  done: boolean;
  dismissed: boolean;
  applicable: boolean;
  /** True when current progress came from a validated cache or live API. */
  available: boolean;
  /** True only after this process has confirmed progress with the API. */
  liveConfirmed: boolean;
  loading: boolean;
  /** True while cached progress remains visible during a background refresh. */
  refreshing: boolean;
  /** True when the most recent progress request failed. */
  failed: boolean;
  /** True when a failed refresh left a validated cached snapshot on screen. */
  stale: boolean;
  retry: () => void;
  dismiss: () => void;
  restore: () => void;
  skipStep: (id: ChecklistStepId) => void;
}

const CACHE_TTL_MS = 30 * 60_000;
const lastSuccessfulFetchByScope = new Map<string, number>();
const inflightProgressByScope = new Map<string, Promise<ChecklistStepId[]>>();

function mapServerSteps(steps: ServerOnboardingStep[]): ChecklistStepId[] {
  const completed: ChecklistStepId[] = [];
  for (const step of steps) {
    const mapped = CHECKLIST_STEPS.find(
      (manifestStep) => manifestStep.goalKey === step.key,
    )?.id;
    if (mapped && step.completed) completed.push(mapped);
  }
  return [...new Set(completed)];
}

async function deriveViaFallback(): Promise<ChecklistStepId[]> {
  const [domains, subscribers, campaigns, events, dmarc] = await Promise.all([
    api.listCustomDomains(),
    api.listSubscribers({ perPage: 1 }),
    api.listCampaigns({ perPage: 50 }),
    api.getProductEventStats({ days: 30 }),
    api.listDmarcReports(),
  ]);
  const completed: ChecklistStepId[] = [];
  if (
    Array.isArray(domains.data) &&
    domains.data.some((domain) => domain.verified)
  ) {
    completed.push("verify-domain");
  }
  if (
    subscribers.data &&
    ((subscribers.data.total ?? -1) > 0 ||
      (subscribers.data.items?.length ?? 0) > 0)
  ) {
    completed.push("import-subscribers");
  }
  const campaignRows =
    campaigns.data?.items ??
    campaigns.data?.data ??
    campaigns.data?.results ??
    [];
  if (
    campaignRows.some(
      (campaign) =>
        (campaign.status ?? "").toLowerCase() === "sent" ||
        Boolean(campaign.sent_at),
    )
  ) {
    completed.push("send-first-campaign");
  }
  if ((events.data?.totalEvents ?? 0) > 0) {
    completed.push("connect-events");
  }
  // `harden-deliverability` is the one checklist step with no other fallback
  // signal: `listCustomDomains` carries a single `verified` boolean and no
  // dkim/dmarc timestamps, so this is the only evidence available when the
  // server's own derivation is unreachable. Aggregate reports only arrive
  // once a DMARC record with `rua=` is published, which is exactly what the
  // step's copy asks for. It needs only `read:reports` at viewer level, so it
  // is no authorization hazard for the editors who see this checklist.
  //
  // Reads `.items` and nothing else. This block previously probed
  // `.data`/`.results` too, which the handler has never sent — it replies
  // `{"items": [...], "meta": {...}}` (dmarc.Deps.List). When
  // `DmarcReportsResponse` was tightened to match the handler, those two
  // speculative branches became type errors, and the whole derivation was
  // deleted to clear them. That silently made the step permanently incomplete
  // in the fallback path — the app re-asking for work the tenant had already
  // done, which is the exact failure this area exists to remove. The signal is
  // restored against the shape the server actually sends.
  if ((dmarc.data?.items?.length ?? 0) > 0) {
    completed.push("harden-deliverability");
  }
  if (
    [domains, subscribers, campaigns, events, dmarc].some(
      (result) => result.error,
    )
  ) {
    throw new Error("onboarding_progress_unavailable");
  }
  return completed;
}

async function deriveProgress(): Promise<ChecklistStepId[]> {
  const response = await api.getOnboardingProgress();
  if (response.data && Array.isArray(response.data.steps)) {
    return mapServerSteps(response.data.steps);
  }
  return deriveViaFallback();
}

function deriveProgressDeduped(scope: string): Promise<ChecklistStepId[]> {
  const existing = inflightProgressByScope.get(scope);
  if (existing) return existing;
  const pending = deriveProgress().finally(() => {
    inflightProgressByScope.delete(scope);
  });
  inflightProgressByScope.set(scope, pending);
  return pending;
}

export function useOnboardingProgress(): OnboardingProgress {
  const onboarding = useOnboardingState();
  const scope = onboarding.state.scopeToken;
  const cachedAt = onboarding.state.goals.fetchedAt;
  const hasCachedProgress = cachedAt != null;
  const [fetchState, setFetchState] = useState<{
    scope: string;
    status: "loading" | "success" | "failed";
  }>({ scope: "", status: "loading" });
  const [retryNonce, setRetryNonce] = useState(0);
  const fetchStatus =
    fetchState.scope === scope ? fetchState.status : "loading";
  const loading = !hasCachedProgress && fetchStatus === "loading";
  const refreshing = hasCachedProgress && fetchStatus === "loading";
  const failed = fetchStatus === "failed";
  const available = hasCachedProgress || fetchStatus === "success";
  const liveConfirmed = fetchStatus === "success";
  const stale = hasCachedProgress && failed;
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!onboarding.ready) {
      setFetchState({ scope, status: "loading" });
      return;
    }
    const now = Date.now();
    const lastSuccess = lastSuccessfulFetchByScope.get(scope) ?? 0;
    const cacheFresh = cachedAt != null && now - cachedAt < CACHE_TTL_MS;
    if (cacheFresh && now - lastSuccess < CACHE_TTL_MS) {
      setFetchState({ scope, status: "success" });
      return;
    }
    setFetchState({ scope, status: "loading" });
    const hadValidatedSnapshot = hasCachedProgress;
    let cancelled = false;
    void deriveProgressDeduped(scope)
      .then((completedStepIds) => {
        if (cancelled || !mountedRef.current) return;
        onboarding.syncGoals(
          completedStepIds,
          Date.now(),
          hadValidatedSnapshot,
        );
        lastSuccessfulFetchByScope.set(scope, Date.now());
        while (lastSuccessfulFetchByScope.size > 32) {
          const oldest = lastSuccessfulFetchByScope.keys().next().value as
            | string
            | undefined;
          if (!oldest) break;
          lastSuccessfulFetchByScope.delete(oldest);
        }
        setFetchState({ scope, status: "success" });
      })
      .catch(() => {
        if (!cancelled && mountedRef.current) {
          setFetchState({ scope, status: "failed" });
        }
      });
    return () => {
      cancelled = true;
    };
    // The scope is the controller identity. Goal updates must not re-arm the
    // network request; the TTL map owns refresh eligibility. retryNonce is the
    // one intentional operator-driven bypass.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onboarding.ready, retryNonce, scope]);

  const completedIds = onboarding.state.goals.completedStepIds;
  const checklist = onboarding.state.surfaces.checklist;
  const applicableManifest = useMemo(
    () =>
      CHECKLIST_STEPS.filter(
        (step) =>
          onboarding.role != null && step.roles.includes(onboarding.role),
      ),
    [onboarding.role],
  );
  const skippedIds = checklist.skippedStepIds;

  const steps = useMemo<OnboardingStep[]>(() => {
    const firstUnresolved = applicableManifest.findIndex(
      (step) =>
        !completedIds.includes(step.id) && !skippedIds.includes(step.id),
    );
    return applicableManifest.map((step, index) => {
      const status: StepStatus = completedIds.includes(step.id)
        ? "complete"
        : skippedIds.includes(step.id)
          ? "skipped"
          : index === firstUnresolved
            ? "active"
            : "pending";
      return {
        id: step.id,
        title: step.label,
        description: step.description,
        unlockedBadge: step.unlockedBadge,
        goLabel: step.goLabel,
        goTo: () => {
          if (step.route) navigateDesktopRoute(step.route);
        },
        status,
      };
    });
  }, [applicableManifest, completedIds, skippedIds]);

  const doneCount = steps.filter(
    (step) => step.status === "complete" || step.status === "skipped",
  ).length;
  const total = steps.length;
  const dismiss = useCallback(
    () => onboarding.dismissSurface("checklist"),
    [onboarding],
  );
  const restore = useCallback(
    () => onboarding.resetSurface("checklist"),
    [onboarding],
  );
  const skipStep = useCallback(
    (id: ChecklistStepId) => {
      const next = steps.find(
        (step) =>
          step.id !== id &&
          step.status !== "complete" &&
          step.status !== "skipped",
      );
      onboarding.skipStep("checklist", id, next?.id);
      if (!next) onboarding.skipSurface("checklist", id);
    },
    [onboarding, steps],
  );
  const retry = useCallback(() => {
    setRetryNonce((current) => current + 1);
  }, []);

  return {
    steps,
    completedStepIds: completedIds,
    completion: total === 0 ? 0 : doneCount / total,
    ratio: { done: doneCount, total },
    done: total === 0 || doneCount === total,
    dismissed: checklist.outcome === "dismissed",
    applicable: applicableManifest.length > 0,
    available,
    liveConfirmed,
    loading,
    refreshing,
    failed,
    stale,
    retry,
    dismiss,
    restore,
    skipStep,
  };
}
