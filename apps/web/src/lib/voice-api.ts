// SPDX-License-Identifier: AGPL-3.0-only
//
// Typed wrappers over the voice service HTTP endpoints. Uses `voice-mocks`
// only when explicit mock mode is enabled.

import { ApiError, api } from "./api";
import { isMockModeEnabled } from "./mock-mode";
import { isEditableSequenceDraft } from "./sequence-operational-availability";
import { stepsForDuplicate } from "./sequence-helpers";
import type {
  AddSourceParams,
  CreateSequenceRequest,
  GenerationStatus,
  RegenerateEmailRequest,
  Sequence,
  SequenceEmail,
  SequenceListItem,
  SequencePerformance,
  SequenceStoredStep,
  SequenceTemplate,
  VoiceProfile,
  VoiceSource,
} from "./voice-types";

const USE_MOCKS = isMockModeEnabled();
const loadMocks = () => import("./voice-mocks");

export function sequencePositionPathSegment(position: number): string {
  if (!Number.isSafeInteger(position) || position < 1) {
    throw new Error("Sequence email position must be a positive integer");
  }
  return String(position);
}

function requireRegenerationIdempotencyKey(value: string): string {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length < 1 ||
    value.length > 255 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(
      "A stable 1–255 character idempotency key is required for regeneration.",
    );
  }
  return value;
}

type WireVoiceSource = {
  id: string;
  type: string;
  params?: Record<string, unknown>;
  last_ingested_at?: string;
  lastIngestedAt?: string;
  last_item_count?: number;
  lastItemCount?: number;
};

type WireEmail = {
  position: number;
  delay_seconds?: number;
  subject: string;
  body: string;
  body_html?: string;
  body_mjml?: string;
  voice_fidelity_score?: number;
  fidelity_breakdown?: {
    embedding_similarity: number;
    stylistic_distance: number;
    vocabulary_overlap: number;
    structural_match: number;
    combined: number;
  };
  regeneration_count?: number;
};

type WireTemplate = {
  id: string;
  slug: string;
  name: string;
  description?: string;
  category: string;
  length: number;
  variables?: Array<{
    key: string;
    label: string;
    description?: string;
    type?: string;
    example?: string;
    required?: boolean;
  }>;
  emails?: Array<{
    position: number;
    subject_skeleton?: string;
    body_skeleton?: string;
    delay_seconds?: number;
  }>;
};

type WireStep = SequenceStoredStep;

type WireSequence = {
  id: string;
  version?: number;
  template_id?: string;
  name: string;
  status?: Sequence["status"];
  emails?: WireEmail[];
  steps?: WireStep[];
  created_at?: string;
  updated_at?: string;
  goal?: Sequence["goal"];
  stuck_after_days?: number;
};

type WireSequenceJobAccepted = {
  job_id: string;
  status: "pending" | "running";
};

type WireSequenceJob = {
  id: string;
  sequence_id?: string;
  status: "pending" | "running" | "succeeded" | "failed";
  error_message?: string;
};

type WireVoiceProfile = {
  generated_at?: string;
  generatedAt?: string;
  stylistic?: {
    avg_sentence_length?: number;
    sentence_length_variance?: number;
    avg_paragraph_length?: number;
    formality_score?: number;
    hedging_frequency?: number;
    passive_voice_pct?: number;
  } | null;
  vocabulary?: {
    distinctive_terms?: Array<{ term?: string; score?: number }> | null;
    recurring_phrases?: Array<{ phrase?: string; count?: number }> | null;
  } | null;
  tonal?: {
    humor?: number;
    optimism?: number;
    personal_vs_observational?: number;
    directness?: number;
  } | null;
  representative_samples?: Array<{
    id?: string;
    title?: string;
    source?: string;
    source_type?: string;
    sourceLabel?: string;
    text?: string;
    excerpt?: string;
    url?: string;
  }> | null;
  source_summary?: Record<
    string,
    { item_count?: number; itemCount?: number }
  > | null;
};

type VoiceGenerateResponse = {
  text?: string;
  draft?: unknown;
};

async function withMockFallback<T>(
  realCall: () => Promise<T>,
  fallback: () => T | Promise<T>,
): Promise<T> {
  if (USE_MOCKS) return await fallback();
  return realCall();
}

function serviceSourceType(type: AddSourceParams["type"]): string {
  return type === "paste" ? "paste_in" : type;
}

function paramsToWire(params: AddSourceParams): Record<string, unknown> {
  switch (params.type) {
    case "blog_rss":
      return { feedUrl: params.feedUrl.trim(), extra: { label: params.label } };
    case "twitter":
      return {
        extra: {
          label: params.label,
          mode: "api",
          username: params.handle.trim().replace(/^@/, ""),
        },
      };
    case "newsletter_archive":
      return {
        extra: { label: params.label ?? "Moosewave campaign archive" },
      };
    case "linkedin_export":
      return {
        ...(params.archivePath?.trim()
          ? { archivePath: params.archivePath.trim() }
          : {}),
        ...(params.csvText?.trim() ? { rawText: params.csvText.trim() } : {}),
        extra: { label: params.label },
      };
    case "podcast_transcript":
      return {
        rawText: params.text.trim(),
        extra: {
          label: params.label,
          title: params.title?.trim(),
          url: params.url?.trim(),
        },
      };
    case "paste":
      return { rawText: params.text.trim(), extra: { label: params.label } };
  }
}

