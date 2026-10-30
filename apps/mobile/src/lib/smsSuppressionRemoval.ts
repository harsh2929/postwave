/** Pure, dependency-injected authority boundary for SMS suppression removal. */
import {
  isReversibleManualSmsSuppression,
  type SmsSuppression,
} from "./suppressionContracts";
import {
  canBeginSmsSuppressionWrite,
  captureSmsSuppressionAuthority,
  finalSmsSuppressionAuthorityMatches,
  refreshedSmsSuppressionAuthorityMatches,
  smsSuppressionResponseStatus,
  type SmsSuppressionAuthSnapshot,
} from "./smsSuppressionAuthority";

export interface SmsSuppressionRemovalRuntime {
  isOnline: () => boolean;
  readAuth: () => SmsSuppressionAuthSnapshot;
  deleteSuppression: (id: string) => Promise<unknown>;
}

export class SmsSuppressionRemovalRefusedError extends Error {
  readonly code = "sms_suppression_removal_refused";

  constructor(message: string) {
    super(message);
    this.name = "SmsSuppressionRemovalRefusedError";
  }
}

export class SmsSuppressionRemovalOutcomeUnknownError extends Error {
  readonly code = "sms_suppression_outcome_unknown";

  constructor() {
    super(
      "Manual hold removal outcome unknown after the request started. Refresh the exact row in the original workspace before retrying.",
    );
    this.name = "SmsSuppressionRemovalOutcomeUnknownError";
  }
}

/** Cached gate, authoritative refresh, identity equality, then exact DELETE. */
export async function authorizeAndRemoveSmsSuppression(
  row: SmsSuppression,
  expectedTenantId: string | null,
  runtime: SmsSuppressionRemovalRuntime,
): Promise<void> {
  if (!isReversibleManualSmsSuppression(row)) {
    throw new SmsSuppressionRemovalRefusedError(
      "Only a reversible manual workspace hold can be removed here.",
    );
  }
  const before = runtime.readAuth();
  const expected = captureSmsSuppressionAuthority(before);
  if (!canBeginSmsSuppressionWrite(before, expected, expectedTenantId)) {
    throw new SmsSuppressionRemovalRefusedError(
      "An active owner or admin session is required to remove a manual hold.",
    );
  }
  if (!runtime.isOnline()) {
    throw new SmsSuppressionRemovalRefusedError(
      "Suppressions can only be changed while connected. Reconnect and try again.",
    );
  }

  const profile = await before.refreshSessionFromServer();
  const current = runtime.readAuth();
  if (!refreshedSmsSuppressionAuthorityMatches(profile, current, expected)) {
    throw new SmsSuppressionRemovalRefusedError(
      "Your workspace identity or effective role changed. The hold was not removed.",
    );
  }
  let receipt: unknown;
  try {
    receipt = await runtime.deleteSuppression(row.id);
  } catch (error: unknown) {
    const status = smsSuppressionResponseStatus(error);
    if (status >= 400 && status < 500) {
      throw new SmsSuppressionRemovalRefusedError(
        "The server rejected the manual hold removal; no removal was confirmed.",
      );
    }
    throw new SmsSuppressionRemovalOutcomeUnknownError();
  }
  if (
    !receipt ||
    typeof receipt !== "object" ||
    Array.isArray(receipt) ||
    Object.keys(receipt).length !== 3 ||
    Object.keys(receipt).some(
      (key) => key !== "ok" && key !== "tenantId" && key !== "id",
    ) ||
    (receipt as Record<string, unknown>).ok !== true ||
    (receipt as Record<string, unknown>).tenantId !== expectedTenantId ||
    (receipt as Record<string, unknown>).id !== row.id
  ) {
    throw new SmsSuppressionRemovalOutcomeUnknownError();
  }
  const after = runtime.readAuth();
  if (
    !finalSmsSuppressionAuthorityMatches(after, expected, profile.effectiveRole)
  ) {
    throw new SmsSuppressionRemovalRefusedError(
      "The server confirmed removal, but your workspace identity or effective role changed afterward. Verify the original workspace before relying on this screen.",
    );
  }
}
