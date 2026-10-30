/**
 * The transport seam for the AI chat — pinned because it is exactly the kind
 * of thing parser tests and mocked-hook tests both leave uncovered.
 *
 *  - the path and verb the SDK is handed;
 *  - `maxAttempts: 1`, so a timed-out or 5xx model call is NEVER re-sent by
 *    the client (the SDK auto-mints an Idempotency-Key for POST, which would
 *    otherwise make its retry policy consider a re-send safe);
 *  - an unreadable 200 body becomes a typed error, not a blank bubble;
 *  - a draft reaches Campaigns as body_html/editor_mode:"html", and a
 *    subject-less draft is refused before any request.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createCampaignFromAiDraft, sendAiChat } from "./aiChat";

const mocks = vi.hoisted(() => ({
  sdkResource: vi.fn(),
  rawRequest: vi.fn(),
}));
vi.mock("./request", () => ({
  sdkResource: (...args: unknown[]) => mocks.sdkResource(...args),
  rawRequest: (...args: unknown[]) => mocks.rawRequest(...args),
}));
const { sdkResource, rawRequest } = mocks;

beforeEach(() => {
  sdkResource.mockReset();
  rawRequest.mockReset();
});

const BODY = {
  prompt: "Say hi",
  kind: "free_form" as const,
  context_refs: [] as never[],
  context_text: "",
  stream: false as const,
};

type SdkRequest = (
  method: string,
  path: string,
  options: Record<string, unknown>,
) => Promise<unknown>;

describe("sendAiChat", () => {
  it("POSTs the body to /api/v1/voice/generate with exactly one wire attempt", async () => {
    const request = vi.fn<SdkRequest>(async () => ({ text: "Hello" }));
    sdkResource.mockImplementation(
      async (call: (client: { request: typeof request }) => Promise<unknown>) => ({
        data: await call({ request }),
        error: null,
      }),
    );
    const signal = new AbortController().signal;

    const res = await sendAiChat(BODY, { signal });

    expect(request).toHaveBeenCalledWith("POST", "/api/v1/voice/generate", {
      body: BODY,
      maxAttempts: 1,
      signal,
    });
    expect(res).toEqual({ data: { text: "Hello", draft: null }, error: null });
  });

  it("omits the signal key when none is given (exactOptionalPropertyTypes)", async () => {
    const request = vi.fn<SdkRequest>(async () => ({ text: "Hello" }));
    sdkResource.mockImplementation(
      async (call: (client: { request: typeof request }) => Promise<unknown>) => ({
        data: await call({ request }),
        error: null,
      }),
    );

    await sendAiChat(BODY);

    expect(request.mock.calls[0]?.[2]).toEqual({ body: BODY, maxAttempts: 1 });
  });

  it("passes a transport error through untouched", async () => {
    const error = { status: 503, message: "an internal error occurred", code: "internal_error" };
    sdkResource.mockResolvedValue({ data: null, error });

    expect(await sendAiChat(BODY)).toEqual({ data: null, error });
  });

  it("turns an unreadable 200 body into a typed error", async () => {
    sdkResource.mockResolvedValue({ data: { text: "" }, error: null });

    const res = await sendAiChat(BODY);

    expect(res.data).toBeNull();
    expect(res.error).toMatchObject({ status: 200, code: "ai_chat_reply_unreadable" });
  });
});

describe("createCampaignFromAiDraft", () => {
  it("hands the draft to Campaigns as an html-mode body", async () => {
    rawRequest.mockResolvedValue({ data: { id: "c1" }, error: null });

    const res = await createCampaignFromAiDraft({
      name: "",
      subject: "20% off",
      body: "<p>Hi</p>",
      previewText: "Ends Sunday",
    });

    expect(rawRequest).toHaveBeenCalledWith("POST", "/api/v1/campaigns", {
      name: "20% off",
      subject: "20% off",
      preview_text: "Ends Sunday",
      body_html: "<p>Hi</p>",
      editor_mode: "html",
    });
    expect(res).toEqual({ data: { id: "c1" }, error: null });
  });

  it("leaves editor_mode to the server when the draft has no body", async () => {
    rawRequest.mockResolvedValue({ data: { id: "c2" }, error: null });

    await createCampaignFromAiDraft({ name: "n", subject: "s", body: "  ", previewText: "" });

    expect(rawRequest.mock.calls[0]?.[2]).toEqual({ name: "n", subject: "s" });
  });

  it("refuses a subject-less draft locally, before any request", async () => {
    const res = await createCampaignFromAiDraft({ name: "n", subject: " ", body: "b", previewText: "" });

    expect(rawRequest).not.toHaveBeenCalled();
    expect(res.data).toBeNull();
    expect(res.error).toMatchObject({ status: 0, code: "ai_draft_subject_required" });
  });
});