function toRegisterSourceBody(params: AddSourceParams) {
  return {
    type: serviceSourceType(params.type),
    params: paramsToWire(params),
  };
}

function toVoiceSource(row: WireVoiceSource): VoiceSource {
  const params = row.params ?? {};
  const rawExtra =
    (params.extra && typeof params.extra === "object"
      ? params.extra
      : undefined) ??
    (params.Extra && typeof params.Extra === "object"
      ? params.Extra
      : undefined);
  const extra = (rawExtra ?? {}) as Record<string, unknown>;
  const label =
    stringValue(extra.label) ||
    stringValue(extra.archiveUrl) ||
    stringValue(extra.username) ||
    stringValue(extra.title) ||
    stringValue(params.feedUrl) ||
    stringValue(params.FeedURL) ||
    stringValue(params.archivePath) ||
    stringValue(params.ArchivePath) ||
    "Source";
  const itemCount = row.last_item_count ?? row.lastItemCount ?? 0;
  const lastIngestedAt = normalizeLastIngestedAt(
    row.last_ingested_at ?? row.lastIngestedAt,
  );
  return {
    id: row.id,
    type: row.type === "paste_in" ? "paste" : (row.type as VoiceSource["type"]),
    label,
    itemCount,
    lastIngestedAt,
    status: lastIngestedAt ? "ready" : "pending",
  };
}

function normalizeLastIngestedAt(value: string | undefined): string | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  const date = new Date(timestamp);
  return date.getUTCFullYear() <= 1 ? null : value;
}

function stringValue(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function numberValue(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(0, v));
}

function clampAxis(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(-1, v));
}

function toWireStyle(style: NonNullable<CreateSequenceRequest["style"]>) {
  const lengthBias = style.lengthBias ?? 0;
  return {
    humor: style.humor ?? 0,
    directness: style.directness ?? 0,
    formality_shift: style.formality ?? 0,
    length:
      lengthBias > 0.33 ? "longer" : lengthBias < -0.33 ? "shorter" : "as-is",
  };
}

function toSequence(row: WireSequence): Sequence {
  const wireEmails =
    row.emails && row.emails.length > 0
      ? row.emails
      : emailsFromSteps(row.steps ?? []);
  const emails = wireEmails.map((email) => toSequenceEmail(email, row.id));
  const fidelityAvg = emails.length
    ? Math.round(
        emails.reduce((sum, email) => sum + email.fidelity, 0) / emails.length,
      )
    : 0;
  const createdAt = row.created_at ?? new Date().toISOString();
  return {
    id: row.id,
    ...(Number.isSafeInteger(row.version) && (row.version ?? 0) > 0
      ? { version: row.version }
      : {}),
    name: row.name,
    templateId: row.template_id ?? "",
    templateName: row.template_id ?? "Template",
    // Missing lifecycle authority must never be promoted to an editable draft.
    status: row.status ?? "unknown",
    fidelityAvg,
    emails,
    steps: row.steps,
    createdAt,
    updatedAt: row.updated_at ?? createdAt,
    ...(row.goal !== undefined ? { goal: row.goal } : {}),
    ...(row.stuck_after_days !== undefined
      ? { stuckAfterDays: row.stuck_after_days }
      : {}),
  };
}

function requireSequenceVersion(seq: Pick<Sequence, "version">): number {
  if (!Number.isSafeInteger(seq.version) || (seq.version ?? 0) < 1) {
    throw new Error(
      "A fresh sequence version is required before saving. Reload the sequence and try again.",
    );
  }
  return seq.version!;
}

function requireEditableSequenceDraft(
  seq: Pick<Sequence, "status" | "version">,
): number {
  if (!isEditableSequenceDraft(seq.status)) {
    throw new Error(
      "Only a confirmed draft sequence can be edited. Legacy active, running, paused, and archived rows are read-only.",
    );
  }
  return requireSequenceVersion(seq);
}

function requireDraftCreationStatus(
  status: CreateSequenceRequest["status"] | string | undefined,
): void {
  if (status !== undefined && status !== "draft") {
    throw new Error(
      "Sequences can only be created as drafts while the sequence runtime is unavailable.",
    );
  }
}

function requireConfirmedMutation(
  sequence: Sequence,
  expectedVersion: number,
  expectedStatus: Sequence["status"],
): Sequence {
  if (sequence.version !== expectedVersion + 1) {
    throw new Error(
      "The server did not confirm the next sequence version. Reload the latest version before making another change.",
    );
  }
  if (sequence.status !== expectedStatus) {
    throw new Error(
      `The server did not confirm the expected ${expectedStatus} sequence state. Reload before making another change.`,
    );
  }
  return sequence;
}

function toConfirmedSequenceMutation(
  row: WireSequence,
  expectedVersion: number,
  expectedStatus: Sequence["status"],
): Sequence {
  return requireConfirmedMutation(
    toSequence(row),
    expectedVersion,
    expectedStatus,
  );
}

function emailsFromSteps(steps: SequenceStoredStep[]): WireEmail[] {
  return steps
    .filter(
      (step): step is Extract<SequenceStoredStep, { type: "email" }> =>
        step.type === "email" && Boolean(step.email),
    )
    .map((step) => ({
      position: step.position,
      subject: step.email.subject,
      body: step.email.body ?? "",
      body_html: step.email.body_html,
      body_mjml: step.email.body_mjml,
      delay_seconds: step.email.delay_seconds,
    }));
}

