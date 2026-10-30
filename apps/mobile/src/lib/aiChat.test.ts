import { describe, expect, it } from "vitest";
import { AI_DISCLOSURE_TEXT } from "@postwave/ai-disclosure";

import { utf8ByteLength } from "@/lib/utf8";
import {
  AI_CHAT_PROMPT_MAX_BYTES,
  AI_CHAT_PROMPT_MAX_CHARS,
  aiDraftToCampaignInput,
  AiChatReplyUnreadableError,
  buildAiChatRequest,
  inferAiChatKind,
  parseAiChatReply,
} from "@/lib/aiChat";
import {
  AI_CHAT_RELEASE_HOLD_CODE,
  classifyAiChatFailure,
  type AiChatErrorInput,
  type AiChatFailure,
} from "@/lib/aiChatFailures";
import {
  AI_CHAT_INITIAL_STATE,
  AI_CHAT_MAX_MESSAGES,
  aiChatAccess,
  aiChatDisclosureRequired,
  aiChatReducer,
  aiChatTranscriptRows,
  type AiChatState,
} from "@/lib/aiChatTranscript";

/* ---------- request ------------------------------------------------- */

describe("buildAiChatRequest", () => {
  it("sends the trimmed prompt, an inferred kind, no refs and stream:false", () => {
    const built = buildAiChatRequest({ prompt: "  Write a welcome email  ", tone: "" });
    expect(built).toEqual({
      ok: true,
      body: {
        prompt: "Write a welcome email",
        kind: "campaign_draft",
        context_refs: [],
        context_text: "",
        stream: false,
      },
    });
  });

  it("carries the tone inside the prompt with desktop's [Tone: x] grammar", () => {
    const built = buildAiChatRequest({ prompt: "Say hi", tone: "playful" });
    expect(built.ok && built.body.prompt).toBe("Say hi\n\n[Tone: playful]");
  });

  it("honours an explicit kind over the inferred one", () => {
    const built = buildAiChatRequest({
      prompt: "Write a subject line",
      tone: "",
      kind: "summary",
    });
    expect(built.ok && built.body.kind).toBe("summary");
  });

  it("refuses an empty prompt and one past the field ceiling", () => {
    expect(buildAiChatRequest({ prompt: "   ", tone: "" })).toEqual({
      ok: false,
      reason: "empty",
    });
    expect(
      buildAiChatRequest({
        prompt: "x".repeat(AI_CHAT_PROMPT_MAX_CHARS + 1),
        tone: "",
      }),
    ).toEqual({ ok: false, reason: "too_long" });
  });

  it("keeps the widest prompt the field allows under the server's 32 KiB byte limit", () => {
    // The char ceiling is what protects the byte ceiling: 8,000 three-byte
    // characters plus the longest tone suffix must still clear
    // aichat.go's maxPromptBytes, or every long prompt in a non-Latin
    // script would 413. Raising AI_CHAT_PROMPT_MAX_CHARS past ~10,900 is the
    // regression this pins.
    const wide = "字".repeat(AI_CHAT_PROMPT_MAX_CHARS);
    const built = buildAiChatRequest({ prompt: wide, tone: "authoritative" });
    expect(built.ok).toBe(true);
    expect(built.ok && utf8ByteLength(built.body.prompt)).toBeLessThanOrEqual(
      AI_CHAT_PROMPT_MAX_BYTES,
    );
  });

  it("still refuses a prompt over the byte limit if the char ceiling ever stops covering it", () => {
    // Belt and braces against the case above being loosened: the guard must
    // exist independently of the character count.
    const bytesPerChar = utf8ByteLength("字");
    const overByBytes = Math.ceil(AI_CHAT_PROMPT_MAX_BYTES / bytesPerChar) + 1;
    expect(overByBytes).toBeGreaterThan(AI_CHAT_PROMPT_MAX_CHARS);
    expect(
      buildAiChatRequest({ prompt: "字".repeat(overByBytes), tone: "" }),
    ).toEqual({ ok: false, reason: "too_long" });
  });
});

describe("inferAiChatKind", () => {
  it("matches desktop's inference table", () => {
    expect(inferAiChatKind("Give me a subject line")).toBe("subject_line");
    expect(inferAiChatKind("Draft a win-back campaign")).toBe("campaign_draft");
    expect(inferAiChatKind("Summarise last month")).toBe("summary");
    expect(inferAiChatKind("What is a good send time?")).toBe("free_form");
  });
});

/* ---------- reply --------------------------------------------------- */

