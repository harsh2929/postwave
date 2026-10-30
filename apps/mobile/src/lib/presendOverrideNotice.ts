/**
 * lib/presendOverrideNotice.ts — which reason the send sheet gives for
 * turning "Send now" into "Send anyway…".
 *
 * The sheet can be escalated to a typed confirmation by five things at once.
 * The notice under the button names ONE, in the sheet's own order: failing
 * checklist gates, then broken links, then off-voice copy, then a critical
 * pre-send verdict, then the daily cap. That order is not decorative — it is
 * the order of irreversibility (a failed gate or a dead link has no recovery
 * once delivery starts; a cap is a budget), so the operator is told the worst
 * thing first.
 *
 * Every sentence ends with the same promise because the notice explains the
 * button's new label; it is not a second gate and must never read like one.
 *
 * Node-pure: the sheet's vitest runs in node, so nothing here may reach
 * react-native. The rendering lives in components/presend/PresendOverrideNotice.
 */

export interface PresendOverrideFlags {
  /** A checklist that actually ran and actually failed (never a missing one). */
  blockedByChecks: boolean;
  /** The on-demand link check found at least one link that didn't resolve. */
  brokenLinks: boolean;
  /** The drift-only check came back CRITICAL. */
  offVoice: boolean;
  /** The unified pre-send verdict came back CRITICAL (lib/presendVerdictGate). */
  verdictCritical: boolean;
}

const PROMISE = "You'll be asked to confirm before this sends.";

/**
 * The one sentence under an escalated Send button. Callers only render it
 * when the sheet has already decided an override is needed; with every flag
 * false the remaining reason is the daily cap.
 */
export function presendOverrideReason(flags: PresendOverrideFlags): string {
  if (flags.blockedByChecks) {
    return `One or more pre-send checks failed. ${PROMISE}`;
  }
  if (flags.brokenLinks) {
    return `One or more links in this campaign didn't resolve. ${PROMISE}`;
  }
  if (flags.offVoice) {
    return `This draft scored far below your workspace's measured brand voice. ${PROMISE}`;
  }
  if (flags.verdictCritical) {
    return `The pre-send verdict found a critical issue. ${PROMISE}`;
  }
  return `This send exceeds today's cap. ${PROMISE}`;
}