function toSequenceEmail(email: WireEmail, seqId: string): SequenceEmail {
  const fidelity = email.voice_fidelity_score ?? 0;
  const breakdown = validFidelityBreakdown(email.fidelity_breakdown);
  const rawHTML = email.body_html ?? "";
  const legacyMJML = /^\s*<mjml\b/i.test(rawHTML) ? rawHTML : "";
  return {
    id: `${seqId}-${email.position}`,
    position: email.position,
    subject: email.subject,
    bodyMarkdown: email.body,
    bodyHtml: legacyMJML ? "" : rawHTML,
    bodyMjml: (email.body_mjml ?? legacyMJML) || null,
    delayHours: (email.delay_seconds ?? 0) / 3600,
    fidelity,
    fidelityBreakdown: {
      embedding: breakdown ? clamp01(breakdown.embedding_similarity) * 100 : 0,
      stylistic: breakdown ? clamp01(breakdown.stylistic_distance) * 100 : 0,
      vocab: breakdown ? clamp01(breakdown.vocabulary_overlap) * 100 : 0,
      structural: breakdown ? clamp01(breakdown.structural_match) * 100 : 0,
    },
    fidelityBreakdownPresent: breakdown !== null,
    regenerationCount: email.regeneration_count ?? 0,
  };
}

function validFidelityBreakdown(
  value: WireEmail["fidelity_breakdown"],
): NonNullable<WireEmail["fidelity_breakdown"]> | null {
  if (!value) return null;
  return [
    value.embedding_similarity,
    value.stylistic_distance,
    value.vocabulary_overlap,
    value.structural_match,
  ].every((part) => typeof part === "number" && Number.isFinite(part))
    ? value
    : null;
}

function toWireEmail(email: SequenceEmail): WireEmail {
  return {
    position: email.position,
    delay_seconds: Math.max(0, Math.round(email.delayHours * 3600)),
    subject: email.subject,
    body: email.bodyMarkdown,
    body_html: email.bodyHtml || undefined,
    body_mjml: email.bodyMjml ?? undefined,
    voice_fidelity_score: email.fidelity,
    ...(email.fidelityBreakdownPresent
      ? {
          fidelity_breakdown: {
            embedding_similarity: email.fidelityBreakdown.embedding / 100,
            stylistic_distance: email.fidelityBreakdown.stylistic / 100,
            vocabulary_overlap: email.fidelityBreakdown.vocab / 100,
            structural_match: email.fidelityBreakdown.structural / 100,
            combined: email.fidelity,
          },
        }
      : {}),
    regeneration_count: email.regenerationCount ?? 0,
  };
}

function mergeEmailsIntoSteps(
  steps: SequenceStoredStep[] | undefined,
  emails: SequenceEmail[],
): SequenceStoredStep[] | undefined {
  if (!steps || steps.length === 0) return undefined;
  const emailsByPosition = new Map(
    emails.map((email) => [email.position, email]),
  );
  return steps.map((step) => {
    if (step.type !== "email") return step;
    const email = emailsByPosition.get(step.position);
    if (!email) return step;
    return {
      ...step,
      email: {
        ...step.email,
        subject: email.subject,
        body: email.bodyMarkdown,
        body_html: email.bodyHtml || undefined,
        body_mjml: email.bodyMjml ?? undefined,
        delay_seconds: Math.max(0, Math.round(email.delayHours * 3600)),
      },
    };
  });
}

function cleanSubjectVariant(line: string): string {
  return line
    .trim()
    .replace(/^(?:\(?\d+\)?[.):\-]\s*|[-*]\s+)/, "")
    .replace(/^["'*_]+|["'*_]+$/g, "")
    .trim();
}

function parseSubjectVariants(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const numbered: string[] = [];
  for (const line of lines) {
    const match = line.match(/^\s*\(?\d+\)?[.):\-]\s*(.+)$/);
    if (!match?.[1]) continue;
    const cleaned = cleanSubjectVariant(match[1]);
    if (cleaned) numbered.push(cleaned);
    if (numbered.length >= 3) return numbered;
  }
  return lines.map(cleanSubjectVariant).filter(Boolean).slice(0, 3);
}

