// SPDX-License-Identifier: AGPL-3.0-only
/**
 * lib/ai-chat-api.ts — transport + decoders for the Moosewave AI chat surface
 * (desktop parity: components/ai/PostwaveAIChatPanel.tsx, SavedPromptsCard.tsx,
 * lib/ai-client.ts).
 *
 * The gateway owns `POST /api/v1/voice/generate` (apps/api internal/aichat).
 * It validates the request, passes prompt + `context_text` through a
 * fail-closed PII gateway and makes exactly ONE model call. It always answers
 * with a bounded synchronous JSON receipt `{text, draft?}` — even when the
 * compatibility request carries `stream: true` — so web sends `stream: false`
 * and consumes that receipt. "Stop generation" aborts the in-flight request.
 *
 * Every generation is exactly one attempt: `maxAttempts: 1` and no step-up
 * replay, because a retried POST could invoke the model twice and return a
 * different draft. A retry is always the user's deliberate choice.
 *
 * The server validates `context_refs` but reads only `context_text`, so the
 * client resolves the attached resources itself (as desktop does) from the
 * same list reads the @mention menu uses.
 */
import { api, ApiError } from "@/lib/api";

export type AiChatKind =
  | "campaign_draft"
  | "subject_line"
  | "summary"
  | "free_form";

export type AiContextKind = "campaign" | "sequence" | "form" | "voice_profile";

export interface AiContextRef {
  kind: AiContextKind;
  id: string;
}

export interface AiChatDraft {
  name: string;
  subject: string;
  previewText: string;
  body: string;
}

export interface AiChatReply {
  text: string;
  draft: AiChatDraft | null;
}

/** One attachable workspace resource for the @mention menu. */
export interface AiMentionCandidate {
  kind: Exclude<AiContextKind, "voice_profile">;
  id: string;
  label: string;
  hint: string;
  /** Labeled facts forwarded to the model when this resource is attached. */
  facts: Array<[string, string]>;
}

export interface AiVoiceTemplateStarter {
  id: string;
  label: string;
  prompt: string | null;
}

/** Desktop CHAT_PROMPT_MAX_CHARS. The server caps the prompt at 32 KiB. */
export const AI_CHAT_PROMPT_MAX_CHARS = 8_000;
/** Server contract: at most 20 context refs (one reserved for the voice profile). */
export const AI_CHAT_MAX_CONTEXT_REFS = 20;
const MAX_CONTEXT_CHARS = 12_000;
const MAX_CONTEXT_REF_ID_CHARS = 64;
const MAX_TEMPLATES = 100;

export class AiChatContractError extends Error {
  constructor(detail: string) {
    super(`The AI service returned an unexpected response: ${detail}`);
    this.name = "AiChatContractError";
  }
}

/** Same heuristic desktop uses to choose the server's chat `kind`. */
export function inferAiChatKind(prompt: string): AiChatKind {
  const p = prompt.toLowerCase();
  if (/\bsubject(?:\s*line)?\b/.test(p)) return "subject_line";
  if (/\b(draft|campaign|compose|write|email)\b/.test(p)) {
    return "campaign_draft";
  }
  if (/\b(summari[sz]e|summary|report|performance|recap)\b/.test(p)) {
    return "summary";
  }
  return "free_form";
}

// ---------------------------------------------------------------------------
// Mention tokens: `@[Label](kind:id)` in the composer, `@Label` to the model.
// ---------------------------------------------------------------------------

const MENTION_RE =
  /@\[([^\]\n]{1,120})\]\((campaign|sequence|form):([A-Za-z0-9_-]{1,64})\)/g;

export function mentionToken(candidate: AiMentionCandidate): string {
  const label = candidate.label.replace(/[\]\n\r]/g, " ").slice(0, 120).trim();
  return `@[${label || candidate.kind}](${candidate.kind}:${candidate.id})`;
}

/** Context refs named by the mention tokens in a prompt, de-duplicated. */
export function mentionRefs(prompt: string): AiContextRef[] {
  const refs: AiContextRef[] = [];
  const seen = new Set<string>();
  for (const match of prompt.matchAll(MENTION_RE)) {
    const kind = match[2] as AiMentionCandidate["kind"];
    const id = match[3] ?? "";
    const key = `${kind}:${id}`;
    if (!id || seen.has(key)) continue;
    seen.add(key);
    refs.push({ kind, id });
  }
  return refs;
}

/** Replace `@[Label](kind:id)` with `@Label` so the model reads a name. */
export function stripMentionSyntax(prompt: string): string {
  return prompt.replace(MENTION_RE, (_match, label: string) => `@${label}`);
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, max: number, field: string): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string" || value.length > max) {
    throw new AiChatContractError(`${field} is invalid`);
  }
  return value;
}