describe("parseAiChatReply", () => {
  it("reads text and a draft shaped like aicompose.CampaignDraft", () => {
    expect(
      parseAiChatReply({
        text: "Here is a draft.",
        draft: {
          name: "Spring sale",
          subject: "20% off this week",
          body: "<p>Hi</p>",
          preview_text: "Ends Sunday",
        },
      }),
    ).toEqual({
      text: "Here is a draft.",
      draft: {
        name: "Spring sale",
        subject: "20% off this week",
        body: "<p>Hi</p>",
        previewText: "Ends Sunday",
      },
    });
  });

  it("drops a draft with neither subject nor body and keeps the text", () => {
    expect(parseAiChatReply({ text: "ok", draft: { name: "x" } })).toEqual({
      text: "ok",
      draft: null,
    });
  });

  it("throws on blank text rather than rendering an empty bubble", () => {
    expect(() => parseAiChatReply({ text: "   " })).toThrow(
      AiChatReplyUnreadableError,
    );
    expect(() => parseAiChatReply("not json")).toThrow(
      AiChatReplyUnreadableError,
    );
  });
});

describe("aiDraftToCampaignInput", () => {
  it("needs a subject and derives the name from it when the draft has none", () => {
    expect(
      aiDraftToCampaignInput({
        name: "",
        subject: "  Hello there ",
        body: "<p>x</p>",
        previewText: " p ",
      }),
    ).toEqual({
      name: "Hello there",
      subject: "Hello there",
      previewText: "p",
      bodyHtml: "<p>x</p>",
    });
    expect(
      aiDraftToCampaignInput({ name: "n", subject: " ", body: "b", previewText: "" }),
    ).toBeNull();
  });
});

/* ---------- failures ------------------------------------------------ */

function err(over: Partial<AiChatErrorInput> = {}): AiChatErrorInput {
  return { status: 500, message: "HTTP 500", ...over };
}

describe("classifyAiChatFailure", () => {
  it("renders the release hold verbatim even though the SDK dropped its code", () => {
    // The SDK's parseErrorBody keeps only `message` from the flat
    // `{error, code}` body and substitutes `http_503` — the code has to be
    // recovered from the payload or the hold reads as a generic 503.
    const out = classifyAiChatFailure(
      err({
        status: 503,
        code: "http_503",
        message: "the in-app agent is release-held",
        payload: {
          error: "the in-app agent is release-held",
          code: AI_CHAT_RELEASE_HOLD_CODE,
        },
        requestId: "req-1",
      }),
    );
    expect(out).toEqual({
      kind: "held",
      message: "the in-app agent is release-held",
      retryable: false,
      requestId: "req-1",
      code: AI_CHAT_RELEASE_HOLD_CODE,
    });
  });

  it("treats a capability envelope as a product boundary, not a fault", () => {
    const out = classifyAiChatFailure(
      err({
        status: 503,
        message: "AI chat is switched off for this deployment.",
        capability: "ai_chat",
        runtimeStatus: "unavailable",
        retryable: false,
      }),
    );
    expect(out.kind).toBe("unavailable");
    expect(out.retryable).toBe(false);
    expect(out.message).toBe("AI chat is switched off for this deployment.");
  });

  it("uses the classified denial sentence and its retryability", () => {
    const out = classifyAiChatFailure(
      err({
        status: 403,
        message: "forbidden",
        denial: { reason: "role", requiredRole: "editor" } as never,
      }),
    );
    expect(out.kind).toBe("denied");
    expect(out.message).toContain("editor");
    expect(out.retryable).toBe(false);
  });

  it("maps a bare 403 to the editor floor this route mounts", () => {
    const out = classifyAiChatFailure(err({ status: 403, message: "HTTP 403" }));
    expect(out.kind).toBe("denied");
    expect(out.message).toMatch(/editor access/u);
    expect(out.retryable).toBe(false);
  });

  it("tells a cancel, a timeout and a dead network apart", () => {
    expect(
      classifyAiChatFailure(err({ status: 0, code: "request_aborted", message: "Request was cancelled" })).kind,
    ).toBe("cancelled");
    const timeout = classifyAiChatFailure(
      err({ status: 0, code: "request_timeout", message: "Request timed out" }),
    );
    expect(timeout.kind).toBe("timeout");
    expect(timeout.message).toMatch(/30 seconds/u);
    expect(
      classifyAiChatFailure(err({ status: 0, message: "Network request failed" })).kind,
    ).toBe("offline");
  });

  it("echoes the server's validation sentence and does not offer a retry", () => {
    const out = classifyAiChatFailure(
      err({ status: 413, code: "prompt_too_large", message: "prompt exceeds the permitted size" }),
    );
    expect(out).toMatchObject({
      kind: "invalid",
      message: "prompt exceeds the permitted size",
      retryable: false,
      code: "prompt_too_large",
    });
  });

  it("names the wait on a 429 when the server sent one", () => {
    expect(
      classifyAiChatFailure(err({ status: 429, message: "HTTP 429", retryAfterSeconds: 12 })).message,
    ).toMatch(/12 seconds/u);
  });

  it("keeps the status on a normalised 5xx and stays retryable", () => {
    const out = classifyAiChatFailure(
      err({ status: 503, code: "internal_error", message: "an internal error occurred", requestId: "r9" }),
    );
    expect(out.kind).toBe("failed");
    expect(out.message).toMatch(/unavailable.*\(HTTP 503\)/u);
    expect(out.retryable).toBe(true);
    expect(out.requestId).toBe("r9");
  });
});