function toVoiceProfile(row: WireVoiceProfile | null): VoiceProfile | null {
  if (!row) return null;

  const stylistic = row.stylistic ?? {};
  const vocabulary = row.vocabulary ?? {};
  const tonal = row.tonal ?? {};
  const samples = row.representative_samples ?? [];
  const sourceSummary = row.source_summary ?? {};
  const builtAt =
    row.generated_at ?? row.generatedAt ?? new Date().toISOString();

  const distinctiveTerms = vocabulary.distinctive_terms ?? [];
  const maxTermScore = Math.max(
    1,
    ...distinctiveTerms.map((term) => numberValue(term.score)),
  );
  const recurringPhrases = vocabulary.recurring_phrases ?? [];
  const maxPhraseCount = Math.max(
    1,
    ...recurringPhrases.map((phrase) => numberValue(phrase.count)),
  );

  const itemCount =
    Object.values(sourceSummary).reduce(
      (sum, source) => sum + numberValue(source.item_count ?? source.itemCount),
      0,
    ) || samples.length;

  return {
    builtAt,
    status: "ready",
    itemCount,
    stylistic: [
      {
        key: "sentence_len",
        label: "Average sentence length",
        weight: clamp01(numberValue(stylistic.avg_sentence_length) / 30),
      },
      {
        key: "sentence_variance",
        label: "Sentence variation",
        weight: clamp01(
          Math.sqrt(numberValue(stylistic.sentence_length_variance)) / 20,
        ),
      },
      {
        key: "paragraph_len",
        label: "Paragraph length",
        weight: clamp01(numberValue(stylistic.avg_paragraph_length) / 8),
      },
      {
        key: "formality",
        label: "Formality",
        weight: clamp01(numberValue(stylistic.formality_score)),
      },
      {
        key: "hedging",
        label: "Hedging",
        weight: clamp01(numberValue(stylistic.hedging_frequency) / 20),
      },
      {
        key: "passive_voice",
        label: "Passive voice",
        weight: clamp01(numberValue(stylistic.passive_voice_pct)),
      },
    ],
    tonal: [
      {
        key: "humor",
        label: "Serious ↔ Witty",
        value: clampAxis(clamp01(numberValue(tonal.humor)) * 2 - 1),
      },
      {
        key: "optimism",
        label: "Critical ↔ Optimistic",
        value: clampAxis(clamp01(numberValue(tonal.optimism)) * 2 - 1),
      },
      {
        key: "personal",
        label: "Observational ↔ Personal",
        value: clampAxis(
          clamp01(numberValue(tonal.personal_vs_observational)) * 2 - 1,
        ),
      },
      {
        key: "directness",
        label: "Exploratory ↔ Direct",
        value: clampAxis(clamp01(numberValue(tonal.directness)) * 2 - 1),
      },
    ],
    vocabulary: [
      ...distinctiveTerms
        .filter((term) => stringValue(term.term))
        .map((term) => ({
          term: stringValue(term.term),
          weight: clamp01(numberValue(term.score) / maxTermScore),
        })),
      ...recurringPhrases
        .filter((phrase) => stringValue(phrase.phrase))
        .map((phrase) => ({
          term: stringValue(phrase.phrase),
          weight: clamp01((numberValue(phrase.count) / maxPhraseCount) * 0.8),
        })),
    ].slice(0, 20),
    samples: samples.map((sample, index) => {
      const text = stringValue(sample.text) || stringValue(sample.excerpt);
      const excerpt = text.length > 260 ? `${text.slice(0, 257)}...` : text;
      const sourceUrl = stringValue(sample.url);
      return {
        id: stringValue(sample.id) || `sample-${index + 1}`,
        title:
          stringValue(sample.title) || `Representative sample ${index + 1}`,
        excerpt,
        // SEQ-059: retain the full text so the UI can expand beyond the excerpt.
        text,
        sourceLabel:
          stringValue(sample.sourceLabel) ||
          stringValue(sample.source) ||
          stringValue(sample.source_type) ||
          "Voice source",
        sourceUrl: sourceUrl || undefined,
      };
    }),
  };
}

// ----- Profile ----------------------------------------------------------

export function getProfile(): Promise<VoiceProfile | null> {
  return withMockFallback(
    async () => {
      try {
        const profile = await api.get<WireVoiceProfile | null>(
          "/api/v1/voice/profile",
        );
        return toVoiceProfile(profile);
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) return null;
        throw err;
      }
    },
    async () => (await loadMocks()).voiceMocks.getProfile(),
  );
}

export function buildProfile(): Promise<VoiceProfile> {
  return withMockFallback(
    async () => {
      const profile = await api.post<WireVoiceProfile>(
        "/api/v1/voice/profile/build",
      );
      return (
        toVoiceProfile(profile) ?? {
          builtAt: new Date().toISOString(),
          status: "ready",
          stylistic: [],
          tonal: [],
          vocabulary: [],
          samples: [],
          itemCount: 0,
        }
      );
    },
    async () => (await loadMocks()).voiceMocks.buildProfile(),
  );
}

// ----- Sources ----------------------------------------------------------

export function listSources(): Promise<VoiceSource[]> {
  return withMockFallback(
    async () => {
      const rows = await api.get<WireVoiceSource[]>("/api/v1/voice/sources");
      return rows.map(toVoiceSource);
    },
    async () => (await loadMocks()).voiceMocks.listSources(),
  );
}

export function addSource(params: AddSourceParams): Promise<VoiceSource> {
  return withMockFallback(
    async () => {
      const res = await api.post<{ source_id: string }>(
        "/api/v1/voice/sources",
        toRegisterSourceBody(params),
      );
      return toVoiceSource({
        id: res.source_id,
        type: serviceSourceType(params.type),
        params: paramsToWire(params),
      });
    },
    async () => (await loadMocks()).voiceMocks.addSource(params),
  );
}

