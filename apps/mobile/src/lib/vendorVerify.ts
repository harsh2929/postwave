/**
 * lib/vendorVerify.ts — forcing a live vendor check on ONE address, safely.
 *
 * POST /api/v1/verification/verify is the only mobile call that can spend a
 * third-party credit on a single deliberate tap. Everything in this file
 * exists to keep that tap deliberate:
 *
 *  - THE REQUEST IS NEVER IMPLICIT. Nothing here runs on render or on typing;
 *    the caller must have a confirmed intent before it builds an attempt.
 *  - A RETRY OF A FAILED ATTEMPT REUSES ITS KEY. The server requires exactly
 *    one Idempotency-Key and fences billable work on it for 24 hours, so a
 *    repeat press after an error REPLAYS rather than re-charges. Minting a
 *    fresh key on every press — which is what the SDK does when none is
 *    supplied — would turn a flaky connection into a row of charges.
 *  - A NEW KEY IS MINTED ONLY AFTER A SETTLED ANSWER, i.e. when the operator
 *    is deliberately asking again, and only then.
 *  - THE SPEND IS REPORTED FROM THE SERVER'S OWN `billable` / `cached` flags,
 *    never guessed. A cached or locally-settled answer costs nothing and must
 *    not be described as a purchase.
 *
 * Import-free of react-native, so it is node-tested.
 */

import { WireShapeError } from "./deliverabilityContracts";

/** apps/api/internal/verification: maxJobEmailBytes. */
export const MAX_VERIFY_ADDRESS_LENGTH = 320;

export function normalizeVerifyAddress(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Why this address cannot be sent, or null when it can.
 *
 * Deliberately thin: the free local tier is what decides whether an address is
 * malformed, and it does that without spending anything. This only refuses the
 * inputs the SERVER refuses (empty, over-long, control characters) plus the
 * one shape that cannot be an address at all, so nobody buys a round trip for
 * a stray tap.
 */
export function vendorVerifyInputError(raw: string): string | null {
  const value = raw.trim();
  if (!value) return "Enter an email address to check.";
  if (value.length > MAX_VERIFY_ADDRESS_LENGTH) {
    return `An email address can be at most ${MAX_VERIFY_ADDRESS_LENGTH} characters.`;
  }
  // Mirrors the server's hasUnsafeControlText: C0/C1 controls plus the
  // zero-width, bidi and format runes. Every one is written as a \u escape,
  // which is why no-control-regex has nothing to flag here.
  if (/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u206f]/u.test(raw)) {
    return "That address contains characters an email address cannot have.";
  }
  const at = value.indexOf("@");
  if (at <= 0 || at === value.length - 1 || value.includes(" ")) {
    return "That doesn't look like an email address.";
  }
  return null;
}

export interface VendorVerifyAttempt {
  /** The normalized address this key is fenced to. */
  email: string;
  /** The Idempotency-Key sent with the billable request. */
  key: string;
  /** True once the server returned an answer for this exact key. */
  settled: boolean;
}

/**
 * The key to use for the press that is about to happen.
 *
 * Same address and the last attempt never settled -> REUSE, so the retry is a
 * replay of a request that may already have crossed the vendor boundary.
 * Anything else -> a fresh key, because it is a different question.
 */
export function nextVendorVerifyAttempt(
  previous: VendorVerifyAttempt | null,
  email: string,
  mint: () => string,
): VendorVerifyAttempt {
  const normalized = normalizeVerifyAddress(email);
  if (previous && previous.email === normalized && !previous.settled) {
    return { email: normalized, key: previous.key, settled: false };
  }
  return { email: normalized, key: mint(), settled: false };
}

/** The sentence shown before any money moves. */
export function vendorVerifyConfirmation(email: string): {
  title: string;
  consequence: string;
} {
  return {
    title: "Check this address with the vendor?",
    consequence: `${normalizeVerifyAddress(email)} will be sent to the configured verification vendor, which probes the mailbox live and charges one provider credit unless the answer is already cached or settled by the free local tier.`,
  };
}

export interface VendorVerifyResult {
  email: string;
  status: string;
  subStatus: string;
  score: number | null;
  provider: string;
  billable: boolean;
  cached: boolean;
  didYouMean: string;
  checkedAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function parseVendorVerifyResult(payload: unknown): VendorVerifyResult {
  const label = "verification result";
  if (!isRecord(payload)) throw new WireShapeError(label);
  const status = text(payload.status).trim().toLowerCase();
  if (!status) throw new WireShapeError(label);
  const score = payload.score;
  if (
    score !== undefined &&
    score !== null &&
    (typeof score !== "number" || !Number.isFinite(score))
  ) {
    throw new WireShapeError(label);
  }
  return {
    email: text(payload.email),
    status,
    subStatus: text(payload.sub_status),
    score: typeof score === "number" ? score : null,
    provider: text(payload.provider),
    billable: payload.billable === true,
    cached: payload.cached === true,
    didYouMean: text(payload.did_you_mean),
    checkedAt: text(payload.checked_at),
  };
}

const STATUS_COPY: Record<string, string> = {
  valid: "Valid — the mailbox was probed and accepted mail.",
  invalid: "Invalid — this address cannot receive mail.",
  catch_all:
    "Catch-all — the domain accepts everything, so the mailbox itself is unknowable.",
  spamtrap: "Spam trap — sending here damages sender reputation directly.",
  abuse: "Abuse address — a known complainer.",
  do_not_mail: "Do not mail — disposable, toxic, or suppressed.",
  unknown: "Unknown — the check could not settle a verdict.",
};

/** The verdict, in the server's own vocabulary. */
export function vendorVerifyResultLine(result: VendorVerifyResult): string {
  const head = STATUS_COPY[result.status] ?? `Result: ${result.status}.`;
  const detail: string[] = [];
  if (result.subStatus) detail.push(result.subStatus.replace(/_/gu, " "));
  if (result.score !== null) detail.push(`score ${result.score} of 10`);
  if (result.didYouMean) detail.push(`did you mean ${result.didYouMean}`);
  return detail.length > 0 ? `${head} (${detail.join(" · ")})` : head;
}

/**
 * What this check actually cost, from the server's flags rather than a guess.
 *
 * `local` is not a vendor and never bills, so naming the provider matters:
 * "settled for free" and "you were charged" are different facts and a phone
 * must not blur them.
 */
export function vendorVerifySpendLine(result: VendorVerifyResult): string {
  if (result.cached) {
    return "Answered from this workspace's cached result — no credit spent.";
  }
  if (result.billable) {
    const who = result.provider ? result.provider : "the vendor";
    return `One provider credit spent with ${who}.`;
  }
  if (result.provider === "local") {
    return "Settled by the free local tier — no credit spent, and no mailbox was probed.";
  }
  return "The server did not report a credit for this check.";
}
