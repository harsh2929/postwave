/**
 * lib/pushSuppressionAdd.ts — the pure half of manually suppressing a device
 * token (POST /api/v1/push/suppressions, exact-admin).
 *
 * Sibling of lib/pushSuppressions.ts rather than an addition to it: that file
 * carries the strict page codec and is already at its complexity ceiling, and
 * this half — the client-side echo of the server's token rules and the add
 * receipt's authority check — is separable and node-testable on its own.
 *
 * TOKEN RULES, MIRRORED FROM THE HANDLER (pushsuppressions/handlers.go
 * validateToken / validateAddInput): 20–4096 BYTES of valid UTF-8 with no
 * whitespace or control characters, platform one of apns|fcm|web, and the
 * only reason a dashboard write may create is `manual`. The client validates
 * for the operator's benefit; the server stays the authority.
 *
 * THE RECEIPT IS CHECKED, NOT TRUSTED. The add answers with the stored row;
 * accepting it blind would let a shape drift (or a proxy) report "suppressed"
 * for a row this workspace cannot see. The receipt must be a tenant-bound
 * MANUAL/dashboard/reversible authority for the platform that was requested.
 */
import {
  decodePushRow,
  isReversibleManualPushSuppression,
  type PushPlatform,
} from "@/lib/pushSuppressions";

export const PUSH_TOKEN_MIN_BYTES = 20;
export const PUSH_TOKEN_MAX_BYTES = 4096;

function utf8ByteLength(value: string): number | null {
  // A lone surrogate is not encodable UTF-8 — the server would reject it, so
  // the byte count for validation purposes is "invalid", not a number.
  if (/(?:[\uD800-\uDBFF](?![\uDC00-\uDFFF]))|(?:(?<![\uD800-\uDBFF])[\uDC00-\uDFFF])/u.test(value)) {
    return null;
  }
  let bytes = 0;
  for (const scalar of value) {
    const code = scalar.codePointAt(0) ?? 0;
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
  }
  return bytes;
}

/** null when acceptable; otherwise the sentence the sheet shows. */
export function pushTokenProblem(token: string): string | null {
  const bytes = utf8ByteLength(token);
  if (bytes === null) {
    return "The token contains characters that cannot be sent.";
  }
  if (bytes < PUSH_TOKEN_MIN_BYTES || bytes > PUSH_TOKEN_MAX_BYTES) {
    return `A device token is ${PUSH_TOKEN_MIN_BYTES}–${PUSH_TOKEN_MAX_BYTES} bytes; paste the full token.`;
  }
  if (/[\s\p{Cc}]/u.test(token)) {
    return "A device token has no spaces, line breaks, or control characters — paste it exactly.";
  }
  return null;
}

export interface PushSuppressionAddInput {
  deviceToken: string;
  platform: PushPlatform;
}

/** The exact wire body; reason is pinned to the only value the server admits. */
export function pushSuppressionAddBody(input: PushSuppressionAddInput): {
  device_token: string;
  platform: PushPlatform;
  reason: "manual";
} {
  return {
    device_token: input.deviceToken,
    platform: input.platform,
    reason: "manual",
  };
}

export class PushSuppressionAddReceiptError extends Error {
  constructor() {
    super(
      "The registry accepted the token but the stored row could not be verified. Reload the roster before trusting this screen.",
    );
    this.name = "PushSuppressionAddReceiptError";
  }
}

export interface PushSuppressionAddReceipt {
  id: string;
  tenantId: string;
  platform: PushPlatform;
  deviceTokenHash: string;
  version: number;
}

/**
 * Validate the stored row the add answers with. Throws unless it is the
 * tenant's own manual dashboard authority for the requested platform.
 */
export function parsePushSuppressionAddReceipt(
  value: unknown,
  expected: { tenantId: string; platform: PushPlatform },
): PushSuppressionAddReceipt {
  const row = decodePushRow(
    value,
    expected.tenantId,
    expected.platform,
  );
  if (!row || !isReversibleManualPushSuppression(row)) {
    throw new PushSuppressionAddReceiptError();
  }
  return {
    id: row.id,
    tenantId: row.tenantId,
    platform: row.platform,
    deviceTokenHash: row.deviceTokenHash,
    version: row.version,
  };
}
