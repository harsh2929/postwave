/** Pure, dependency-injected authority boundary for a manual SMS hold. */
import {
  parseSmsSuppressions,
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

export interface SmsSuppressionAddRuntime {
  isOnline: () => boolean;
  readAuth: () => SmsSuppressionAuthSnapshot;
  addSuppression: (phone: string) => Promise<unknown>;
}

export class SmsSuppressionAddRefusedError extends Error {
  readonly code = "sms_suppression_add_refused";

  constructor(message: string) {
    super(message);
    this.name = "SmsSuppressionAddRefusedError";
  }
}

export class SmsSuppressionAddOutcomeUnknownError extends Error {
  readonly code = "sms_suppression_outcome_unknown";

  constructor() {
    super(
      "Manual hold outcome unknown after the request started. Refresh the exact phone in the original workspace before retrying.",
    );
    this.name = "SmsSuppressionAddOutcomeUnknownError";
  }
}

/** Cached gate, authoritative refresh, identity equality, then exact POST. */
export async function authorizeAndAddSmsSuppression(
  phone: string,
  expectedTenantId: string | null,
  runtime: SmsSuppressionAddRuntime,
): Promise<SmsSuppression> {
  if (!/^\+1[2-9][0-9]{2}[2-9][0-9]{6}$/u.test(phone)) {
    throw new SmsSuppressionAddRefusedError(
      "A canonical US/Canada phone number is required for a manual hold.",
    );
  }
  const before = runtime.readAuth();
  const expected = captureSmsSuppressionAuthority(before);
  if (!canBeginSmsSuppressionWrite(before, expected, expectedTenantId)) {
    throw new SmsSuppressionAddRefusedError(
      "An active owner or admin session is required to add a manual hold.",
    );
  }
  if (!runtime.isOnline()) {
    throw new SmsSuppressionAddRefusedError(
      "Suppressions can only be changed while connected. Reconnect and try again.",
    );
  }
  const profile = await before.refreshSessionFromServer();
  const current = runtime.readAuth();
  if (!refreshedSmsSuppressionAuthorityMatches(profile, current, expected)) {
    throw new SmsSuppressionAddRefusedError(
      "Your workspace identity or effective role changed. No manual hold was confirmed.",
    );
  }
  let raw: unknown;
  try {
    raw = await runtime.addSuppression(phone);
  } catch (error: unknown) {
    const status = smsSuppressionResponseStatus(error);
    if (status >= 400 && status < 500) {
      throw new SmsSuppressionAddRefusedError(
        "The server rejected the manual hold request; no hold was confirmed.",
      );
    }
    throw new SmsSuppressionAddOutcomeUnknownError();
  }
  const createdAt =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>).created_at
      : undefined;
  let row: SmsSuppression | undefined;
  try {
    row = parseSmsSuppressions(
      {
        tenantId: expectedTenantId,
        items: [raw],
        total: 1,
        snapshotAt: createdAt,
      },
      expectedTenantId,
    ).items[0];
  } catch {
    throw new SmsSuppressionAddOutcomeUnknownError();
  }
  if (
    !row ||
    row.phone !== phone ||
    row.reason !== "manual" ||
    row.source !== "manual" ||
    row.reversible !== true
  ) {
    throw new SmsSuppressionAddOutcomeUnknownError();
  }
  const after = runtime.readAuth();
  if (
    !finalSmsSuppressionAuthorityMatches(after, expected, profile.effectiveRole)
  ) {
    throw new SmsSuppressionAddRefusedError(
      "The server confirmed the manual hold, but your workspace identity or effective role changed afterward. Verify the original workspace before relying on this screen.",
    );
  }
  return row;
}
