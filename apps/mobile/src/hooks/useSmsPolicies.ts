/**
 * Identity-bound reads and online-only writes for private SMS policy state.
 *
 * Quiet-hours and keyword-response reads and writes all mount behind
 * `protectSMSInboxResponse` + `RequireExactTenantAdmin`. Cache keys therefore
 * carry the same base/tenant/user/role/context fingerprint as the SMS inbox,
 * late responses are rejected after an identity transition, and policy state
 * is removed on demotion, workspace switch, or unmount.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";

import { getClient } from "@/api/sdkClient";
import {
  assertCurrentSmsIdentity,
  identityOrThrow,
  type SmsInboxAccess,
  type SmsInboxIdentity,
} from "@/hooks/useSmsInbox";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { isProbablyOnline } from "@/lib/connectivity";
import {
  canToggleSmsKeywordResponse,
  parseKeywordResponses,
  parseQuietHoursRules,
  type SmsKeywordResponse,
  type SmsQuietHoursRule,
} from "@/lib/smsPolicies";
import { useAuthStore } from "@/store/auth";

const POLICY_STALE_MS = 60_000;
const QUIET_HOURS_ROOT = "sms-quiet-hours-v2";
const KEYWORD_RESPONSES_ROOT = "sms-keyword-responses-v2";
const POLICY_ROOTS = [QUIET_HOURS_ROOT, KEYWORD_RESPONSES_ROOT] as const;

export class SmsPolicyOfflineError extends Error {
  readonly code = "offline_write_refused";

  constructor(what: string) {
    super(`${what} needs a connection — it is never queued for later.`);
    this.name = "SmsPolicyOfflineError";
  }
}

export class SmsPolicyOutcomeUnknownError extends Error {
  readonly code = "sms_policy_outcome_unknown";

  constructor() {
    super(
      "Stored policy outcome unknown after the request started. Reload the original workspace and verify the exact row before retrying.",
    );
    this.name = "SmsPolicyOutcomeUnknownError";
  }
}

export class SmsPolicyReceiptConfirmedIdentityChangedError extends Error {
  readonly code = "sms_policy_receipt_confirmed_identity_changed";

  constructor() {
    super(
      "The server confirmed the stored policy change before your workspace identity changed. Reload the original workspace before relying on this screen.",
    );
    this.name = "SmsPolicyReceiptConfirmedIdentityChangedError";
  }
}

function policyResponseStatus(error: unknown): number {
  if (!error || typeof error !== "object" || !("status" in error)) return 0;
  const value = (error as { status?: unknown }).status;
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

async function runPolicyWrite<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error: unknown) {
    const status = policyResponseStatus(error);
    if (status >= 400 && status < 500) throw error;
    throw new SmsPolicyOutcomeUnknownError();
  }
}

function assertPolicyReceiptIdentity(identity: SmsInboxIdentity): void {
  try {
    assertCurrentSmsIdentity(identity);
  } catch {
    throw new SmsPolicyReceiptConfirmedIdentityChangedError();
  }
}

export function quietHoursKey(fingerprint: string | null) {
  return [QUIET_HOURS_ROOT, fingerprint] as const;
}

export function keywordResponsesKey(fingerprint: string | null) {
  return [KEYWORD_RESPONSES_ROOT, fingerprint] as const;
}

function useRetirePolicyQueries(access: SmsInboxAccess): void {
  const client = useQueryClient();
  const previous = useRef(access.identity?.fingerprint ?? null);
  const fingerprint = access.identity?.fingerprint ?? null;

  useEffect(() => {
    const retire = (remove: boolean) => {
      for (const root of POLICY_ROOTS) {
        void client.cancelQueries({ queryKey: [root] });
        if (remove) client.removeQueries({ queryKey: [root] });
      }
    };
    if (!access.roleAllowed || !access.identity) {
      retire(true);
    } else if (previous.current !== fingerprint) {
      retire(true);
    } else if (!access.canRequest) {
      retire(false);
    }
    previous.current = fingerprint;
    return () => retire(true);
  }, [
    access.canRequest,
    access.identity,
    access.roleAllowed,
    client,
    fingerprint,
  ]);
}

/** Each write gets its own controller; only retirement/unmount aborts it. */
function usePolicyWriteControllers(access: SmsInboxAccess) {
  const controllers = useRef(new Set<AbortController>());
  useEffect(
    () => () => {
      for (const controller of controllers.current) controller.abort();
      controllers.current.clear();
    },
    [access.canRequest, access.identity?.fingerprint],
  );
  return useCallback(async <T>(run: (signal: AbortSignal) => Promise<T>) => {
    const controller = new AbortController();
    controllers.current.add(controller);
    try {
      return await run(controller.signal);
    } finally {
      controllers.current.delete(controller);
    }
  }, []);
}

async function freshPolicyIdentity(
  access: SmsInboxAccess,
  what: string,
): Promise<SmsInboxIdentity> {
  if (!isProbablyOnline()) throw new SmsPolicyOfflineError(what);
  const identity = identityOrThrow(access.canRequest, access.identity);
  await useAuthStore.getState().refreshSessionFromServer();
  assertCurrentSmsIdentity(identity);
  return identity;
}

