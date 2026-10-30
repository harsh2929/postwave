// SPDX-License-Identifier: AGPL-3.0-only
//
// Transport contract for lib/ai-chat-api (parity rows messaging-52 / -70):
// exact paths, one-attempt generation, strict reply decoding, and the context
// block the model reads.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(async (_path: string, _opts?: unknown): Promise<unknown> => []),
  post: vi.fn(
    async (_path: string, _body?: unknown, _opts?: unknown): Promise<unknown> => ({
      text: "ok",
    }),
  ),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: { ...actual.api, get: mocks.get, post: mocks.post } };
});

import {
  AiChatContractError,
  buildAiChatContextText,
  decodeAiVoiceTemplateStarters,
  generateAiChatReply,
  getAiChatVoiceProfile,
  listAiChatCampaigns,
  listAiChatForms,
  listAiChatSequences,
  mentionRefs,
  stripMentionSyntax,
} from "@/lib/ai-chat-api";
import { ApiError } from "@/lib/api";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("generateAiChatReply", () => {
  it("POSTs one non-streaming, non-replayable request and decodes the draft", async () => {
    mocks.post.mockResolvedValueOnce({
      text: "Draft ready",
      draft: { name: "Spring", subject: "Hello", preview_text: "Hi", body: "<p>x</p>" },
    });
    const controller = new AbortController();
    const reply = await generateAiChatReply({
      prompt: "Draft spring",
      kind: "campaign_draft",
      contextRefs: [{ kind: "form", id: "f-1" }],
      contextText: "[[form:f-1]]",
      signal: controller.signal,
    });
    expect(mocks.post).toHaveBeenCalledWith(
      "/api/v1/voice/generate",
      {
        prompt: "Draft spring",
        kind: "campaign_draft",
        context_refs: [{ kind: "form", id: "f-1" }],
        context_text: "[[form:f-1]]",
        stream: false,
      },
      {
        maxAttempts: 1,
        requireOnline: true,
        allowStepUpRetry: false,
        signal: controller.signal,
      },
    );
    expect(reply).toEqual({
      text: "Draft ready",
      draft: { name: "Spring", subject: "Hello", previewText: "Hi", body: "<p>x</p>" },
    });
  });

  it("refuses a receipt without text instead of rendering an empty reply", async () => {
    mocks.post.mockResolvedValueOnce({ text: "   " });
    await expect(
      generateAiChatReply({
        prompt: "x",
        kind: "free_form",
        contextRefs: [],
        contextText: "",
      }),
    ).rejects.toBeInstanceOf(AiChatContractError);
  });
});

describe("context reads", () => {
  it("reads the three mention sources and the voice profile from their mounted routes", async () => {
    mocks.get.mockImplementation(async (path: string) => {
      if (path === "/api/v1/campaigns") return [{ id: 7, name: "Launch", subject: "Go", status: "sent" }];
      if (path === "/api/v1/voice/sequences") return [{ id: "s-1", name: "Welcome", status: "active", emails: [{}] }];
      if (path === "/api/v1/forms") return [{ id: "f-1", name: "Signup", slug: "signup" }];
      if (path === "/api/v1/voice/profile") throw new ApiError("not found", 404);
      throw new Error(path);
    });
    const [campaigns, sequences, forms, profile] = await Promise.all([
      listAiChatCampaigns(),
      listAiChatSequences(),
      listAiChatForms(),
      getAiChatVoiceProfile(),
    ]);
    expect(mocks.get).toHaveBeenCalledWith("/api/v1/campaigns", { query: { per_page: 40 } });
    expect(campaigns[0]).toMatchObject({ kind: "campaign", id: "7", label: "Launch", hint: "Go" });
    expect(sequences[0]).toMatchObject({ kind: "sequence", id: "s-1", hint: "active" });
    expect(forms[0]).toMatchObject({ kind: "form", id: "f-1", hint: "signup" });
    expect(profile).toBeNull();
  });

  it("labels each attached resource, flags a vanished one, and escapes markup", () => {
    const text = buildAiChatContextText(
      [
        { kind: "campaign", id: "7" },
        { kind: "form", id: "gone" },
      ],
      [
        {
          kind: "campaign",
          id: "7",
          label: "Launch",
          hint: "",
          facts: [["subject", "<b>Go</b>"]],
        },
      ],
      null,
    );
    expect(text).toBe(
      "[[campaign:7]]\nsubject: &lt;b&gt;Go&lt;/b&gt;\n\n[[form:gone]]\n<error>Resource unavailable.</error>",
    );
  });

  it("turns mention tokens into refs and model-readable names", () => {
    const prompt = "Compare @[Launch](campaign:7) with @[Launch](campaign:7) and @[Signup](form:f-1)";
    expect(mentionRefs(prompt)).toEqual([
      { kind: "campaign", id: "7" },
      { kind: "form", id: "f-1" },
    ]);
    expect(stripMentionSyntax(prompt)).toBe("Compare @Launch with @Launch and @Signup");
  });
});

describe("voice template starters", () => {
  it("renders name + description as a prompt opener and rejects duplicate ids", () => {
    expect(
      decodeAiVoiceTemplateStarters({
        templates: [{ id: "t1", name: "Welcome", description: "Warm hello." }],
      }),
    ).toEqual([{ id: "t1", label: "Welcome", prompt: "Draft a Welcome. Warm hello." }]);
    expect(() =>
      decodeAiVoiceTemplateStarters([{ id: "t1" }, { id: "t1" }]),
    ).toThrow(AiChatContractError);
  });
});
