/**
 * lib/reputationResponse.ts — the three verbs for "our sending reputation is on
 * fire right now".
 *
 * ── WHY THESE THREE TOGETHER ───────────────────────────────────────────────
 * `deliverability.degraded` push (default ON) lands an operator on this
 * platform at the exact moment something is wrong with sending. Until now every
 * response to it required a laptop:
 *
 *   1. ATTACK MODE (`PUT /api/v1/firewall/settings`) — mobile READ the setting
 *      and rendered its label (`firewallModeLabel`) with no way to change it.
 *      This matters more than a missing toggle usually would, because the
 *      server can turn attack mode on BY ITSELF: the settings carry
 *      `attack_mode_auto_enabled_at` and `attack_mode_auto_cooldown_until`. So
 *      "a signup flood tripped the detector, it was a false positive, turn it
 *      back off" is a live 2am job, not a hypothetical.
 *
 *   2. BLOCKLIST SUPPRESS
 *      (`POST /api/v1/monitoring/blocklist-status/{type}/{subject}/suppress`)
 *      — this had NO client anywhere: not mobile, not web, not desktop, not the
 *      SDK. The mount comment states the design plainly: automatic action
 *      "defaults to off" and apps/api exists to surface "the manual 'suppress
 *      now' affordance". The deliberately-manual half of a Spamhaus response
 *      had no UI at all.
 *
 *   3. SPAM-TRAP SWEEP (`POST /api/v1/spam-trap-guard/run-now`) — desktop-only.
 *
 * ── THE COOLDOWN IS THE SUBTLE PART ────────────────────────────────────────
 * Turning attack mode OFF is not a simple write. The server stamps a 24-hour
 * `attack_mode_auto_cooldown_until` so the auto-detector cannot immediately
 * flip it back on — the comment calls it "operator override stickiness". A UI
 * that does not say this produces the worst possible confusion: the operator
 * turns it off, the detector would have re-armed, and they cannot tell whether
 * their action took. So the confirmation states the 24 hours outright.
 *
 * ── PARTIAL PATCH, ONE FIELD ───────────────────────────────────────────────
 * `UpdateSettingsInput` is all pointers, so a body of exactly
 * `{"attack_mode_enabled": false}` changes that and nothing else. Sending a
 * whole settings object from a phone would silently overwrite thresholds an
 * operator tuned at a desk.
 *
 * No react-native imports — imported by node-run vitest.
 */
import { num } from "./format";

// ---------------------------------------------------------------------------
// Attack mode
// ---------------------------------------------------------------------------

export interface FirewallSettingsLike {
  attackModeEnabled: boolean;
  autoAttackMode: boolean;
  /** Set when the DETECTOR turned it on, rather than a person. */
  attackModeAutoEnabledAt?: string | undefined;
  /** Until this instant the detector will not re-arm after a manual override. */
  attackModeAutoCooldownUntil?: string | undefined;
}

function at(value: string | undefined): number {
  if (!value) return 0;
  const n = new Date(value).getTime();
  return Number.isFinite(n) ? n : 0;
}

/** True while an operator override is still holding the detector off. */
export function cooldownActive(
  settings: FirewallSettingsLike,
  now: number = Date.now(),
): boolean {
  return at(settings.attackModeAutoCooldownUntil) > now;
}

/**
 * Who turned attack mode on — which is the first thing an operator needs, and
 * the thing the raw boolean cannot tell them.
 *
 * A mode a PERSON enabled deliberately and a mode the DETECTOR tripped during a
 * signup flood look identical in `attack_mode_enabled`, and they call for
 * opposite responses.
 */
export function attackModeOrigin(
  settings: FirewallSettingsLike,
): "off" | "auto" | "manual" {
  if (!settings.attackModeEnabled) return "off";
  return settings.attackModeAutoEnabledAt ? "auto" : "manual";
}

export function attackModeSummary(
  settings: FirewallSettingsLike,
  now: number = Date.now(),
): string {
  const origin = attackModeOrigin(settings);
  if (origin === "off") {
    if (cooldownActive(settings, now)) {
      // The single most confusing state to render as a bare "off": somebody
      // already turned it off, and the detector is being held back on purpose.
      return "Attack mode is off, and an operator override is holding the automatic detector off too.";
    }
    return settings.autoAttackMode
      ? "Attack mode is off. The automatic detector is armed and may turn it on."
      : "Attack mode is off, and automatic detection is disabled.";
  }
  return origin === "auto"
    ? "Attack mode is ON — the automatic detector turned it on, not a person."
    : "Attack mode is ON, turned on manually.";
}

