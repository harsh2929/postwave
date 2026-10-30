/**
 * lib/aiChat.ts — the WIRE half of the Moosewave AI chat screen: what goes to
 * POST /api/v1/voice/generate and what comes back. Failures are classified in
 * lib/aiChatFailures; the transcript state machine, access policy and the
 * Article 50 placement live in lib/aiChatTranscript.
 *
 * SERVER TRUTH (verified against apps/api/internal/aichat/aichat.go):
 *   POST /api/v1/voice/generate — mounted at aichat.go:113-114 behind
 *   `apikeys.RequireScope(apikeys.ScopeWriteCampaigns)`; routeauth/manifest.json
 *   records session_minimum_role "editor", api_key scope write:campaigns,
 *   review_status "reviewed". No release gate on this route.
 *
 *   Request  `{prompt, kind?, context_refs?, context_text?, stream?}`.
 *   Response `{text, draft?}` — ALWAYS synchronous JSON. The package doc says
 *   so in its first sentence: it "deliberately returns bounded synchronous JSON
 *   even when the compatibility request carries stream=true", because every
 *   model call must pass the fail-closed PII gateway before a byte is
 *   accepted. So this screen is designed around SEND → WAIT → WHOLE REPLY, and
 *   not around React Native's lack of a streaming fetch body: there is nothing
 *   to stream. `stream: false` is sent explicitly to say so on the wire.
 *
 *   Limits mirrored here: prompt ≤ 32 KiB (maxPromptBytes), kinds are exactly
 *   {campaign_draft, subject_line, summary, free_form}. `context_refs` are
 *   VALIDATED by the handler and then not forwarded — only `context_text`
 *   reaches `Voice.Generate` (aichat.go:141-147) — so this screen sends none
 *   rather than offering an @-mention that attaches nothing.
 *
 * No react-native / expo import: vitest runs this in node.
 */
import { suggestedCampaignName } from "@/lib/campaignCreate";
import { utf8ByteLength } from "@/lib/utf8";

/* ---------- wire constants ------------------------------------------ */

export const AI_CHAT_PATH = "/api/v1/voice/generate";
/** Desktop's CHAT_PROMPT_MAX_CHARS (PostwaveAI.tsx) — the same field ceiling. */
export const AI_CHAT_PROMPT_MAX_CHARS = 8_000;
/** aichat.go `maxPromptBytes`: the server refuses more with 413. */
export const AI_CHAT_PROMPT_MAX_BYTES = 32 * 1024;

export type AiChatKind =
  | "campaign_draft"
  | "subject_line"
  | "summary"
  | "free_form";

export type AiChatTone =
  | ""
  | "friendly"
  | "direct"
  | "authoritative"
  | "playful"
  | "educational"
  | "urgent";

/** Mirrors desktop's TonePicker TONE_OPTIONS so the two surfaces agree. */
export const AI_CHAT_TONES: readonly {
  value: AiChatTone;
  label: string;
  hint: string;
}[] = [
  { value: "", label: "Auto", hint: "Use voice profile default" },
  { value: "friendly", label: "Friendly", hint: "Warm, casual" },
  { value: "direct", label: "Direct", hint: "Punchy, no fluff" },
  { value: "authoritative", label: "Authoritative", hint: "Expert, confident" },
  { value: "playful", label: "Playful", hint: "Witty, light" },
  { value: "educational", label: "Educational", hint: "Explain & teach" },
  { value: "urgent", label: "Urgent", hint: "Time-sensitive" },
];

/* ---------- request ------------------------------------------------- */

export interface AiChatRequestBody {
  prompt: string;
  kind: AiChatKind;
  context_refs: never[];
  context_text: string;
  stream: false;
}

export type AiChatRequestBuild =
  | { ok: true; body: AiChatRequestBody }
  | { ok: false; reason: "empty" | "too_long" };

/** Desktop's `inferKind`, verbatim, so one prompt means one kind everywhere. */
export function inferAiChatKind(prompt: string): AiChatKind {
  const p = prompt.toLowerCase();
  if (/\bsubject(?:\s*line)?\b/u.test(p)) return "subject_line";
  if (/\b(draft|campaign|compose|write|email)\b/u.test(p)) {
    return "campaign_draft";
  }
  if (/\b(summari[sz]e|summary|report|performance|recap)\b/u.test(p)) {
    return "summary";
  }
  return "free_form";
}

/**
 * The tone travels INSIDE the prompt (`[Tone: x]`), the grammar desktop's
 * runPrompt uses — the handler has no tone field, so this is the only place
 * it can go. The byte check runs on the prompt the server will receive,
 * suffix included.
 */
export function buildAiChatRequest(input: {
  prompt: string;
  tone: AiChatTone;
  kind?: AiChatKind;
}): AiChatRequestBuild {
  const prompt = input.prompt.trim();
  if (!prompt) return { ok: false, reason: "empty" };
  if (prompt.length > AI_CHAT_PROMPT_MAX_CHARS) {
    return { ok: false, reason: "too_long" };
  }
  const wire = input.tone ? `${prompt}\n\n[Tone: ${input.tone}]` : prompt;
  if (utf8ByteLength(wire) > AI_CHAT_PROMPT_MAX_BYTES) {
    return { ok: false, reason: "too_long" };
  }
  return {
    ok: true,
    body: {
      prompt: wire,
      kind: input.kind ?? inferAiChatKind(prompt),
      context_refs: [],
      context_text: "",
      stream: false,
    },
  };
}

/* ---------- reply --------------------------------------------------- */

export interface AiChatDraft {
  name: string;
  subject: string;
  body: string;
  previewText: string;
}

export interface AiChatReply {
  text: string;
  draft: AiChatDraft | null;
}

export class AiChatReplyUnreadableError extends Error {
  constructor(detail: string) {
    super(`AI chat reply unreadable: ${detail}`);
    this.name = "AiChatReplyUnreadableError";
  }
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * `{text, draft?}` per aichat.go `response`. The handler's own
 * validateResponse guarantees non-blank text and a draft with a subject or a
 * body; anything else reaching here is a shape drift, and a silently-empty
 * bubble is the failure the mobile logic audit named as the dominant class.
 */
export function parseAiChatReply(raw: unknown): AiChatReply {
  if (!raw || typeof raw !== "object") {
    throw new AiChatReplyUnreadableError("body is not an object");
  }
  const body = raw as Record<string, unknown>;
  const text = str(body.text);
  if (!text.trim()) throw new AiChatReplyUnreadableError("text is blank");
  let draft: AiChatDraft | null = null;
  if (body.draft && typeof body.draft === "object") {
    const d = body.draft as Record<string, unknown>;
    const candidate: AiChatDraft = {
      name: str(d.name),
      subject: str(d.subject),
      body: str(d.body),
      previewText: str(d.preview_text),
    };
    if (candidate.subject.trim() || candidate.body.trim()) draft = candidate;
  }
  return { text, draft };
}

/**
 * What a draft becomes when it is handed to Campaigns. The create contract
 * (lib/campaignCreate) needs a non-empty subject, so a body-only draft is
 * copyable but not creatable — the card offers what the server can take.
 */
export function aiDraftToCampaignInput(draft: AiChatDraft): {
  name: string;
  subject: string;
  previewText: string;
  bodyHtml: string;
} | null {
  const subject = draft.subject.trim();
  if (!subject) return null;
  const name = draft.name.trim() || suggestedCampaignName(subject);
  return {
    name,
    subject,
    previewText: draft.previewText.trim(),
    bodyHtml: draft.body,
  };
}
