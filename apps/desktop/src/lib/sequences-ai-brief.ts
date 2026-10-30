/**
 * Sequences — brief-to-canvas AI synthesizer (MVP, client-side).
 *
 * Brief-to-canvas generation is the headline 2026 sequences feature
 * across Klaviyo Composer, Customer.io Copilot, and Loops Smart Flows.
 * Moosewave's voice service exposes single-step regenerate but does
 * NOT yet expose a whole-sequence draft endpoint. Rather than block
 * the UX wedge on a backend round-trip we don't own, we ship the
 * client-side affordance today: keyword-match the brief against the
 * existing curated template library and surface the best fit (or a
 * trimmed/augmented variant) as a draft canvas with per-step
 * rationale. When the voice service grows a `POST /voice/sequences/draft`
 * endpoint, swap the body of `generateSequenceFromBrief` to call it —
 * the call sites already expect the `AiBriefDraft` shape.
 *
 * The brief-keyword heuristic is intentionally simple: cluster the
 * brief by intent (welcome, cart, onboarding, …), pick the closest
 * template, then derive a step-count hint from "N-step" or "N emails"
 * phrases so a "3-step welcome" doesn't render the 5-step template
 * verbatim. The rationale strings explain WHY each step exists, not
 * what it says — this gives the operator the audit trail Klaviyo /
 * Customer.io spent a year tuning user trust around.
 */

import type { SequenceCanvasStep } from "./api-client";
import {
  SEQUENCES_TEMPLATES,
  type SequencesTemplate,
} from "./sequences-templates";

/** Curated example prompts shown as quick-pick chips above the textarea. */
export const AI_BRIEF_EXAMPLES: readonly string[] = [
  "4-step welcome for B2C signups, nudge first purchase by day 7",
  "3-email onboarding flow for SaaS trial signups",
  "Recover abandoned carts over 3 days with one discount",
  "Win back lapsed subscribers in 2 emails over 10 days",
  "Post-purchase thank-you + review request + reorder cue",
];

/** Hard cap on the brief textarea, mirrored client-side for guidance. */
export const AI_BRIEF_MAX_LENGTH = 500;

/** One synthesized step with rationale. Steps[] is what gets POSTed. */
export interface AiBriefDraftStep {
  step: SequenceCanvasStep;
  /** Single-sentence "why this step exists" for the preview tooltip. */
  rationale: string;
}

/** The end-to-end draft returned to the UI. */
export interface AiBriefDraft {
  /** Slug of the canonical template this draft was seeded from. */
  templateKey: string;
  /** Display name we propose for the new sequence (operator can override). */
  proposedName: string;
  /** One-line summary explaining how the draft maps to the brief. */
  summary: string;
  /** Ordered steps + per-step rationale. */
  steps: AiBriefDraftStep[];
}

/**
 * Keyword buckets mapping brief intent → template key. The order
 * matters: we score each template by hit count and break ties using
 * this declaration order (so "welcome" beats "onboarding" when a brief
 * mentions both — welcomes are stricter / more universal).
 */
const INTENT_KEYWORDS: ReadonlyArray<{
  templateKey: string;
  /** Lower-cased substrings; brief is normalized before matching. */
  hints: readonly string[];
}> = [
  {
    templateKey: "welcome-series",
    hints: ["welcome", "intro", "introduce", "new subscriber", "newsletter signup"],
  },
  {
    templateKey: "onboarding-product-tour",
    hints: [
      "onboard",
      "activation",
      "trial",
      "saas",
      "first-week",
      "first week",
      "setup",
      "getting started",
      "product tour",
    ],
  },
  {
    templateKey: "abandoned-cart",
    hints: [
      "abandoned cart",
      "cart abandonment",
      "abandoned checkout",
      "cart recovery",
      "checkout",
      "cart",
    ],
  },
  {
    templateKey: "post-purchase",
    hints: [
      "post-purchase",
      "post purchase",
      "after purchase",
      "thank-you",
      "thank you",
      "review request",
      "reorder",
      "first purchase",
      "review",
    ],
  },
  {
    templateKey: "win-back-lapsed",
    hints: [
      "win-back",
      "win back",
      "lapsed",
      "re-engage",
      "reengage",
      "dormant",
      "inactive",
      "stopped opening",
    ],
  },
  {
    templateKey: "birthday-anniversary",
    hints: ["birthday", "anniversary", "celebrate", "celebration"],
  },
  {
    templateKey: "re-engagement-quarterly",
    hints: [
      "quarterly",
      "check-in",
      "check in",
      "preference",
      "interest survey",
      "still want",
    ],
  },
];