/**
 * The consequence sentence for flipping attack mode.
 *
 * Turning it OFF is the one that needs the cooldown explained, because the
 * result is invisible otherwise. Turning it ON is described in terms of what
 * subscribers experience, not in terms of a flag.
 */
export function attackModeConsequence(next: boolean): string {
  return next
    ? "New signups face the strictest checks immediately. Legitimate subscribers may be turned away, so use this while an attack is actually in progress."
    : "Signup checks return to normal. The automatic detector is then held off for 24 hours, so it will not immediately turn attack mode back on — that pause is deliberate, and it is how your override sticks.";
}

// ---------------------------------------------------------------------------
// Blocklist
// ---------------------------------------------------------------------------

export interface BlocklistSubjectLike {
  subject_type: string;
  subject: string;
  listed_zones: string[];
  tier1_hit: boolean;
  listed_count: number;
  total_zones: number;
  would_auto_suppress: boolean;
  last_checked: string;
}

/** Only `ip` and `domain` exist; the handler 400s on anything else. */
export function isSuppressibleSubject(subject: BlocklistSubjectLike): boolean {
  return subject.subject_type === "ip" || subject.subject_type === "domain";
}

/**
 * What a listing actually means, in the order that decides urgency.
 *
 * A tier-1 hit (Spamhaus and friends) is categorically different from a listing
 * on a zone most receivers ignore, and collapsing them into "listed" would make
 * an operator treat a nuisance the same as an emergency.
 */
export function blocklistSeverity(
  subject: BlocklistSubjectLike,
): "clean" | "listed" | "critical" {
  if (subject.listed_count <= 0) return "clean";
  return subject.tier1_hit ? "critical" : "listed";
}

export function blocklistSummary(subject: BlocklistSubjectLike): string {
  const severity = blocklistSeverity(subject);
  if (severity === "clean") {
    return `Clean across ${num(subject.total_zones)} zones.`;
  }
  const zones = subject.listed_zones.filter((z) => z.trim());
  const named = zones.length > 0 ? ` (${zones.slice(0, 3).join(", ")}${zones.length > 3 ? ` and ${zones.length - 3} more` : ""})` : "";
  const tier1 = severity === "critical" ? " This is a tier-1 zone that most receivers act on." : "";
  return `Listed on ${num(subject.listed_count)} of ${num(subject.total_zones)} zones${named}.${tier1}`;
}

/**
 * The consequence of suppressing manually.
 *
 * `would_auto_suppress` is surfaced because it changes the meaning of the act:
 * when automatic suppression is off (the platform default), this is the ONLY
 * thing that will stop sending from a listed subject. Saying so is the
 * difference between "belt and braces" and "this is the brake".
 */
export function blocklistSuppressConsequence(
  subject: BlocklistSubjectLike,
): string {
  const stop = `Sending from ${subject.subject} stops immediately, and it is not undone from this screen.`;
  return subject.would_auto_suppress
    ? `${stop} Automatic suppression would also have caught this.`
    : `${stop} Automatic suppression is off for this workspace, so nothing else is going to stop it.`;
}

// ---------------------------------------------------------------------------
// Spam-trap sweep
// ---------------------------------------------------------------------------

export interface SpamTrapRunResult {
  blocklisted: number;
  completed_at: string;
}

/**
 * The receipt, as a sentence.
 *
 * A sweep that blocklisted nothing is a real and useful answer — "we checked,
 * you are clean" — and rendering it as an empty success toast would leave the
 * operator wondering whether the run happened at all.
 */
export function spamTrapRunSummary(result: SpamTrapRunResult): string {
  const n = Number.isFinite(result.blocklisted) ? result.blocklisted : 0;
  return n === 0
    ? "Sweep finished — no new spam-trap hits were found."
    : `Sweep finished — ${num(n)} address${n === 1 ? "" : "es"} blocklisted.`;
}
