// SPDX-License-Identifier: AGPL-3.0-only
//
// Brief-driven sequence drafting, client side.
//
// Two producers feed the same preview on the new-sequence page:
//   1. Quick match (no AI) — `generateSequenceFromBrief` keyword-matches the
//      brief against the local starter library and surfaces the best fit (or a
//      trimmed/augmented variant) with a per-step rationale. Instant, no
//      request, no AI quota. Port of the desktop's lib/sequences-ai-brief.ts.
//   2. Generate with AI — POST /voice/sequences/draft (sequence-settings-api)
//      returns emails with a relative `delay_hours`; `draftStepsToCanvasSteps`
//      expands every positive wait into a standalone delay node ahead of its
//      email, the way the canvas models waits. Port of the desktop's
//      components/sequence/draft-steps.ts.
//
// Both hand `createSequence` a `SequenceStoredStep[]` — nothing here talks to
// the server.

import {
  DRAFT_STEP_COUNT_MAX,
  type SequenceDraftStep,
} from "./sequence-settings-api";
import {
  SEQUENCE_BRIEF_TEMPLATES,
  type SequenceBriefTemplate,
} from "./sequence-brief-templates";
import type { SequenceStoredStep } from "./voice-types";

/** Curated example prompts shown as quick-pick chips above the textarea. */
export const AI_BRIEF_EXAMPLES: readonly string[] = [
  "4-step welcome for B2C signups, nudge first purchase by day 7",
  "3-email onboarding flow for SaaS trial signups",
  "Recover abandoned carts over 3 days with one discount",
  "Win back lapsed subscribers in 2 emails over 10 days",
  "Post-purchase thank-you + review request + reorder cue",
];

/** One synthesized step with rationale. `step` is what gets POSTed. */
export interface AiBriefDraftStep {
  step: SequenceStoredStep;
  /** Single-sentence "why this step exists" for the preview. */
  rationale: string;
}

/** The end-to-end quick-match draft returned to the UI. */
export interface AiBriefDraft {
  /** Key of the local template this draft was seeded from. */
  templateKey: string;
  /** Display name proposed for the new sequence (operator can override). */
  proposedName: string;
  /** One-line summary explaining how the draft maps to the brief. */
  summary: string;
  /** Ordered steps + per-step rationale. */
  steps: AiBriefDraftStep[];
}

/**
 * Keyword buckets mapping brief intent → template key. Order matters: each
 * template is scored by hit count and ties break on declaration order (so
 * "welcome" beats "onboarding" when a brief mentions both).
 */
const INTENT_KEYWORDS: ReadonlyArray<{
  templateKey: string;
  hints: readonly string[];
}> = [
  {
    templateKey: "welcome-series",
    hints: [
      "welcome",
      "intro",
      "introduce",
      "new subscriber",
      "newsletter signup",
    ],
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
 * Read a "N-step" / "N emails" / "N messages" hint out of the brief so a
 * "3-step welcome" trims the canonical template. Caps at 9.
 */
export function detectStepCount(brief: string): number | null {
  const match = brief
    .toLowerCase()
    .match(/(\d+)\s*[-\s]?\s*(step|email|message|send)s?\b/);
  if (!match) return null;
  const n = Number.parseInt(match[1] ?? "0", 10);
  if (!Number.isFinite(n) || n < 1 || n > 9) return null;
  return n;
}

function pickBestTemplate(brief: string): SequenceBriefTemplate | null {
  const normalized = ` ${brief.toLowerCase()} `;
  let best: { template: SequenceBriefTemplate; score: number } | null = null;
  for (const { templateKey, hints } of INTENT_KEYWORDS) {
    const template = SEQUENCE_BRIEF_TEMPLATES.find((t) => t.key === templateKey);
    if (!template) continue;
    let score = 0;
    for (const hint of hints) {
      if (normalized.includes(hint)) score += 1;
    }
    if (score > 0 && (!best || score > best.score)) {
      best = { template, score };
    }
  }
  return best?.template ?? null;
}

/** Deep-copy steps and renumber positions 1..n by array order. */
export function renumberSteps(steps: SequenceStoredStep[]): SequenceStoredStep[] {
  return steps.map((step, index) => {
    const copy = JSON.parse(JSON.stringify(step)) as SequenceStoredStep;
    copy.position = index + 1;
    return copy;
  });
}

/**
 * Trim or grow steps to match a requested email count, preserving the
 * {email, delay} interleaving the canvas expects.
 */
function fitToStepCount(
  steps: SequenceStoredStep[],
  desiredEmails: number,
): SequenceStoredStep[] {
  const emails = steps.filter((s) => s.type === "email");
  if (emails.length === desiredEmails) return steps;
  if (desiredEmails < emails.length) {
    const out: SequenceStoredStep[] = [];
    let emailsKept = 0;
    for (const step of steps) {
      if (step.type === "email") {
        if (emailsKept >= desiredEmails) break;
        emailsKept += 1;
      } else if (step.type === "delay" && emailsKept >= desiredEmails) {
        continue;
      }
      out.push(step);
    }
    return out;
  }
  // Grow by replaying the template's last wait ahead of a generic follow-up,
  // so cadence stays sensible without inventing copy out of thin air.
  const extra: SequenceStoredStep[] = [];
  const lastDelay = [...steps].reverse().find((s) => s.type === "delay");
  const fillerDelay: SequenceStoredStep = lastDelay ?? {
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
        body: "Hi {{first_name}},\n\nQuick follow-up — wanted to check in and share one more useful resource:\n\n{{primary_cta}}\n\nReply if anything's missing.\n\n— {{sender_name}}",
        delay_seconds: 0,
      },
    });
  }
  return [...steps, ...extra];
}

