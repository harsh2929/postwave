// SPDX-License-Identifier: AGPL-3.0-only
//
// Voice service domain types — shared across pages and api wrappers.

export type SourceType =
  | "newsletter_archive"
  | "twitter"
  | "blog_rss"
  | "podcast_transcript"
  | "linkedin_export"
  | "paste";

export interface VoiceSource {
  id: string;
  type: SourceType;
  label: string;
  itemCount: number;
  lastIngestedAt: string | null;
  status: "pending" | "ingesting" | "ready" | "error";
}

export interface StylisticFeature {
  key: string;
  label: string;
  /** 0..1 normalized weight relative to baseline corpus. */
  weight: number;
}

export interface TonalAxis {
  key: string;
  label: string;
  /** -1..1 (e.g. formal/casual, serious/playful). */
  value: number;
}

export interface VocabularyTerm {
  term: string;
  weight: number;
}

export interface RepresentativeSample {
  id: string;
  title: string;
  excerpt: string;
  /** Full sample text (SEQ-059) — excerpt is the truncated preview. Absent
      when the source only carried a short excerpt. */
  text?: string;
  sourceLabel: string;
  /** Link back to the source when the profile carries one (SEQ-059). */
  sourceUrl?: string;
}

export interface VoiceProfile {
  builtAt: string;
  status: "ready" | "building" | "stale";
  stylistic: StylisticFeature[];
  tonal: TonalAxis[];
  vocabulary: VocabularyTerm[];
  samples: RepresentativeSample[];
  itemCount: number;
}

/**
 * Values that can be decoded from storage. Operational-looking values are
 * retained only for legacy compatibility and must not be treated as runtime
 * evidence by clients.
 */
export type SequenceStatus =
  | "draft"
  | "archived"
  | "active"
  | "running"
  | "paused"
  | "unknown";

/** The only lifecycle state accepted by current authoring/create surfaces. */
export type SequenceAuthoringStatus = "draft";

export interface FidelityBreakdown {
  embedding: number;
  stylistic: number;
  vocab: number;
  structural: number;
}

export interface SequenceEmail {
  id: string;
  position: number;
  subject: string;
  bodyMarkdown: string;
  bodyHtml: string;
  bodyMjml: string | null;
  delayHours: number;
  fidelity: number;
  fidelityBreakdown: FidelityBreakdown;
  fidelityBreakdownPresent?: boolean;
  regenerationCount?: number;
}

/**
 * One arm of an email step's A/B split — services/voice generation.EmailVariant.
 * A step carries 2..4 of them with `weight_bp` (basis points) summing to
 * exactly 10000; an absent list means "no A/B test on this step".
 */
export interface SequenceEmailVariant {
  key: string;
  subject: string;
  body: string;
  body_html?: string;
  weight_bp: number;
}

export interface SequenceCanvasEmailStep {
  type: "email";
  position: number;
  email: {
    subject: string;
    body?: string;
    body_html?: string;
    body_mjml?: string;
    delay_seconds?: number;
    template_id?: string;
    variants?: SequenceEmailVariant[];
  };
}

export interface SequenceCanvasDelayStep {
  type: "delay";
  position: number;
  delay: {
    seconds: number;
    value?: number;
    unit?: "minutes" | "hours" | "days";
  };
}

export interface SequenceCanvasConditionStep {
  type: "condition";
  position: number;
  condition: {
    predicate: string;
    value?: string;
    yes_branch?: SequenceStoredStep[];
    no_branch?: SequenceStoredStep[];
  };
}

export interface SequenceCanvasTagStep {
  type: "tag_add" | "tag_remove";
  position: number;
  tag: {
    tag: string;
  };
}

export interface SequenceCanvasExitStep {
  type: "exit";
  position: number;
}

export type SequenceStoredStep =
  | SequenceCanvasEmailStep
  | SequenceCanvasDelayStep
  | SequenceCanvasConditionStep
  | SequenceCanvasTagStep
  | SequenceCanvasExitStep;

export interface Sequence {
  id: string;
  /** Positive server revision echoed through If-Match on every mutation. */
  version?: number;
  name: string;
  templateId: string;
  templateName: string;
  status: SequenceStatus;
  fidelityAvg: number;
  emails: SequenceEmail[];
  steps?: SequenceStoredStep[];
  createdAt: string;
  updatedAt: string;
  goal?: {
    kind: "open" | "click" | "conversion";
    exit_on_goal: boolean;
  } | null;
  stuckAfterDays?: number;
}

export interface SequenceListItem {
  id: string;
  name: string;
  templateName: string;
  status: SequenceStatus;
  fidelityAvg: number;
  updatedAt: string;
  emailCount: number;
}

// Sequence send performance (SEQ-009).
//
// KEEP IN SYNC WITH:
//   services/voice/internal/handlers/performance.go
//     (SequencePerformance, SequencePerformancePosition)
// Only reached/opened/clicked are tracked per sequence email; bounced,
// delivered, and unsubscribed are intentionally not modeled.
export interface SequencePerformancePosition {
  /** 1-based email position within the sequence. */
  position: number;
  reached: number;
  opened: number;
  clicked: number;
}

export interface SequencePerformance {
  /** Distinct-subscriber rollups across the whole sequence. */
  reached: number;
  opened: number;
  clicked: number;
  positions: SequencePerformancePosition[];
}

export interface TemplateVariable {
  key: string;
  label: string;
  description: string;
  type: "text" | "longtext" | "url" | "number";
  example: string;
  required: boolean;
}

export interface TemplateEmailSpec {
  position: number;
  subjectHint: string;
  bodyHint: string;
  delayHours: number;
}

export interface SequenceTemplate {
  id: string;
  slug: string;
  name: string;
  description: string;
  category: string;
  length: number;
  variables: TemplateVariable[];
  emails: TemplateEmailSpec[];
}

export interface StyleControls {
  humor: number;
  directness: number;
  lengthBias: number;
  formality: number;
}

export interface CreateSequenceRequest {
  templateId?: string;
  name?: string;
  status?: SequenceAuthoringStatus;
  variables?: Record<string, string>;
  style?: Partial<StyleControls>;
  steps?: SequenceStoredStep[];
  goal?: Sequence["goal"];
  stuckAfterDays?: number;
}

export interface RegenerateEmailRequest {
  hint?: string;
  style?: Partial<StyleControls>;
}

export interface GenerationStatus {
  sequenceId: string;
  state: "queued" | "generating" | "ready" | "error";
  progress: number;
  message: string;
}

export type AddSourceParams =
  | { type: "newsletter_archive"; label?: string }
  | { type: "twitter"; handle: string; label?: string }
  | { type: "blog_rss"; feedUrl: string; label?: string }
  | {
      type: "podcast_transcript";
      text: string;
      title?: string;
      url?: string;
      label?: string;
    }
  | {
      type: "linkedin_export";
      archivePath?: string;
      csvText?: string;
      label?: string;
    }
  | { type: "paste"; text: string; label?: string };

export function fidelityColor(score: number): "green" | "amber" | "red" {
  if (score >= 80) return "green";
  if (score >= 60) return "amber";
  return "red";
}
