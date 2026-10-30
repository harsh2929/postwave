/**
 * Moosewave AI chat — the render contract for every state the screen can be in.
 *
 * WHAT THIS FILE EXISTS TO CATCH. The transcript rules (one pending turn,
 * retry/regenerate, the sticky hold, disclosure-before-first-turn) are pinned
 * in lib/aiChat.test.ts; this file proves they REACH THE SCREEN:
 *   - the Article 50 text is on screen before the first turn and is the
 *     package constant byte for byte;
 *   - a held server renders the server's sentence verbatim as a blocked
 *     screen — no composer, no Retry;
 *   - a pending turn shows Stop and nothing else that could spend;
 *   - a finished reply is tagged AI-generated and offers Regenerate and the
 *     draft handoff; a failed one offers Retry only when retryable;
 *   - offline and viewer sessions get a reason, not a 403.
 *
 * `useAiChat` is mocked so each state is driven directly — the hook's own
 * reducer is covered in node, and the transport seam in api/aiChat.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { AI_DISCLOSURE_TEXT } from "@postwave/ai-disclosure";

import type { AiChatFailure } from "@/lib/aiChatFailures";
import type { AiChatMessage } from "@/lib/aiChatTranscript";

import AiChat from "../app/(tabs)/ai-chat";

const queryHooks = require("./mocks/queryHooks.cjs");

const mockChat = {
  messages: [] as AiChatMessage[],
  pending: false,
  hold: null as AiChatFailure | null,
  send: jest.fn(),
  retry: jest.fn(),
  stop: jest.fn(),
  clear: jest.fn(),
};
jest.mock("@/hooks/useAiChat", () => ({ useAiChat: () => mockChat }));

const mockHandoff = { create: jest.fn(), creating: false };
jest.mock("@/hooks/useAiDraftHandoff", () => ({
  useAiDraftHandoff: () => mockHandoff,
}));

function wrapper({ children }: { children: ReactNode }) {
  return (
    <SafeAreaProvider
      initialMetrics={{
        frame: { height: 844, width: 390, x: 0, y: 0 },
        insets: { bottom: 34, left: 0, right: 0, top: 47 },
      }}
    >
      {children}
    </SafeAreaProvider>
  );
}

function message(over: Partial<AiChatMessage>): AiChatMessage {
  return {
    id: "m",
    role: "assistant",
    status: "done",
    text: "",
    createdAt: 1,
    sourcePrompt: "Write a welcome email",
    sourceTone: "",
    kind: "campaign_draft",
    draft: null,
    failure: null,
    requestId: null,
    ...over,
  };
}

const USER = message({ id: "u1", role: "user", status: "done", text: "Write a welcome email" });

const HELD: AiChatFailure = {
  kind: "held",
  message: "the in-app agent is release-held",
  retryable: false,
  requestId: null,
  code: "agent_interactive_release_held",
};

beforeEach(() => {
  mockChat.messages = [];
  mockChat.pending = false;
  mockChat.hold = null;
  mockChat.send = jest.fn();
  mockChat.retry = jest.fn();
  mockChat.stop = jest.fn();
  mockChat.clear = jest.fn();
  mockHandoff.create = jest.fn();
  mockHandoff.creating = false;
});

afterEach(() => {
  queryHooks.__resetOnlineGateForTests();
});

describe("empty", () => {
  it("discloses the AI before the first turn, byte for byte, and offers starters", async () => {
    await render(<AiChat />, { wrapper });

    expect(screen.getAllByText("Moosewave AI").length).toBeGreaterThan(0);
    expect(screen.getByText(AI_DISCLOSURE_TEXT)).toBeTruthy();
    expect(screen.getByText("Try asking")).toBeTruthy();
    // Nothing to clear yet.
    expect(screen.queryByLabelText("Clear the conversation")).toBeNull();
    // Send is offered but inert until there is text.
    expect(screen.getByLabelText("Send").props.accessibilityState.disabled).toBe(true);
  });

  it("sends the typed prompt with the chosen tone, once, on Send", async () => {
    await render(<AiChat />, { wrapper });

    await fireEvent.changeText(screen.getByLabelText("Message to Moosewave AI"), "  Hello there ");
    await fireEvent.press(screen.getByLabelText("Send"));
    expect(mockChat.send).toHaveBeenCalledWith("Hello there", "");

    await fireEvent.press(screen.getByLabelText("Friendly tone"));
    await fireEvent.changeText(screen.getByLabelText("Message to Moosewave AI"), "Hi");
    await fireEvent.press(screen.getByLabelText("Send"));
    expect(mockChat.send).toHaveBeenLastCalledWith("Hi", "friendly");
    expect(mockChat.send).toHaveBeenCalledTimes(2);
  });

  it("a starter fills the field rather than sending on its own", async () => {
    await render(<AiChat />, { wrapper });

    await fireEvent.press(
      screen.getByLabelText("Use starter: Write five subject lines for a spring sale announcement"),
    );

    expect(screen.getByLabelText("Message to Moosewave AI").props.value).toBe(
      "Write five subject lines for a spring sale announcement",
    );
    expect(mockChat.send).not.toHaveBeenCalled();
  });
});

describe("sending", () => {
  it("shows one waiting bubble and turns the button into Stop", async () => {
    mockChat.pending = true;
    mockChat.messages = [USER, message({ id: "a1", status: "pending" })];

    await render(<AiChat />, { wrapper });

    expect(screen.getByText("Waiting for the whole reply…")).toBeTruthy();
    expect(screen.queryByLabelText("Send")).toBeNull();
    await fireEvent.press(screen.getByLabelText("Stop waiting"));
    expect(mockChat.stop).toHaveBeenCalledTimes(1);
    // Regenerate is never offered while a turn is in flight.
    expect(screen.queryByLabelText(/Regenerate/u)).toBeNull();
  });
});

describe("reply", () => {
  it("renders the whole reply, tags it AI-generated and offers Regenerate + the draft handoff", async () => {
    const draft = { name: "Welcome", subject: "Welcome aboard", body: "<p>Hi</p>", previewText: "" };
    mockChat.messages = [USER, message({ id: "a1", text: "Here is a welcome email.", draft })];

    await render(<AiChat />, { wrapper });

    expect(screen.getByText("Here is a welcome email.")).toBeTruthy();
    expect(screen.getByText("AI-generated")).toBeTruthy();
    // The disclosure stays ABOVE the transcript once turns exist.
    expect(screen.getByText(AI_DISCLOSURE_TEXT)).toBeTruthy();

    await fireEvent.press(screen.getByLabelText("Regenerate this reply with the same prompt"));
    expect(mockChat.retry).toHaveBeenCalledWith("a1");

    expect(screen.getByText("Welcome aboard")).toBeTruthy();
    await fireEvent.press(screen.getByLabelText("Create campaign draft"));
    expect(mockHandoff.create).toHaveBeenCalledWith(draft);

    await fireEvent.press(screen.getByLabelText("Clear the conversation"));
    expect(mockChat.clear).toHaveBeenCalledTimes(1);
  });

  it("does not offer the campaign handoff for a subject-less draft", async () => {
    mockChat.messages = [
      USER,
      message({ id: "a1", text: "Body only.", draft: { name: "", subject: "", body: "<p>x</p>", previewText: "" } }),
    ];

    await render(<AiChat />, { wrapper });

    expect(screen.queryByLabelText("Create campaign draft")).toBeNull();
    expect(screen.getByLabelText("Copy the email body")).toBeTruthy();
  });
});

describe("held", () => {
  it("renders the server's hold sentence verbatim as a blocked screen with no composer and no Retry", async () => {
    mockChat.hold = HELD;
    mockChat.messages = [USER, message({ id: "a1", status: "failed", failure: HELD })];

    await render(<AiChat />, { wrapper });

    // Title AND header subtitle both say it — the screen states the hold twice.
    expect(screen.getAllByText("Blocked on the server").length).toBeGreaterThan(0);
    expect(screen.getAllByText("the in-app agent is release-held").length).toBeGreaterThan(0);
    expect(screen.getByText(/agent_interactive_release_held/u)).toBeTruthy();
    expect(screen.queryByLabelText("Retry this prompt")).toBeNull();
    expect(screen.getByLabelText("Send").props.accessibilityState.disabled).toBe(true);
    expect(screen.getByLabelText("Message to Moosewave AI").props.editable).toBe(false);
  });
});

describe("error", () => {
  it("shows the classified sentence, the request id, and a Retry that re-runs the same turn", async () => {
    const failure: AiChatFailure = {
      kind: "failed",
      message: "AI chat is unavailable on the server right now. (HTTP 503)",
      retryable: true,
      requestId: "req-9",
      code: "internal_error",
    };
    mockChat.messages = [USER, message({ id: "a1", status: "failed", failure })];

    await render(<AiChat />, { wrapper });

    expect(screen.getByText(failure.message)).toBeTruthy();
    expect(screen.getByText("Request req-9")).toBeTruthy();
    await fireEvent.press(screen.getByLabelText("Retry this prompt"));
    expect(mockChat.retry).toHaveBeenCalledWith("a1");
  });

  it("offers no Retry when a retry cannot change the answer", async () => {
    const failure: AiChatFailure = {
      kind: "invalid",
      message: "prompt exceeds the permitted size",
      retryable: false,
      requestId: null,
      code: "prompt_too_large",
    };
    mockChat.messages = [USER, message({ id: "a1", status: "failed", failure })];

    await render(<AiChat />, { wrapper });

    expect(screen.getByText("prompt exceeds the permitted size")).toBeTruthy();
    expect(screen.queryByLabelText("Retry this prompt")).toBeNull();
  });
});

describe("offline", () => {
  it("says a connection is needed and offers no composer, no starters and no disclosure to an empty transcript", async () => {
    queryHooks.__setIsOnlineForTests(false);

    await render(<AiChat />, { wrapper });

    expect(screen.getByText("Reconnect to ask")).toBeTruthy();
    expect(screen.getByLabelText("Send").props.accessibilityState.disabled).toBe(true);
    expect(screen.queryByText("Try asking")).toBeNull();
    // Nothing AI can happen, so the notice is not forced onto an empty screen.
    expect(screen.queryByText(AI_DISCLOSURE_TEXT)).toBeNull();
  });

  it("treats a closed online gate the same way and keeps an existing transcript readable", async () => {
    queryHooks.__setOnlineGateForTests({ enabled: false });
    mockChat.messages = [USER, message({ id: "a1", text: "Earlier reply." })];

    await render(<AiChat />, { wrapper });

    expect(screen.getByText("Reconnect to ask")).toBeTruthy();
    expect(screen.getByText("Earlier reply.")).toBeTruthy();
    expect(screen.getByText(AI_DISCLOSURE_TEXT)).toBeTruthy();
    // Readable, not actionable: no Regenerate without a connection.
    expect(screen.queryByLabelText(/Regenerate/u)).toBeNull();
  });
});

describe("viewer", () => {
  it("explains the editor floor instead of offering a button that can only 403", async () => {
    queryHooks.__setOnlineGateForTests({ effectiveRole: "viewer" });

    await render(<AiChat />, { wrapper });

    expect(screen.getByText("Chatting needs editor access")).toBeTruthy();
    expect(screen.getByLabelText("Send").props.accessibilityState.disabled).toBe(true);
    expect(screen.getByLabelText("Friendly tone").props.accessibilityState.disabled).toBe(true);
  });
});
