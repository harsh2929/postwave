// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  decisionForStep,
  type OnboardingDecisionState,
  type OnboardingStepDecisions,
} from "@postwave/onboarding-schema";

import {
  abortOnboardingDecisionAttempt,
  beginOnboardingDecisionAttempt,
  endOnboardingDecisionAttempt,
  freezeOnboardingDecision,
  onboardingAuthorityFromFields,
  onboardingAuthorityReady,
  onboardingCanDecide,
  onboardingDecisionsKey,
  verifyFreshOnboardingAuthority,
  type OnboardingAuthority,
  type OnboardingDecisionAttempt,
} from "@/lib/onboarding-authority";
import {
  fetchOnboardingDecisions,
  setOnboardingDecision,
} from "@/lib/onboarding-decisions";
import type { RoleKey } from "@/lib/query-keys";
import { useOnline } from "@/lib/use-online";

interface DecisionMutationContext {
  previous?: OnboardingStepDecisions;
  applied: boolean;
}

function confirmationMatches(
  decisions: OnboardingStepDecisions,
  attempt: OnboardingDecisionAttempt,
): boolean {
  const confirmed = decisionForStep(decisions, attempt.intent.stepKey);
  if (!confirmed || confirmed.state !== attempt.intent.state) return false;
  return attempt.intent.reason === undefined
    ? true
    : confirmed.reason === attempt.intent.reason;
}

export interface UseOnboardingDecisionsInput {
  tenantId?: string | null;
  userId?: string | null;
  role?: RoleKey;
  viewerMode?: boolean;
}

export interface OnboardingDecisionRuntime {
  authority: OnboardingAuthority;
  decisions: OnboardingStepDecisions | undefined;
  isPending: boolean;
  isSuccess: boolean;
  isError: boolean;
  canDecide: boolean;
  isOnline: boolean;
  isWriting: boolean;
  error: Error | null;
  writeDecision: (
    stepKey: string,
    state: OnboardingDecisionState,
    reason?: string,
  ) => Promise<void>;
}

/**
 * Exact-principal decision runtime shared by the checklist and dashboard tour.
 * It owns cache isolation, freshness, confirmation, and the cross-surface lock
 * so callers only choose the closed-vocabulary decision they intend to record.
 */