/**
 * Try to read a "N-step" / "N emails" / "N email" hint out of the brief
 * so a "3-step welcome" trims the 5-step canonical template. Caps at 9
 * since anything longer is a smell and would push past sane defaults.
 */
function detectStepCount(brief: string): number | null {
  // Lookahead allows "3-step", "3 step", "3 emails", "3-email"
  const match = brief.toLowerCase().match(/(\d+)\s*[-\s]?\s*(step|email|message|send)s?\b/);
  if (!match) return null;
  const n = Number.parseInt(match[1] ?? "0", 10);
  if (!Number.isFinite(n) || n < 1 || n > 9) return null;
  return n;
}

/**
 * Score each template by counting hint matches in the brief. Returns
 * the top scorer, or null when no template hit at all (the UI then
 * surfaces the "try a template instead" fallback).
 */
function pickBestTemplate(brief: string): SequencesTemplate | null {
  const normalized = ` ${brief.toLowerCase()} `;
  let best: { template: SequencesTemplate; score: number } | null = null;
  for (const { templateKey, hints } of INTENT_KEYWORDS) {
    const template = SEQUENCES_TEMPLATES.find((t) => t.key === templateKey);
    if (!template) continue;
    let score = 0;
    for (const h of hints) {
      if (normalized.includes(` ${h} `) || normalized.includes(h)) score += 1;
    }
    if (score > 0 && (!best || score > best.score)) {
      best = { template, score };
    }
  }
  return best?.template ?? null;
}

/**
 * Trim or repeat steps to match a requested email count. We preserve
 * the {email, delay} interleaving the canonical template uses — the
 * canvas reader expects delays to live in their own nodes, not folded
 * into the email's delay_seconds field.
 */
function fitToStepCount(
  steps: SequenceCanvasStep[],
  desiredEmails: number,
): SequenceCanvasStep[] {
  const emails = steps.filter((s) => s.type === "email");
  if (emails.length === desiredEmails) return steps;
  if (desiredEmails < emails.length) {
    // Drop the last (emails.length - desiredEmails) email/delay pairs.
    // Walk the array and stop emitting once we've collected the target.
    const out: SequenceCanvasStep[] = [];
    let emailsKept = 0;
    for (const step of steps) {
      if (step.type === "email") {
        if (emailsKept >= desiredEmails) break;
        emailsKept += 1;
      } else if (step.type === "delay") {
        // Skip the delay that would precede an already-dropped email.
        if (emailsKept >= desiredEmails) continue;
      }
      out.push(step);
    }
    return out;
  }
  // Grow: append (desiredEmails - emails.length) extra (delay + email) pairs
  // by replaying the canonical sequence's last (email, delay) pattern. This
  // keeps cadence sensible without inventing dates or copy out of thin air.
  const extra: SequenceCanvasStep[] = [];
  const lastDelay = [...steps].reverse().find((s) => s.type === "delay");
  const fillerDelay: SequenceCanvasStep = lastDelay ?? {
    type: "delay",
    position: 0,
    delay: { seconds: 3 * 86400, value: 3, unit: "days" },
  };
  for (let i = 0; i < desiredEmails - emails.length; i += 1) {
    extra.push({ ...fillerDelay, position: 0 });
    extra.push({
      type: "email",
      position: 0,
      email: {
        subject: "Follow-up — keep the conversation going",
        body:
          "Hi {{first_name}},\n\nQuick follow-up — wanted to check in and share one more useful resource:\n\n{{primary_cta}}\n\nReply if anything's missing.\n\n— {{sender_name}}",
        delay_seconds: 0,
      },
    });
  }
  return [...steps, ...extra];
}

/**
 * Pretty-print a delay step for the rationale string. Reads value/unit
 * directly when present and derives them from seconds otherwise so the
 * rationale stays accurate even for legacy template rows.
 */
function describeDelay(step: SequenceCanvasStep): string {
  const value = step.delay?.value;
  const unit = step.delay?.unit;
  if (typeof value === "number" && unit) {
    return `${value} ${unit}`;
  }
  const seconds = step.delay?.seconds ?? 0;
  if (seconds % 86400 === 0) return `${seconds / 86400} days`;
  if (seconds % 3600 === 0) return `${seconds / 3600} hours`;
  return `${Math.round(seconds / 60)} minutes`;
}