export function decodeAiChatReply(raw: unknown): AiChatReply {
  if (!isRecord(raw)) throw new AiChatContractError("the reply is not an object");
  const text = raw.text;
  if (typeof text !== "string" || !text.trim() || text.length > 200_000) {
    throw new AiChatContractError("the reply text is missing");
  }
  let draft: AiChatDraft | null = null;
  if (raw.draft !== undefined && raw.draft !== null) {
    if (!isRecord(raw.draft)) {
      throw new AiChatContractError("the draft is not an object");
    }
    draft = {
      name: boundedString(raw.draft.name, 512, "draft.name"),
      subject: boundedString(raw.draft.subject, 1_000, "draft.subject"),
      previewText: boundedString(
        raw.draft.preview_text,
        2_000,
        "draft.preview_text",
      ),
      body: boundedString(raw.draft.body, 200_000, "draft.body"),
    };
    if (!draft.subject.trim() && !draft.body.trim()) draft = null;
  }
  return { text, draft };
}

export interface AiChatRequest {
  prompt: string;
  kind: AiChatKind;
  contextRefs: readonly AiContextRef[];
  contextText: string;
  signal?: AbortSignal;
}

export async function generateAiChatReply(
  input: AiChatRequest,
): Promise<AiChatReply> {
  const raw = await api.post<unknown>(
    "/api/v1/voice/generate",
    {
      prompt: input.prompt,
      kind: input.kind,
      context_refs: input.contextRefs.map((ref) => ({
        kind: ref.kind,
        id: ref.id,
      })),
      context_text: input.contextText,
      stream: false,
    },
    {
      maxAttempts: 1,
      requireOnline: true,
      allowStepUpRetry: false,
      ...(input.signal ? { signal: input.signal } : {}),
    },
  );
  return decodeAiChatReply(raw);
}

// ---------------------------------------------------------------------------
// Context reads (the @mention menu + the automatic voice-profile reference)
// ---------------------------------------------------------------------------