/* ---------- state machine ------------------------------------------- */

const SEND = {
  type: "send" as const,
  userId: "u1",
  assistantId: "a1",
  prompt: "Write a welcome email",
  tone: "friendly" as const,
  kind: "campaign_draft" as const,
  at: 1_000,
};

const FAILED: AiChatFailure = {
  kind: "failed",
  message: "The AI could not complete this reply. (HTTP 502)",
  retryable: true,
  requestId: null,
  code: null,
};

function sent(): AiChatState {
  return aiChatReducer(AI_CHAT_INITIAL_STATE, SEND);
}

describe("aiChatReducer", () => {
  it("send appends a done user turn and a pending assistant turn", () => {
    const state = sent();
    expect(state.pendingId).toBe("a1");
    expect(state.messages.map((m) => [m.role, m.status])).toEqual([
      ["user", "done"],
      ["assistant", "pending"],
    ]);
    expect(state.messages[1]).toMatchObject({
      sourcePrompt: "Write a welcome email",
      sourceTone: "friendly",
      kind: "campaign_draft",
      text: "",
    });
  });

  it("ignores a second send while one turn is in flight (one model call per tap)", () => {
    const state = sent();
    const again = aiChatReducer(state, { ...SEND, userId: "u2", assistantId: "a2" });
    expect(again).toBe(state);
  });

  it("ignores a blank send", () => {
    expect(aiChatReducer(AI_CHAT_INITIAL_STATE, { ...SEND, prompt: "  " })).toBe(
      AI_CHAT_INITIAL_STATE,
    );
  });

  it("reply lands the whole text and draft on the pending turn only", () => {
    const state = aiChatReducer(sent(), {
      type: "reply",
      assistantId: "a1",
      reply: { text: "Hello!", draft: null },
      requestId: "req-7",
    });
    expect(state.pendingId).toBeNull();
    expect(state.messages[1]).toMatchObject({
      status: "done",
      text: "Hello!",
      requestId: "req-7",
      failure: null,
    });
    // A reply for a turn that is not pending is dropped, not applied.
    const stray = aiChatReducer(state, {
      type: "reply",
      assistantId: "a1",
      reply: { text: "late", draft: null },
      requestId: null,
    });
    expect(stray).toBe(state);
  });

  it("fail marks the pending turn failed and keeps its prompt for retry", () => {
    const state = aiChatReducer(sent(), { type: "fail", assistantId: "a1", failure: FAILED });
    expect(state.pendingId).toBeNull();
    expect(state.messages[1]).toMatchObject({
      status: "failed",
      failure: FAILED,
      sourcePrompt: "Write a welcome email",
    });
    expect(state.hold).toBeNull();
  });

  it("a held failure is sticky and blocks further sends and retries", () => {
    const held: AiChatFailure = { ...FAILED, kind: "held", retryable: false, message: "the in-app agent is release-held" };
    const state = aiChatReducer(sent(), { type: "fail", assistantId: "a1", failure: held });
    expect(state.hold).toEqual(held);
    expect(aiChatReducer(state, { ...SEND, userId: "u2", assistantId: "a2" })).toBe(state);
    expect(aiChatReducer(state, { type: "retry", assistantId: "a1", at: 2 })).toBe(state);
    expect(aiChatReducer(state, { type: "clear" }).hold).toBeNull();
  });

  it("retry re-arms a failed turn and regenerate re-arms a done one", () => {
    const failed = aiChatReducer(sent(), { type: "fail", assistantId: "a1", failure: FAILED });
    const retried = aiChatReducer(failed, { type: "retry", assistantId: "a1", at: 2_000 });
    expect(retried.pendingId).toBe("a1");
    expect(retried.messages[1]).toMatchObject({ status: "pending", text: "", failure: null, createdAt: 2_000 });

    const done = aiChatReducer(sent(), {
      type: "reply",
      assistantId: "a1",
      reply: { text: "v1", draft: { name: "", subject: "s", body: "b", previewText: "" } },
      requestId: null,
    });
    const regenerated = aiChatReducer(done, { type: "retry", assistantId: "a1", at: 3_000 });
    expect(regenerated.pendingId).toBe("a1");
    expect(regenerated.messages[1]).toMatchObject({ status: "pending", text: "", draft: null });
  });

  it("never retries a user turn, a pending turn, or while another turn is pending", () => {
    const state = sent();
    expect(aiChatReducer(state, { type: "retry", assistantId: "u1", at: 1 })).toBe(state);
    expect(aiChatReducer(state, { type: "retry", assistantId: "a1", at: 1 })).toBe(state);
  });

  it("cancel fails the pending turn as cancelled and a late reply is then ignored", () => {
    const cancelled = aiChatReducer(sent(), { type: "cancel" });
    expect(cancelled.pendingId).toBeNull();
    expect(cancelled.messages[1]?.failure?.kind).toBe("cancelled");
    expect(cancelled.messages[1]?.failure?.retryable).toBe(true);
    const late = aiChatReducer(cancelled, {
      type: "reply",
      assistantId: "a1",
      reply: { text: "too late", draft: null },
      requestId: null,
    });
    expect(late).toBe(cancelled);
    expect(aiChatReducer(AI_CHAT_INITIAL_STATE, { type: "cancel" })).toBe(AI_CHAT_INITIAL_STATE);
  });

  it("bounds the transcript by dropping the oldest turns, never the pending pair", () => {
    let state = AI_CHAT_INITIAL_STATE;
    // Exactly full: AI_CHAT_MAX_MESSAGES / 2 completed pairs.
    for (let i = 0; i < AI_CHAT_MAX_MESSAGES / 2; i += 1) {
      state = aiChatReducer(state, { ...SEND, userId: `u${i}`, assistantId: `a${i}`, prompt: `p${i}` });
      state = aiChatReducer(state, { type: "reply", assistantId: `a${i}`, reply: { text: "r", draft: null }, requestId: null });
    }
    expect(state.messages).toHaveLength(AI_CHAT_MAX_MESSAGES);
    expect(state.messages[0]?.id).toBe("u0");
    state = aiChatReducer(state, { ...SEND, userId: "last-u", assistantId: "last-a" });
    // One pair in, the OLDEST pair out — never the one just sent.
    expect(state.messages).toHaveLength(AI_CHAT_MAX_MESSAGES);
    expect(state.messages[0]?.id).toBe("u1");
    expect(state.messages.at(-2)?.id).toBe("last-u");
    expect(state.messages.at(-1)?.id).toBe("last-a");
    expect(state.pendingId).toBe("last-a");
  });
});

