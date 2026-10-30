/**
 * api/aiChat.ts — the Moosewave AI chat screen's two writes.
 *
 *   POST /api/v1/voice/generate  — one chat turn (apps/api/internal/aichat)
 *   POST /api/v1/campaigns       — hand a returned draft to Campaigns
 *
 * SEND → WAIT → WHOLE REPLY. The aichat handler answers synchronous JSON for
 * every request, `stream: true` included (aichat.go package doc), so there is
 * no event stream to consume and the SDK's ordinary JSON path is the right
 * transport. This is a property of the SERVER, not a workaround for React
 * Native's fetch — the app streams elsewhere through `expo/fetch`
 * (api/aiGenerate.ts); it just has nothing to stream here.
 *
 * ONE WIRE ATTEMPT, DELIBERATELY. The SDK auto-mints an `Idempotency-Key` for
 * every POST, and its retry policy treats a keyed POST as safe to re-send on a
 * 5xx or a timeout. A model call re-sent behind the person's back is a second
 * charge to the workspace's AI budget — and a timeout says nothing about
 * whether the first call is still running. So `maxAttempts: 1`: the reply
 * arrives once or fails once, and the retry is a finger on a button.
 *
 * Parsing lives in lib/aiChat so the shape rules are testable in node; this
 * module is transport only.
 */
import {
  AI_CHAT_PATH,
  aiDraftToCampaignInput,
  parseAiChatReply,
  type AiChatDraft,
  type AiChatReply,
  type AiChatRequestBody,
} from "@/lib/aiChat";
import { campaignCreatePayload } from "@/lib/campaignCreate";

import { rawRequest, sdkResource, type AIApiResult } from "./request";

export const AI_CHAT_REPLY_UNREADABLE_CODE = "ai_chat_reply_unreadable";
export const AI_DRAFT_SUBJECT_REQUIRED_CODE = "ai_draft_subject_required";

export async function sendAiChat(
  body: AiChatRequestBody,
  options: { signal?: AbortSignal } = {},
): Promise<AIApiResult<AiChatReply>> {
  const res = await sdkResource((client) =>
    client.request<unknown>("POST", AI_CHAT_PATH, {
      body,
      maxAttempts: 1,
      ...(options.signal ? { signal: options.signal } : {}),
    }),
  );
  if (res.error) return res;
  try {
    return { data: parseAiChatReply(res.data), error: null };
  } catch (err) {
    return {
      data: null,
      error: {
        status: 200,
        message: err instanceof Error ? err.message : String(err),
        code: AI_CHAT_REPLY_UNREADABLE_CODE,
      },
    };
  }
}

export interface CreatedCampaignFromDraft {
  id: string;
  name?: string;
  subject?: string;
  status?: string;
}

/**
 * The draft becomes a campaign the same way the create sheet makes one
 * (lib/campaignCreate builds the payload) plus the body the model wrote —
 * `body_html` with `editor_mode: "html"`, both accepted by
 * campaigns/authoring_input.go and validated by `validEditorMode`
 * (handlers.go:910). The body already carries the Article 50 marker: the
 * aichat handler runs `aidisclosure.MarkHTML` over it before replying.
 *
 * A subject-less draft is refused LOCALLY, before a round trip the server
 * could only 422.
 */
export async function createCampaignFromAiDraft(
  draft: AiChatDraft,
): Promise<AIApiResult<CreatedCampaignFromDraft>> {
  const input = aiDraftToCampaignInput(draft);
  if (!input) {
    return {
      data: null,
      error: {
        status: 0,
        message:
          "This draft has no subject line yet, so it cannot become a campaign. Copy the text instead.",
        code: AI_DRAFT_SUBJECT_REQUIRED_CODE,
      },
    };
  }
  return rawRequest<CreatedCampaignFromDraft>("POST", "/api/v1/campaigns", {
    ...campaignCreatePayload({
      name: input.name,
      subject: input.subject,
      previewText: input.previewText,
    }),
    ...(input.bodyHtml.trim()
      ? { body_html: input.bodyHtml, editor_mode: "html" }
      : {}),
  });
}