export function ingestSource(id: string): Promise<VoiceSource> {
  return withMockFallback(
    async () => {
      const accepted = await api.post<{ job_id: string }>(
        `/api/v1/voice/sources/${encodeURIComponent(id)}/ingest`,
      );
      const deadline = Date.now() + 5 * 60 * 1000;
      while (true) {
        const job = await api.get<{
          status: "pending" | "running" | "succeeded" | "failed";
          error_message?: string;
        }>(
          `/api/v1/voice/sources/${encodeURIComponent(id)}/ingest/${encodeURIComponent(accepted.job_id)}`,
        );
        if (job.status === "failed") {
          throw new Error(job.error_message || "Source ingest failed.");
        }
        if (job.status === "succeeded") break;
        if (Date.now() >= deadline) throw new Error("Source ingest timed out.");
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
      const rows = await listSources();
      return (
        rows.find((s) => s.id === id) ?? {
          id,
          type: "paste",
          label: "Source",
          itemCount: 0,
          lastIngestedAt: null,
          status: "ingesting",
        }
      );
    },
    async () => (await loadMocks()).voiceMocks.ingestSource(id),
  );
}

export function removeSource(id: string): Promise<{ ok: true }> {
  return withMockFallback(
    async () => {
      await api.delete<void>(`/api/v1/voice/sources/${encodeURIComponent(id)}`);
      return { ok: true as const };
    },
    () => ({ ok: true as const }),
  );
}

// ----- Templates --------------------------------------------------------

function displayTemplateCategory(category: string): string {
  return category
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function wireTemplateCategory(category: string): string {
  const normalized = category
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_");
  const aliases: Record<string, string> = {
    newsletter: "newsletter_series",
    onboarding: "saas_onboarding",
    nurture: "misc",
    lead_magnet: "misc",
    webinar: "misc",
  };
  return aliases[normalized] ?? normalized;
}

function toSequenceTemplate(row: WireTemplate): SequenceTemplate {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description ?? "",
    category: displayTemplateCategory(row.category),
    length: row.length,
    variables: (row.variables ?? []).map((variable) => ({
      key: variable.key,
      label: variable.label,
      description: variable.description ?? "",
      type: (variable.type ??
        "text") as SequenceTemplate["variables"][number]["type"],
      example: variable.example ?? "",
      required: variable.required ?? false,
    })),
    emails: (row.emails ?? []).map((email) => ({
      position: email.position,
      subjectHint: email.subject_skeleton ?? "",
      bodyHint: email.body_skeleton ?? "",
      delayHours: (email.delay_seconds ?? 0) / 3600,
    })),
  };
}

function toWireTemplate(
  template: Omit<SequenceTemplate, "id" | "slug"> & { slug: string },
): Omit<WireTemplate, "id"> {
  return {
    slug: template.slug,
    name: template.name,
    description: template.description,
    category: wireTemplateCategory(template.category),
    length: template.length,
    variables: template.variables.map((variable) => ({
      key: variable.key,
      label: variable.label,
      description: variable.description,
      type: variable.type,
      example: variable.example,
      required: variable.required,
    })),
    emails: template.emails.map((email) => ({
      position: email.position,
      subject_skeleton: email.subjectHint,
      body_skeleton: email.bodyHint,
      delay_seconds: Math.max(0, Math.round(email.delayHours * 3600)),
    })),
  };
}

export function listTemplates(category?: string): Promise<SequenceTemplate[]> {
  return withMockFallback(
    async () =>
      (
        await api.get<WireTemplate[]>("/api/v1/voice/templates", {
          query: category
            ? { category: wireTemplateCategory(category) }
            : undefined,
        })
      ).map(toSequenceTemplate),
    async () => {
      const all = (await loadMocks()).voiceMocks.getTemplates();
      return category ? all.filter((t) => t.category === category) : all;
    },
  );
}

export function getTemplate(id: string): Promise<SequenceTemplate> {
  return withMockFallback(
    async () =>
      toSequenceTemplate(
        await api.get<WireTemplate>(
          `/api/v1/voice/templates/${encodeURIComponent(id)}`,
        ),
      ),
    async () => {
      const t = (await loadMocks()).voiceMocks
        .getTemplates()
        .find((x) => x.id === id);
      if (!t) throw new Error(`template not found: ${id}`);
      return t;
    },
  );
}

export function createTemplate(
  t: Omit<SequenceTemplate, "id" | "slug"> & {
    slug: string;
  },
): Promise<SequenceTemplate> {
  return withMockFallback(
    async () =>
      toSequenceTemplate(
        await api.post<WireTemplate>(
          "/api/v1/voice/templates",
          toWireTemplate(t),
        ),
      ),
    () => ({ ...t, id: t.slug }),
  );
}

// ----- Sequences --------------------------------------------------------

export function listSequences(): Promise<SequenceListItem[]> {
  return withMockFallback(
    async () => {
      const rows = await api.get<WireSequence[]>("/api/v1/voice/sequences");
      return rows.map(toSequence).map((s) => ({
        id: s.id,
        name: s.name,
        templateName: s.templateName,
        status: s.status,
        fidelityAvg: s.fidelityAvg,
        updatedAt: s.updatedAt,
        emailCount: s.emails.length,
      }));
    },
    async () => (await loadMocks()).voiceMocks.listSequences(),
  );
}

export function getSequence(id: string): Promise<Sequence> {
  return withMockFallback(
    async () =>
      toSequence(
        await api.get<WireSequence>(
          `/api/v1/voice/sequences/${encodeURIComponent(id)}`,
        ),
      ),
    async () => (await loadMocks()).voiceMocks.getSequence(id),
  );
}

// Sequence send performance (SEQ-009). Defensive normalization: a partial /
// malformed payload never throws — every counter defaults to 0 and positions
// falls back to []. In mock mode a small representative sample is returned.
export function getSequencePerformance(
  id: string,
): Promise<SequencePerformance> {
  return withMockFallback(
    async () =>
      normalizeSequencePerformance(
        await api.get<Partial<SequencePerformance>>(
          `/api/v1/voice/sequences/${encodeURIComponent(id)}/performance`,
        ),
      ),
    async () => ({
      reached: 1240,
      opened: 812,
      clicked: 214,
      positions: [
        { position: 1, reached: 1240, opened: 640, clicked: 150 },
        { position: 2, reached: 1180, opened: 520, clicked: 118 },
        { position: 3, reached: 1090, opened: 430, clicked: 96 },
      ],
    }),
  );
}

function normalizeSequencePerformance(
  payload: Partial<SequencePerformance> | null | undefined,
): SequencePerformance {
  const num = (v: unknown): number =>
    typeof v === "number" && Number.isFinite(v) ? v : 0;
  const rawPositions: unknown[] = Array.isArray(payload?.positions)
    ? (payload.positions as unknown[])
    : [];
  const positions = rawPositions
    .filter(
      (p): p is Record<string, unknown> => p != null && typeof p === "object",
    )
    .map((p) => ({
      position: num(p.position),
      reached: num(p.reached),
      opened: num(p.opened),
      clicked: num(p.clicked),
    }));
  return {
    reached: num(payload?.reached),
    opened: num(payload?.opened),
    clicked: num(payload?.clicked),
    positions,
  };
}

export interface CreateSequenceOptions extends PollOptions {
  onStatus?: (status: GenerationStatus) => void;
}

export async function createSequence(
  req: CreateSequenceRequest,
  opts: CreateSequenceOptions = {},
): Promise<Sequence> {
  // Keep this check outside the live/mock branch so explicit development
  // mocks cannot re-introduce an activation-looking creation path.
  requireDraftCreationStatus(req.status);
  const sequence = await withMockFallback(
    async () => {
      const body: Record<string, unknown> = {
        name:
          req.name ??
          (req.templateId ? `${req.templateId} draft` : "Manual sequence"),
      };
      // Generated requests and manual drafts have separate server schemas.
      // Generated output is still confirmed as draft below, but its input
      // cannot carry the manual authoring-only lifecycle field.
      if (!req.templateId) body.status = "draft";
      if (req.templateId) body.template_id = req.templateId;
      if (req.variables) body.variables = req.variables;
      if (req.style) body.style_controls = toWireStyle(req.style);
      if (req.steps) body.steps = req.steps;
      if (req.goal !== undefined) body.goal = req.goal;
      if (req.stuckAfterDays !== undefined)
        body.stuck_after_days = req.stuckAfterDays;
      const result = await api.post<WireSequence | WireSequenceJobAccepted>(
        "/api/v1/voice/sequences",
        body,
      );
      if (!isSequenceJobAccepted(result)) {
        return toSequence(result);
      }
      const final = await pollSequence(
        result.job_id,
        opts.onStatus ?? (() => {}),
        {
          intervalMs: opts.intervalMs,
          signal: opts.signal,
        },
      );
      if (final.state === "error") {
        throw new Error(final.message || "Sequence generation failed.");
      }
      if (!final.sequenceId) {
        throw new Error("Sequence generation completed without a sequence ID.");
      }
      return getSequence(final.sequenceId);
    },
    async () =>
      (await loadMocks()).voiceMocks.createSequence({
        ...req,
        status: "draft",
      }),
  );
  if (sequence.status !== "draft") {
    throw new Error(
      "The service did not confirm that the new sequence was created as a draft.",
    );
  }
  return sequence;
}

export async function updateSequence(
  seq: Sequence,
  options?: { requireOnline?: boolean },
): Promise<Sequence> {
  // Validate authority before selecting the live or explicit-mock transport.
  // A status string is never sent as part of an authoring save.
  const version = requireEditableSequenceDraft(seq);
  return withMockFallback(
    async () => {
      const steps = mergeEmailsIntoSteps(seq.steps, seq.emails);
      return toConfirmedSequenceMutation(
        await api.patch<WireSequence>(
          `/api/v1/voice/sequences/${encodeURIComponent(seq.id)}`,
          {
            name: seq.name,
            ...(steps ? { steps } : { emails: seq.emails.map(toWireEmail) }),
          },
          {
            headers: { "If-Match": `"${version}"` },
            requireOnline: options?.requireOnline,
          },
        ),
        version,
        "draft",
      );
    },
    async () =>
      requireConfirmedMutation(
        (await loadMocks()).voiceMocks.updateSequence(seq, version),
        version,
        "draft",
      ),
  );
}

// Duplicate an existing sequence into a fresh draft copy. Composed from the
// existing get + create endpoints so it round-trips through both live and mock
// paths. Preserves the ENTIRE step graph (delay/condition/tag/exit), not just
// the email steps, so a branched/timed sequence duplicates faithfully.
export async function duplicateSequence(id: string): Promise<Sequence> {
  const src = await getSequence(id);
  return createSequence({
    name: `${src.name} (copy)`,
    status: "draft",
    steps: stepsForDuplicate(src),
    goal: src.goal,
    stuckAfterDays: src.stuckAfterDays,
  });
}

// Archiving is a draft-only authoring transition. Legacy operational rows are
// retained for review and cannot be mutated through this convenience action.
export async function archiveSequence(id: string): Promise<Sequence> {
  const current = await getSequence(id);
  const version = requireEditableSequenceDraft(current);
  return withMockFallback(
    async () => {
      return toConfirmedSequenceMutation(
        await api.patch<WireSequence>(
          `/api/v1/voice/sequences/${encodeURIComponent(id)}`,
          { status: "archived" },
          { headers: { "If-Match": `"${version}"` } },
        ),
        version,
        "archived",
      );
    },
    async () =>
      requireConfirmedMutation(
        (await loadMocks()).voiceMocks.archiveSequence(id, version),
        version,
        "archived",
      ),
  );
}

// Unarchive is the inverse of the one supported archive transition: it moves a
// stored `archived` row back to an editable `draft`. Version-protected via
// If-Match exactly like archive, and refuses anything that is not currently
// archived. Restoring to draft is safe — a draft neither enrolls nor sends.
export async function unarchiveSequence(id: string): Promise<Sequence> {
  const current = await getSequence(id);
  if (current.status !== "archived") {
    throw new Error(
      "Only an archived sequence can be restored to a draft. Reload and try again.",
    );
  }
  const version = requireSequenceVersion(current);
  return withMockFallback(
    async () => {
      return toConfirmedSequenceMutation(
        await api.patch<WireSequence>(
          `/api/v1/voice/sequences/${encodeURIComponent(id)}`,
          { status: "draft" },
          { headers: { "If-Match": `"${version}"` } },
        ),
        version,
        "draft",
      );
    },
    async () =>
      requireConfirmedMutation(
        (await loadMocks()).voiceMocks.unarchiveSequence(id, version),
        version,
        "draft",
      ),
  );
}

export async function regenerateEmail(
  seqId: string,
  position: number,
  req: RegenerateEmailRequest,
  options: { idempotencyKey: string; signal?: AbortSignal },
): Promise<SequenceEmail> {
  // This endpoint only returns a review candidate. Persistence deliberately
  // remains a separate updateSequence call so acceptance always carries the
  // latest exact sequence version in If-Match.
  const positionSegment = sequencePositionPathSegment(position);
  const idempotencyKey = requireRegenerationIdempotencyKey(
    options.idempotencyKey,
  );
  const candidate = await withMockFallback(
    async () => {
      const result = await api.post<unknown>(
        `/api/v1/voice/sequences/${encodeURIComponent(seqId)}/regenerate/${encodeURIComponent(positionSegment)}`,
        {
          user_hint: req.hint,
          style_controls: req.style ? toWireStyle(req.style) : undefined,
        },
        {
          idempotencyKey,
          requireOnline: true,
          signal: options.signal,
        },
      );
      if (isSequenceJobAccepted(result)) {
        throw new Error(
          "The service returned an asynchronous regeneration job, but web regeneration only accepts a direct, unpersisted review candidate. Nothing was saved.",
        );
      }
      if (!isWireEmailCandidate(result)) {
        throw new Error(
          "The service returned an invalid regeneration candidate. Nothing was saved.",
        );
      }
      return toSequenceEmail(result, seqId);
    },
    async () =>
      (await loadMocks()).voiceMocks.regenerateEmail(seqId, position, req),
  );
  if (candidate.position !== position) {
    throw new Error(
      "The service returned a regeneration candidate for a different email position. Nothing was saved.",
    );
  }
  return candidate;
}

/** Live subject ideas are an aside while typing: a slow answer is no answer. */
const SUBJECT_SUGGESTION_TIMEOUT_MS = 8_000;
/** A generation someone clicked for may take a model this long. */
const GENERATION_TIMEOUT_MS = 30_000;

/**
 * POST /api/v1/voice/generate with the transport generation needs: one
 * attempt, no idempotency key, never queued offline.
 *
 * Generation persists nothing, so there is nothing to make idempotent or to
 * replay later. The default mutation transport minted an Idempotency-Key and
 * therefore retried a failed or slow call up to three times at 15 s each — a
 * voice service that was down meant three 502s per keystroke and up to ~47 s
 * of "Thinking...".
 */
function postVoiceGenerate(
  body: { prompt: string; kind: string; stream: false },
  options: { signal?: AbortSignal; timeoutMs: number },
): Promise<VoiceGenerateResponse> {
  return api.post<VoiceGenerateResponse>("/api/v1/voice/generate", body, {
    idempotencyKey: null,
    maxAttempts: 1,
    requireOnline: true,
    timeoutMs: options.timeoutMs,
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

export function generateSubjectSuggestions(
  subject: string,
  options?: { signal?: AbortSignal },
): Promise<string[]> {
  const prompt =
    `Generate 3 high-performing subject-line alternatives for this draft. ` +
    `Return a numbered list only, one subject per line.\n\nDraft subject: ${subject.trim()}`;
  return withMockFallback(
    async () => {
      const res = await postVoiceGenerate(
        { prompt, kind: "subject_line", stream: false },
        { signal: options?.signal, timeoutMs: SUBJECT_SUGGESTION_TIMEOUT_MS },
      );
      return parseSubjectVariants(res.text ?? "");
    },
    () => [
      "What you signed up for: the short version",
      "A faster way to shape next week",
      "Three things worth opening today",
    ],
  );
}

// Generate a short paragraph "in your voice" so the profile can be sanity-
// checked before committing it to a whole sequence (SEQ-047). Uses the same
// /api/v1/voice/generate surface as subject suggestions.
export function generateVoiceSample(topic: string): Promise<string> {
  const cleaned = topic.trim();
  const prompt =
    `Write one short paragraph (3-4 sentences) in my established voice ` +
    `about the following, so I can check it sounds like me. ` +
    `Return only the paragraph.\n\nTopic: ${cleaned || "a friendly note to my subscribers about what's new"}`;
  return withMockFallback(
    async () => {
      const res = await postVoiceGenerate(
        { prompt, kind: "sample", stream: false },
        { timeoutMs: GENERATION_TIMEOUT_MS },
      );
      return (res.text ?? "").trim();
    },
    () =>
      "Quick note from my desk: we've been heads-down on the thing you asked " +
      "for most, and it's finally ready. No fanfare, just a better version of " +
      "what you already use. Take it for a spin and tell me what still feels off.",
  );
}

/** AI-generated landing hero copy (LAND-036). */
export interface LandingCopy {
  heading: string;
  body: string;
}

/**
 * Generate a landing-page hero headline + subhead from a short brief, reusing
 * the shared /api/v1/voice/generate surface (no new backend). The model is
 * asked for exactly two lines; line 1 is the headline, the rest the subhead.
 */
export function generateLandingCopy(brief: string): Promise<LandingCopy> {
  const cleaned = brief.trim();
  const prompt =
    `Write landing-page hero copy for the following offering. ` +
    `Line 1: a punchy headline (about 4-8 words). ` +
    `Line 2: one supporting subheadline sentence. ` +
    `Return exactly two lines with no labels or quotes.\n\n` +
    `Offering: ${cleaned || "our product"}`;
  return withMockFallback(
    async () => {
      const res = await postVoiceGenerate(
        { prompt, kind: "sample", stream: false },
        { timeoutMs: GENERATION_TIMEOUT_MS },
      );
      const lines = (res.text ?? "")
        .split("\n")
        .map((line) => line.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
      return { heading: lines[0] ?? "", body: lines.slice(1).join(" ") };
    },
    () => ({
      heading: "Ship faster, stress less",
      body: "Everything your team needs to launch and grow, in one place.",
    }),
  );
}

export function getGenerationStatus(id: string): Promise<GenerationStatus> {
  return withMockFallback(
    async () => {
      const job = await api.get<WireSequenceJob>(
        `/api/v1/voice/sequences/jobs/${encodeURIComponent(id)}`,
      );
      return toGenerationStatus(job);
    },
    async () => (await loadMocks()).voiceMocks.getGenerationStatus(id),
  );
}

export interface PollOptions {
  intervalMs?: number;
  signal?: AbortSignal;
}

/**
 * Poll a generation job until it reaches `ready` or `error`.
 * Calls `onUpdate` on every tick (including the terminal one).
 */
export function pollSequence(
  jobId: string,
  onUpdate: (status: GenerationStatus) => void,
  opts: PollOptions = {},
): Promise<GenerationStatus> {
  const intervalMs = clampPollInterval(opts.intervalMs, 1500);
  return new Promise<GenerationStatus>((resolve, reject) => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const cleanup = (): void => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      opts.signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cancelled = true;
      cleanup();
      reject(new DOMException("Polling aborted", "AbortError"));
    };
    if (opts.signal) {
      if (opts.signal.aborted) return onAbort();
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }
    const tick = async () => {
      if (cancelled) return;
      try {
        const status = await getGenerationStatus(jobId);
        if (cancelled) return;
        onUpdate(status);
        if (status.state === "ready" || status.state === "error") {
          cleanup();
          resolve(status);
          return;
        }
        timer = setTimeout(tick, intervalMs);
      } catch (err) {
        cleanup();
        reject(err);
      }
    };
    void tick();
  });
}

function isSequenceJobAccepted(
  value: unknown,
): value is WireSequenceJobAccepted {
  return (
    value !== null &&
    typeof value === "object" &&
    "job_id" in value &&
    typeof value.job_id === "string" &&
    value.job_id.length > 0 &&
    "status" in value &&
    (value.status === "pending" || value.status === "running")
  );
}

function isWireEmailCandidate(value: unknown): value is WireEmail {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Partial<WireEmail>;
  return (
    Number.isSafeInteger(candidate.position) &&
    (candidate.position ?? 0) > 0 &&
    typeof candidate.subject === "string" &&
    typeof candidate.body === "string"
  );
}

function toGenerationStatus(job: WireSequenceJob): GenerationStatus {
  switch (job.status) {
    case "pending":
      return {
        sequenceId: job.sequence_id ?? "",
        state: "queued",
        progress: 10,
        message: "Generation queued…",
      };
    case "running":
      return {
        sequenceId: job.sequence_id ?? "",
        state: "generating",
        progress: 50,
        message: "Generating drafts…",
      };
    case "succeeded":
      return {
        sequenceId: job.sequence_id ?? "",
        state: "ready",
        progress: 100,
        message: "Drafts ready.",
      };
    case "failed":
      return {
        sequenceId: job.sequence_id ?? "",
        state: "error",
        progress: 100,
        message: job.error_message || "Sequence generation failed.",
      };
  }
}

function clampPollInterval(
  value: number | undefined,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value)) return fallback;
  return Math.min(60_000, Math.max(500, Math.floor(value)));
}