/* ---------- access + disclosure -------------------------------------- */

const OPEN = { hold: null, hasTenant: true, gateEnabled: true, online: true, canWrite: true };

describe("aiChatAccess", () => {
  it("is ready only when every gate is open", () => {
    expect(aiChatAccess(OPEN)).toEqual({ kind: "ready" });
  });

  it("ranks the hold above everything and renders the server's sentence", () => {
    const hold: AiChatFailure = { kind: "held", message: "the in-app agent is release-held", retryable: false, requestId: null, code: AI_CHAT_RELEASE_HOLD_CODE };
    expect(aiChatAccess({ ...OPEN, hold, canWrite: false, online: false })).toEqual({
      kind: "held",
      message: "the in-app agent is release-held",
    });
  });

  it("orders no-tenant, then offline (gate OR reachability), then role", () => {
    expect(aiChatAccess({ ...OPEN, hasTenant: false, online: false, canWrite: false }).kind).toBe("no_tenant");
    expect(aiChatAccess({ ...OPEN, gateEnabled: false, canWrite: false }).kind).toBe("offline");
    expect(aiChatAccess({ ...OPEN, online: false }).kind).toBe("offline");
    expect(aiChatAccess({ ...OPEN, canWrite: false }).kind).toBe("role");
  });
});

describe("Article 50 disclosure gating", () => {
  it("is required before the first turn on a usable screen", () => {
    expect(aiChatDisclosureRequired({ messages: [], canSend: true })).toBe(true);
  });

  it("is required for as long as any turn is on screen, even once blocked", () => {
    expect(aiChatDisclosureRequired({ messages: sent().messages, canSend: false })).toBe(true);
  });

  it("is not forced on a blocked, empty screen", () => {
    expect(aiChatDisclosureRequired({ messages: [], canSend: false })).toBe(false);
  });

  it("puts the package constant, byte for byte, ABOVE every message row", () => {
    const rows = aiChatTranscriptRows(sent().messages, { canSend: true });
    expect(rows[0]).toEqual({ kind: "disclosure", id: "disclosure", text: AI_DISCLOSURE_TEXT });
    expect(rows.slice(1).map((r) => r.kind)).toEqual(["message", "message"]);
    expect(aiChatTranscriptRows([], { canSend: false })).toEqual([]);
  });
});