export function useOnboardingDecisions({
  tenantId,
  userId,
  role,
  viewerMode = false,
}: UseOnboardingDecisionsInput): OnboardingDecisionRuntime {
  const queryClient = useQueryClient();
  const online = useOnline();
  const authority = useMemo(
    () => onboardingAuthorityFromFields({ tenantId, userId, role, viewerMode }),
    [role, tenantId, userId, viewerMode],
  );
  const decisionKey = useMemo(
    () => onboardingDecisionsKey(authority),
    [authority],
  );
  const authorityRef = useRef(authority);
  authorityRef.current = authority;
  const ownedAttemptRef = useRef<OnboardingDecisionAttempt | null>(null);
  const previousScopeRef = useRef<{
    authorityKey: string;
    queryKey: readonly unknown[];
  } | null>(null);
  const [localError, setLocalError] = useState<{
    authorityKey: string;
    error: Error;
  } | null>(null);

  useEffect(() => {
    const previous = previousScopeRef.current;
    previousScopeRef.current = {
      authorityKey: authority.key,
      queryKey: decisionKey,
    };
    if (!previous || previous.authorityKey === authority.key) return;

    const owned = ownedAttemptRef.current;
    if (owned) {
      abortOnboardingDecisionAttempt(owned);
      ownedAttemptRef.current = null;
    }
    setLocalError(null);
    // `removeQueries` destroys and cancels an active query synchronously. Do
    // not defer removal behind `cancelQueries()`: on a fast A -> B -> A switch,
    // a deferred cleanup can either delete A's new read or retain A's old
    // optimistic value. The identity-change commit owns this old key now, so
    // purge it before another principal can render.
    queryClient.removeQueries({ queryKey: previous.queryKey, exact: true });
  }, [authority.key, decisionKey, queryClient]);

  useEffect(
    () => () => {
      const owned = ownedAttemptRef.current;
      if (!owned) return;
      abortOnboardingDecisionAttempt(owned);
      ownedAttemptRef.current = null;
    },
    [],
  );

  const decisionsQuery = useQuery({
    queryKey: decisionKey,
    queryFn: ({ signal }) =>
      fetchOnboardingDecisions({
        signal,
        requireOnline: true,
        maxAttempts: 1,
      }),
    enabled: onboardingAuthorityReady(authority),
    staleTime: 60_000,
    retry: false,
  });

  const mutation = useMutation<
    OnboardingStepDecisions,
    Error,
    OnboardingDecisionAttempt,
    DecisionMutationContext
  >({
    onMutate: async (attempt) => {
      if (
        attempt.controller.signal.aborted ||
        authorityRef.current.key !== attempt.authorityKey
      ) {
        throw new Error(
          "Your workspace identity changed before this preference could be saved.",
        );
      }
      await queryClient.cancelQueries({ queryKey: decisionKey, exact: true });
      if (
        attempt.controller.signal.aborted ||
        authorityRef.current.key !== attempt.authorityKey
      ) {
        throw new Error(
          "Your workspace identity changed before this preference could be saved.",
        );
      }
      const previous =
        queryClient.getQueryData<OnboardingStepDecisions>(decisionKey);
      queryClient.setQueryData<OnboardingStepDecisions>(decisionKey, {
        steps: {
          ...(previous?.steps ?? {}),
          [attempt.intent.stepKey]: {
            state: attempt.intent.state,
            ...(attempt.intent.reason ? { reason: attempt.intent.reason } : {}),
          },
        },
      });
      return { previous, applied: true };
    },
    mutationFn: async (attempt) => {
      await verifyFreshOnboardingAuthority(
        attempt.authority,
        attempt.controller.signal,
      );
      await setOnboardingDecision(
        attempt.intent.stepKey,
        attempt.intent.state,
        attempt.intent.reason,
        {
          signal: attempt.controller.signal,
          requireOnline: true,
          maxAttempts: 1,
          idempotencyKey: attempt.idempotencyKey,
        },
      );
      const confirmed = await fetchOnboardingDecisions({
        signal: attempt.controller.signal,
        requireOnline: true,
        maxAttempts: 1,
      });
      if (!confirmationMatches(confirmed, attempt)) {
        throw new Error(
          "The server did not confirm this onboarding preference. Refresh and try again.",
        );
      }
      if (
        attempt.controller.signal.aborted ||
        authorityRef.current.key !== attempt.authorityKey
      ) {
        throw new Error(
          "Your workspace identity changed before this preference was confirmed.",
        );
      }
      return confirmed;
    },
    onSuccess: (confirmed, attempt) => {
      if (
        !attempt.controller.signal.aborted &&
        authorityRef.current.key === attempt.authorityKey
      ) {
        queryClient.setQueryData(decisionKey, confirmed);
        setLocalError(null);
      }
    },
    onError: (_error, attempt, context) => {
      if (
        !context?.applied ||
        attempt.controller.signal.aborted ||
        authorityRef.current.key !== attempt.authorityKey
      ) {
        return;
      }
      if (context.previous !== undefined) {
        queryClient.setQueryData(decisionKey, context.previous);
      } else {
        queryClient.removeQueries({ queryKey: decisionKey, exact: true });
      }
    },
    onSettled: (_data, _error, attempt) => {
      if (ownedAttemptRef.current === attempt) ownedAttemptRef.current = null;
      endOnboardingDecisionAttempt(attempt);
    },
  });

  const mutateAsync = mutation.mutateAsync;
  const writeDecision = useCallback(
    async (
      stepKey: string,
      state: OnboardingDecisionState,
      reason?: string,
    ): Promise<void> => {
      setLocalError(null);
      if (online !== "online") {
        const error = new Error(
          "You are offline. Reconnect before changing onboarding preferences.",
        );
        setLocalError({ authorityKey: authority.key, error });
        throw error;
      }
      const intent = freezeOnboardingDecision(stepKey, state, reason);
      let attempt: OnboardingDecisionAttempt | null;
      try {
        attempt = beginOnboardingDecisionAttempt(authority, intent);
      } catch (cause) {
        const error =
          cause instanceof Error
            ? cause
            : new Error("This onboarding preference could not be changed.");
        setLocalError({ authorityKey: authority.key, error });
        throw error;
      }
      if (!attempt) {
        const error = new Error(
          "Another onboarding preference is being saved. Wait for it to finish.",
        );
        setLocalError({ authorityKey: authority.key, error });
        throw error;
      }
      ownedAttemptRef.current = attempt;
      try {
        await mutateAsync(attempt);
      } catch (cause) {
        const error =
          cause instanceof Error
            ? cause
            : new Error("This onboarding preference could not be saved.");
        if (
          authorityRef.current.key === attempt.authorityKey &&
          !attempt.controller.signal.aborted
        ) {
          setLocalError({ authorityKey: attempt.authorityKey, error });
        }
        throw error;
      }
    },
    [authority, mutateAsync, online],
  );

  const mutationBelongsToCurrentAuthority =
    mutation.variables?.authorityKey === authority.key &&
    !mutation.variables.controller.signal.aborted;
  const visibleLocalError =
    localError?.authorityKey === authority.key ? localError.error : null;

  return {
    authority,
    decisions: decisionsQuery.data,
    isPending: decisionsQuery.isPending,
    isSuccess: decisionsQuery.isSuccess,
    isError: decisionsQuery.isError,
    canDecide: onboardingCanDecide(authority),
    isOnline: online === "online",
    isWriting: mutationBelongsToCurrentAuthority && mutation.isPending,
    error:
      visibleLocalError ??
      (mutationBelongsToCurrentAuthority ? mutation.error : null) ??
      null,
    writeDecision,
  };
}