/** Complete tenant quiet-hours inventory; empty is a verified answer. */
export function useSmsQuietHours(access: SmsInboxAccess) {
  // The direct-query guard requires an explicit online gate in every query
  // module; access adds the stronger exact identity/admin boundary.
  const onlineGate = useOnlineQueryGate();
  const gate = { enabled: onlineGate.enabled && access.canRequest };
  useRetirePolicyQueries(access);
  return useQuery({
    queryKey: quietHoursKey(access.identity?.fingerprint ?? null),
    enabled: gate.enabled,
    staleTime: POLICY_STALE_MS,
    queryFn: async ({ signal }): Promise<SmsQuietHoursRule[]> => {
      const identity = identityOrThrow(access.canRequest, access.identity);
      const { client } = getClient();
      const rows = parseQuietHoursRules(
        await client.request<unknown>("GET", "/api/v1/sms/quiet-hours", {
          signal,
        }),
        identity.tenantId,
      );
      assertCurrentSmsIdentity(identity);
      return rows;
    },
  });
}

/** Complete tenant keyword-response inventory, ordered by the server. */
export function useSmsKeywordResponses(access: SmsInboxAccess) {
  const onlineGate = useOnlineQueryGate();
  const gate = { enabled: onlineGate.enabled && access.canRequest };
  useRetirePolicyQueries(access);
  return useQuery({
    queryKey: keywordResponsesKey(access.identity?.fingerprint ?? null),
    enabled: gate.enabled,
    staleTime: POLICY_STALE_MS,
    queryFn: async ({ signal }): Promise<SmsKeywordResponse[]> => {
      const identity = identityOrThrow(access.canRequest, access.identity);
      const { client } = getClient();
      const rows = parseKeywordResponses(
        await client.request<unknown>("GET", "/api/v1/sms/keyword-responses", {
          signal,
        }),
        identity.tenantId,
      );
      assertCurrentSmsIdentity(identity);
      return rows;
    },
  });
}

export function useSetQuietHoursEnabled(access: SmsInboxAccess) {
  const queryClient = useQueryClient();
  const withController = usePolicyWriteControllers(access);
  return useMutation({
    mutationKey: [
      "sms-quiet-hours-enabled-v2",
      access.identity?.fingerprint ?? null,
    ],
    mutationFn: async (input: {
      rule: SmsQuietHoursRule;
      enabled: boolean;
    }): Promise<SmsQuietHoursRule> => {
      if (input.enabled && input.rule.countryCode !== "") {
        throw Object.assign(
          new Error(
            "This historical country-scoped rule cannot be enabled because NANP identity does not prove recipient country. Disable it first to retire the unsupported scope.",
          ),
          { code: "country_scope_release_held", status: 422 },
        );
      }
      const identity = await freshPolicyIdentity(
        access,
        "Changing a quiet-hours rule",
      );
      const retiresHistoricalCountry =
        !input.enabled && input.rule.countryCode !== "";
      const raw = await runPolicyWrite(() =>
        withController(async (signal) => {
          const { client } = getClient();
          return await client.request<unknown>(
            "PATCH",
            `/api/v1/sms/quiet-hours/${encodeURIComponent(input.rule.id)}`,
            {
              body: {
                enabled: input.enabled,
                ...(retiresHistoricalCountry ? { country_code: "" } : {}),
                expected_updated_at: input.rule.updatedAt,
              },
              signal,
            },
          );
        }),
      );
      let receipt: SmsQuietHoursRule | undefined;
      try {
        receipt = parseQuietHoursRules(
          { tenantId: identity.tenantId, items: [raw] },
          identity.tenantId,
        )[0];
      } catch {
        throw new SmsPolicyOutcomeUnknownError();
      }
      if (
        !receipt ||
        receipt.id !== input.rule.id ||
        receipt.enabled !== input.enabled ||
        receipt.countryCode !== ""
      ) {
        throw new SmsPolicyOutcomeUnknownError();
      }
      assertPolicyReceiptIdentity(identity);
      return receipt;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: quietHoursKey(access.identity?.fingerprint ?? null),
      });
    },
  });
}

export function useSetKeywordResponseEnabled(access: SmsInboxAccess) {
  const queryClient = useQueryClient();
  const withController = usePolicyWriteControllers(access);
  return useMutation({
    mutationKey: [
      "sms-keyword-response-enabled-v2",
      access.identity?.fingerprint ?? null,
    ],
    mutationFn: async (input: {
      row: SmsKeywordResponse;
      enabled: boolean;
    }): Promise<SmsKeywordResponse> => {
      if (!canToggleSmsKeywordResponse(input.row)) {
        throw Object.assign(
          new Error(
            "Custom auto-reply dispatch is release-held; this stored reply-only row cannot be enabled or edited.",
          ),
          {
            code: "sms_auto_reply_dispatch_release_held",
            status: 503,
          },
        );
      }
      const identity = await freshPolicyIdentity(
        access,
        "Changing a keyword state rule",
      );
      const raw = await runPolicyWrite(() =>
        withController(async (signal) => {
          const { client } = getClient();
          return await client.request<unknown>(
            "PATCH",
            `/api/v1/sms/keyword-responses/${encodeURIComponent(input.row.id)}`,
            {
              body: {
                action: "opt_out",
                enabled: input.enabled,
                expected_updated_at: input.row.updatedAt,
              },
              signal,
            },
          );
        }),
      );
      let receipt: SmsKeywordResponse | undefined;
      try {
        receipt = parseKeywordResponses(
          { tenantId: identity.tenantId, items: [raw] },
          identity.tenantId,
        )[0];
      } catch {
        throw new SmsPolicyOutcomeUnknownError();
      }
      if (
        !receipt ||
        receipt.id !== input.row.id ||
        receipt.keyword !== input.row.keyword ||
        receipt.responseBody !== input.row.responseBody ||
        receipt.action !== "opt_out" ||
        receipt.enabled !== input.enabled
      ) {
        throw new SmsPolicyOutcomeUnknownError();
      }
      assertPolicyReceiptIdentity(identity);
      return receipt;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: keywordResponsesKey(access.identity?.fingerprint ?? null),
      });
    },
  });
}