function rows(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!isRecord(payload)) return [];
  for (const key of ["items", "results", "data", "campaigns", "forms"]) {
    const value = payload[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

function text(value: unknown, max = 200): string {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return "";
  return value
    .replace(/\p{Cc}+/gu, " ")
    .trim()
    .slice(0, max);
}

function candidateId(value: unknown): string | null {
  const id = text(value, MAX_CONTEXT_REF_ID_CHARS + 1);
  return /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : null;
}

export async function listAiChatCampaigns(
  signal?: AbortSignal,
): Promise<AiMentionCandidate[]> {
  const payload = await api.get<unknown>("/api/v1/campaigns", {
    query: { per_page: 40 },
    ...(signal ? { signal } : {}),
  });
  return rows(payload).flatMap((row): AiMentionCandidate[] => {
    if (!isRecord(row)) return [];
    const id = candidateId(row.id);
    if (!id) return [];
    const name = text(row.name);
    const subject = text(row.subject, 1_000);
    const status = text(row.status, 40);
    return [
      {
        kind: "campaign",
        id,
        label: name || subject || `Campaign ${id}`,
        hint: subject && subject !== name ? subject : status,
        facts: [
          ["name", name],
          ["subject", subject],
          ["status", status],
        ],
      },
    ];
  });
}

export async function listAiChatSequences(
  signal?: AbortSignal,
): Promise<AiMentionCandidate[]> {
  const payload = await api.get<unknown>(
    "/api/v1/voice/sequences",
    signal ? { signal } : undefined,
  );
  return rows(payload).flatMap((row): AiMentionCandidate[] => {
    if (!isRecord(row)) return [];
    const id = candidateId(row.id);
    if (!id) return [];
    const name = text(row.name);
    const status = text(row.status, 40);
    const steps = Array.isArray(row.emails)
      ? String(row.emails.length)
      : Array.isArray(row.steps)
        ? String(row.steps.length)
        : "";
    return [
      {
        kind: "sequence",
        id,
        label: name || `Sequence ${id}`,
        hint: status,
        facts: [
          ["name", name],
          ["status", status],
          ["steps", steps],
        ],
      },
    ];
  });
}

export async function listAiChatForms(
  signal?: AbortSignal,
): Promise<AiMentionCandidate[]> {
  const payload = await api.get<unknown>(
    "/api/v1/forms",
    signal ? { signal } : undefined,
  );
  return rows(payload).flatMap((row): AiMentionCandidate[] => {
    if (!isRecord(row)) return [];
    const id = candidateId(row.id);
    if (!id) return [];
    const name = text(row.name);
    const slug = text(row.slug, 120);
    return [
      {
        kind: "form",
        id,
        label: name || slug || `Form ${id}`,
        hint: slug,
        facts: [
          ["name", name],
          ["slug", slug],
        ],
      },
    ];
  });
}

/**
 * The compact derived voice fingerprint, or null when no profile is built.
 * Representative samples, source metadata and embeddings are deliberately
 * dropped (desktop resolveVoiceProfileRef): they add privacy risk and token
 * cost without improving the short style instruction chat needs.
 */
export async function getAiChatVoiceProfile(
  signal?: AbortSignal,
): Promise<Array<[string, string]> | null> {
  let payload: unknown;
  try {
    payload = await api.get<unknown>(
      "/api/v1/voice/profile",
      signal ? { signal } : undefined,
    );
  } catch (err) {
    // 404 is the voice service's "no profile built yet" — a fact, not a fault.
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
  if (!isRecord(payload)) return null;
  const numeric = (value: unknown, keys: string[]): string => {
    if (!isRecord(value)) return "—";
    const out = keys.flatMap((key) => {
      const n = value[key];
      return typeof n === "number" && Number.isFinite(n)
        ? [`${key}=${Number(n.toFixed(3))}`]
        : [];
    });
    return out.length ? out.join(", ") : "—";
  };
  const terms =
    isRecord(payload.vocabulary) && Array.isArray(payload.vocabulary.distinctive_terms)
      ? payload.vocabulary.distinctive_terms
          .flatMap((term) =>
            isRecord(term) && typeof term.term === "string"
              ? [text(term.term, 80)]
              : [],
          )
          .filter(Boolean)
          .slice(0, 6)
      : [];
  return [
    ["built", text(payload.generated_at ?? payload.built_at, 40) || "—"],
    [
      "tonal axes",
      numeric(payload.tonal ?? payload.axes, [
        "humor",
        "optimism",
        "directness",
        "formality",
        "warmth",
      ]),
    ],
    [
      "stylistic signals",
      numeric(payload.stylistic, [
        "avg_sentence_length",
        "avg_paragraph_length",
        "formality_score",
        "passive_voice_pct",
      ]),
    ],
    ["distinctive terms", terms.length ? terms.join(", ") : "—"],
  ];
}

function escapeContext(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function contextBlock(
  kind: AiContextKind,
  id: string,
  facts: ReadonlyArray<readonly [string, string]>,
): string {
  const lines = facts.map(
    ([label, value]) => `${label}: ${escapeContext(value || "—").slice(0, 1_000)}`,
  );
  return `[[${kind}:${id.replace(/[^A-Za-z0-9._+@-]/g, "_")}]]\n${lines.join("\n")}`;
}

/**
 * Labeled context the model reads verbatim from `context_text`. A resource the
 * menu no longer lists becomes an explicit "unavailable" block instead of
 * silently vanishing. Bounded to ~3k tokens like desktop.
 */
export function buildAiChatContextText(
  refs: readonly AiContextRef[],
  candidates: readonly AiMentionCandidate[],
  voiceProfile: ReadonlyArray<readonly [string, string]> | null,
): string {
  const blocks: string[] = [];
  for (const ref of refs) {
    if (ref.kind === "voice_profile") {
      if (voiceProfile) blocks.push(contextBlock(ref.kind, ref.id, voiceProfile));
      continue;
    }
    const found = candidates.find(
      (candidate) => candidate.kind === ref.kind && candidate.id === ref.id,
    );
    blocks.push(
      found
        ? contextBlock(ref.kind, ref.id, found.facts)
        : `[[${ref.kind}:${ref.id}]]\n<error>Resource unavailable.</error>`,
    );
  }
  const joined = blocks.join("\n\n");
  return joined.length > MAX_CONTEXT_CHARS
    ? `${joined.slice(0, MAX_CONTEXT_CHARS)}\n\n…(context truncated)`
    : joined;
}

// ---------------------------------------------------------------------------
// Shared prompt starters (desktop SavedPromptsCard "Shared prompt starters")
// ---------------------------------------------------------------------------

export function decodeAiVoiceTemplateStarters(
  payload: unknown,
): AiVoiceTemplateStarter[] {
  const raw = Array.isArray(payload)
    ? payload
    : isRecord(payload)
      ? ((["templates", "items", "data"] as const)
          .map((key) => payload[key])
          .find(Array.isArray) as unknown[] | undefined)
      : undefined;
  if (!raw || raw.length > MAX_TEMPLATES) {
    throw new AiChatContractError("the voice template list is invalid");
  }
  const ids = new Set<string>();
  return raw.map((candidate) => {
    if (!isRecord(candidate)) {
      throw new AiChatContractError("a voice template is not an object");
    }
    const id = text(candidate.id);
    if (!id || ids.has(id)) {
      throw new AiChatContractError("a voice template id is missing or repeated");
    }
    ids.add(id);
    const name = text(candidate.name) || text(candidate.label);
    const slug = text(candidate.slug);
    const description = text(candidate.description, 2_000);
    const body = text(candidate.body, 4_000);
    return {
      id,
      label: name || slug || "Unnamed template",
      prompt:
        name && description
          ? `Draft a ${name}. ${description}`
          : name || description || body || null,
    };
  });
}

export async function listAiVoiceTemplateStarters(
  signal?: AbortSignal,
): Promise<AiVoiceTemplateStarter[]> {
  const payload = await api.get<unknown>(
    "/api/v1/voice/templates",
    signal ? { signal } : undefined,
  );
  return decodeAiVoiceTemplateStarters(payload);
}