function describeDelayStep(step: SequenceStoredStep): string {
  if (step.type !== "delay") return "";
  const { value, unit, seconds } = step.delay;
  if (typeof value === "number" && unit) return `${value} ${unit}`;
  if (seconds % 86400 === 0) return `${seconds / 86400} days`;
  if (seconds % 3600 === 0) return `${seconds / 3600} hours`;
  return `${Math.round(seconds / 60)} minutes`;
}

function buildRationales(
  steps: SequenceStoredStep[],
  templateName: string,
): string[] {
  const emailTotal = steps.filter((s) => s.type === "email").length;
  const emailRationale = (index: number): string => {
    if (index === 0) {
      return "Lead with the highest-context send while the subscriber is hot — open rates peak in the first 24h.";
    }
    if (index === emailTotal - 1) {
      return "Land the close — the last touch carries the clearest call-to-action so the flow ends decisively.";
    }
    if (index === 1) {
      return "Reinforce value before asking — this is the proof point that earns the right to the final CTA.";
    }
    return "Mid-flow nurture — keeps the cadence warm without burning out the audience.";
  };
  let emailCursor = 0;
  return steps.map((step) => {
    switch (step.type) {
      case "delay":
        return `Wait ${describeDelayStep(step)} so the prior send has time to land before the next nudge fires.`;
      case "email": {
        const rationale = emailRationale(emailCursor);
        emailCursor += 1;
        return rationale;
      }
      case "condition":
        return "Branch on behavior — re-routes engaged vs. quiet subscribers down different paths.";
      case "tag_add":
      case "tag_remove":
        return "Tag housekeeping — keeps downstream segments and reports honest.";
      case "exit":
        return `Exit — bows out of the ${templateName.toLowerCase()} flow cleanly.`;
    }
  });
}

/**
 * Derive a friendly default name from the brief: its first sentence when it
 * is short enough to be a name, otherwise the template name.
 */
function deriveProposedName(
  brief: string,
  template: SequenceBriefTemplate,
): string {
  const firstSentence = brief.split(/[.!?\n]/)[0]?.trim() ?? "";
  if (firstSentence.length > 4 && firstSentence.length <= 60) {
    return firstSentence.charAt(0).toUpperCase() + firstSentence.slice(1);
  }
  return template.name;
}

/**
 * Synthesize a draft from a free-form brief. Returns null when no template
 * intent matches at all — the UI surfaces the "try a template instead"
 * fallback rather than inventing a flow from whole cloth.
 */
export function generateSequenceFromBrief(brief: string): AiBriefDraft | null {
  const trimmed = brief.trim();
  if (!trimmed) return null;
  const template = pickBestTemplate(trimmed);
  if (!template) return null;

  const stepCount = detectStepCount(trimmed);
  const baseSteps = renumberSteps(template.steps);
  const fitted =
    stepCount != null ? fitToStepCount(baseSteps, stepCount) : baseSteps;
  const positioned = renumberSteps(fitted);
  const rationales = buildRationales(positioned, template.name);

  const emailCount = positioned.filter((s) => s.type === "email").length;
  const plural = emailCount === 1 ? "" : "s";
  const summary =
    stepCount != null
      ? `Adapted the "${template.name}" template to ${emailCount} email${plural} based on your brief.`
      : `Matched your brief to the "${template.name}" template — ${emailCount} email${plural} across the canonical cadence.`;

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

// ----- AI draft → canvas steps ---------------------------------------------

/**
 * Parse the optional "Emails" count. `null` = auto (field blank); `NaN` =
 * invalid (the UI refuses to submit); otherwise an integer in 1..MAX.
 */
export function parseDraftStepCount(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) &&
    parsed >= 1 &&
    parsed <= DRAFT_STEP_COUNT_MAX
    ? parsed
    : Number.NaN;
}

/**
 * Expand an AI draft into the step union `createSequence` accepts: each draft
 * email becomes (optional delay node +) email node, positions renumbered 1..n
 * across the whole flow. Steps are ordered by their draft `position`
 * regardless of array order so a shuffled response cannot scramble the flow.
 */
export function draftStepsToCanvasSteps(
  steps: SequenceDraftStep[],
): SequenceStoredStep[] {
  const ordered = [...steps].sort((a, b) => a.position - b.position);
  const out: SequenceStoredStep[] = [];
  for (const step of ordered) {
    const hours = Math.max(0, Math.round(step.delay_hours ?? 0));
    if (hours > 0) {
      const wholeDays = hours % 24 === 0 ? hours / 24 : null;
      out.push({
        type: "delay",
        position: out.length + 1,
        delay:
          wholeDays != null
            ? { seconds: hours * 3600, value: wholeDays, unit: "days" }
            : { seconds: hours * 3600, value: hours, unit: "hours" },
      });
    }
    out.push({
      type: "email",
      position: out.length + 1,
      email: { subject: step.subject, body: step.body, delay_seconds: 0 },
    });
  }
  return out;
}

/** Human label for a draft step's wait ("Immediately", "Wait 2 days"). */
export function formatDraftDelay(hours: number): string {
  const h = Math.max(0, Math.round(hours));
  if (h === 0) return "Immediately";
  if (h % 24 === 0) {
    const d = h / 24;
    return `Wait ${d} day${d === 1 ? "" : "s"}`;
  }
  return `Wait ${h} hour${h === 1 ? "" : "s"}`;
}