/**
 * Build a one-line rationale for each step. Per-step rationales mirror
 * what Klaviyo Composer's "AI breakdown" surfaces: not the copy itself
 * but the strategic reason it exists at this slot. We compute rationales
 * positionally so the strings stay coherent when emails are dropped or
 * added by `fitToStepCount`.
 */
function buildRationales(
  steps: SequenceCanvasStep[],
  templateName: string,
): string[] {
  const emails = steps.filter((s) => s.type === "email");
  const emailRationaleByIndex = (idx: number, total: number): string => {
    if (idx === 0) {
      return `Lead with the highest-context send while the subscriber is hot — open rates peak in the first 24h.`;
    }
    if (idx === total - 1) {
      return `Land the close — last touch carries the clearest call-to-action so the flow ends decisively, not in the noise.`;
    }
    if (idx === 1) {
      return `Reinforce value before asking — this is the proof point that earns the right to the final CTA.`;
    }
    return `Mid-flow nurture — keeps the cadence warm without burning out the audience.`;
  };

  let emailCursor = 0;
  return steps.map((step) => {
    if (step.type === "delay") {
      return `Wait ${describeDelay(step)} so the prior send has time to land before the next nudge fires.`;
    }
    if (step.type === "email") {
      const r = emailRationaleByIndex(emailCursor, emails.length);
      emailCursor += 1;
      return r;
    }
    if (step.type === "condition") {
      return `Branch on behavior — re-routes engaged vs. quiet subscribers down different paths.`;
    }
    if (step.type === "tag_add" || step.type === "tag_remove") {
      return `Tag housekeeping — keeps downstream segments and reports honest.`;
    }
    return `Exit — bows out of the ${templateName.toLowerCase()} flow cleanly.`;
  });
}

/**
 * Synthesize a draft sequence from a free-form brief. Returns null
 * when no template intent matches at all — the UI surfaces the
 * "try a template instead" fallback in that case rather than
 * inventing a bogus flow from whole cloth.
 */
export function generateSequenceFromBrief(brief: string): AiBriefDraft | null {
  const trimmed = brief.trim();
  if (!trimmed) return null;
  const template = pickBestTemplate(trimmed);
  if (!template) return null;

  const stepCount = detectStepCount(trimmed);
  // Start from the canonical template steps so copy lives in the curated
  // library, not hard-coded here (rationale-only, not fixture data).
  const baseSteps = template.steps.map((s) => ({ ...s }));
  const fitted =
    stepCount != null ? fitToStepCount(baseSteps, stepCount) : baseSteps;
  // Rewrite positions in-order so the canvas reader assigns the right
  // step number to each node without a follow-up edit.
  const positioned = fitted.map((step, index) => ({
    ...step,
    position: index + 1,
  }));
  const rationales = buildRationales(positioned, template.name);

  const requestedEmails =
    stepCount ?? positioned.filter((s) => s.type === "email").length;
  const summary =
    stepCount != null
      ? `Adapted the "${template.name}" template to ${requestedEmails} email${
          requestedEmails === 1 ? "" : "s"
        } based on your brief.`
      : `Matched your brief to the "${template.name}" template — ${requestedEmails} email${
          requestedEmails === 1 ? "" : "s"
        } across the canonical cadence.`;

  return {
    templateKey: template.key,
    proposedName: deriveProposedName(trimmed, template),
    summary,
    steps: positioned.map((step, i) => ({
      step,
      rationale: rationales[i] ?? "",
    })),
  };
}

/**
 * Derive a friendly default name from the brief. Falls back to the
 * template name when the brief is too long / too structured to be a
 * good name on its own. Operator can override before submit.
 */
function deriveProposedName(brief: string, template: SequencesTemplate): string {
  // First sentence, capped — avoids 500-char names but keeps the operator's
  // own framing when the brief is already concise ("Welcome flow for B2C").
  const firstSentence = brief.split(/[.!?\n]/)[0]?.trim() ?? "";
  if (firstSentence.length > 4 && firstSentence.length <= 60) {
    return firstSentence.charAt(0).toUpperCase() + firstSentence.slice(1);
  }
  return template.name;
}
