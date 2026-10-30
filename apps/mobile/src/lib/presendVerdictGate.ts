/**
 * lib/presendVerdictGate.ts — how the send sheet reacts to the unified
 * pre-send verdict (POST /api/v1/presend/verdict).
 *
 * lib/campaignVerdict.ts reads the wire body; this file decides what the
 * SEND SHEET does with the reading, and what it says when there is no reading
 * at all. Kept apart on purpose: the reader is shared with the display-only
 * "Get AI verdict" row, while these rules exist only where a send is
 * confirmed.
 *
 * THE ONE INVARIANT: the verdict can never BLOCK a send. It has exactly two
 * powers — escalate a CRITICAL verdict to the same typed confirmation the
 * link check and the drift check already use, and say so, out loud, when it
 * could not run. `warn`, `incomplete`, a 502 from an absent sidecar, a 404 on
 * a deployment without the service, a 503 while it is held: every one of
 * those is a sentence beside the Send button, and the button keeps working.
 *
 * Why `incomplete` is a sentence and not a pass: verdict.go composes three
 * legs and folds an unreachable one into `incomplete` (voice sidecar absent
 * locally → the voice_drift leg is `skipped`/`error`, the verdict is
 * `incomplete`). Rendering that as green would be an invented measurement.
 *
 * Node-pure: mobile's vitest runs in a node environment, so nothing here may
 * reach react-native. The request lives in src/api/presendVerdictGate.ts.
 */
import { campaignErrorCode, campaignErrorStatus } from "@/lib/campaignErrors";
import type { PresendVerdictReading } from "@/lib/campaignVerdict";

/** The guarantee every notice ends with — the sheet never blocks on this. */
const PROCEEDS = "Sending will proceed without it.";

/**
 * The bare address the EQ leg can resolve.
 *
 * The send sheet's caller builds `fromLine` as `"From Name sender@x.com"` —
 * space-joined, no angle brackets (CampaignDetailModals). eqscore's
 * senderDomain() parses `from` with mail.ParseAddress, which REJECTS that
 * form (authority.go:109), so forwarding it verbatim makes the EQ leg fail
 * and every verdict read `incomplete`. Desktop asks for a bare email; this
 * extracts one.
 */
export function presendFromAddress(
  fromLine: string | null | undefined,
): string {
  if (typeof fromLine !== "string") return "";
  for (const token of fromLine.trim().split(/\s+/)) {
    const bare = token.replace(/^<|>$/g, "").trim();
    if (bare.includes("@")) return bare;
  }
  return "";
}

/**
 * Whether there is anything to judge. An empty draft would only ever earn an
 * `incomplete` (the drift leg 400s on an empty body), so the affordance is
 * withheld rather than offered and disappointing.
 */
export function canRunPresendVerdict(
  bodyHtml: string | null | undefined,
): boolean {
  return typeof bodyHtml === "string" && bodyHtml.trim().length > 0;
}

/**
 * True when the reading escalates the send to a typed confirmation.
 *
 * Only `critical` does — the server's own rule (verdict.go: "critical →
 * 'Send anyway' needs confirmation", warn → still allowed). A critical
 * COMPONENT under a non-critical verdict is treated the same way, mirroring
 * desktop's presentationFor(): the server promises the two agree, and if a
 * future build ever breaks that promise the safer reading wins.
 */
export function presendVerdictBlocks(
  reading: PresendVerdictReading | null | undefined,
): boolean {
  if (!reading) return false;
  if (reading.verdict === "critical") return true;
  return reading.components.some((row) => row.status === "critical");
}

/**
 * The consequence line for the confirm sheet. The server authors `summary`
 * ("Critical issues detected. … | Checks incomplete: …") — rendered
 * verbatim; a fallback exists only for a summary the server left empty.
 */
export function presendVerdictConsequence(
  reading: PresendVerdictReading | null | undefined,
): string | null {
  if (!presendVerdictBlocks(reading) || !reading) return null;
  const summary = reading.summary.trim();
  return summary || "The pre-send verdict found a critical issue.";
}

export type PresendVerdictNoticeKind =
  | "upstream"
  | "absent"
  | "held"
  | "denied"
  | "failed";

export interface PresendVerdictNotice {
  kind: PresendVerdictNoticeKind;
  text: string;
}

/**
 * The non-blocking sentence for a verdict request that FAILED.
 *
 *   502 / `upstream_unavailable` — the gateway (serviceproxy.go:72,
 *   httperror.go:193) could not reach a service the check depends on. Locally
 *   that is the voice sidecar being absent.
 *   404 / 405 / 501 — this deployment does not mount the service.
 *   503 — mounted and held (release hold / capability switched off).
 *   401 / 403 — the session lost the editor floor mid-sheet.
 *   anything else — a real fault, said plainly.
 */
export function presendVerdictFailureNotice(err: unknown): PresendVerdictNotice {
  const status = campaignErrorStatus(err);
  const code = campaignErrorCode(err);
  if (status === 502 || code === "upstream_unavailable") {
    return {
      kind: "upstream",
      text: `The pre-send checks couldn't reach a service they depend on. ${PROCEEDS}`,
    };
  }
  if (status === 404 || status === 405 || status === 501) {
    return {
      kind: "absent",
      text: `The pre-send verdict isn't available on this deployment. ${PROCEEDS}`,
    };
  }
  if (status === 503) {
    return {
      kind: "held",
      text: `The pre-send verdict is switched off right now. ${PROCEEDS}`,
    };
  }
  if (status === 401 || status === 403) {
    return {
      kind: "denied",
      text: `Your role can't run the pre-send verdict. ${PROCEEDS}`,
    };
  }
  return {
    kind: "failed",
    text: `Couldn't get a pre-send verdict. ${PROCEEDS}`,
  };
}

/**
 * The standing sentence under a reading that is neither a pass nor a block.
 * Only `incomplete` needs one: the headline already says a `warn` is a warn,
 * but "incomplete" must be told apart from "passed" every time it is shown.
 */
export function presendVerdictStandingNotice(
  reading: PresendVerdictReading | null | undefined,
): string | null {
  if (!reading) return null;
  if (reading.verdict === "incomplete" || !reading.complete) {
    return "Not every check could run. This doesn't block sending — but don't read it as a pass.";
  }
  return null;
}

/** The pill beside the card title. */
export function presendVerdictPillLabel(
  reading: PresendVerdictReading,
): string {
  switch (reading.verdict) {
    case "ok":
      return "Passed";
    case "warn":
      return "Review";
    case "critical":
      return "Critical";
    default:
      return "Incomplete";
  }
}

/**
 * What a screen reader says for the whole card: verdict, the server's
 * summary, and each leg — one sentence instead of a dozen fragments.
 */
export function presendVerdictSpoken(
  reading: PresendVerdictReading | null | undefined,
): string {
  if (!reading) return "Pre-send verdict has not been run.";
  const parts = [`Pre-send verdict: ${presendVerdictPillLabel(reading)}.`];
  const summary = reading.summary.trim();
  if (summary) parts.push(summary);
  for (const row of reading.components) {
    const bits = [row.label];
    if (row.scoreLabel) bits.push(row.scoreLabel);
    if (row.status) bits.push(row.status);
    parts.push(`${bits.join(" ")}.`);
  }
  return parts.join(" ");
}
