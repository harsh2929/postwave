// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { ConversationRow } from "../../components/sms/ConversationRow";
import type { SMSConversationSummary } from "../../lib/api-client";

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  document.body.replaceChildren();
});

function summary(
  overrides: Partial<SMSConversationSummary> = {},
): SMSConversationSummary {
  return {
    phoneE164: "+12025550101",
    lastMessagePreview: "Synthetic preview",
    lastMessageAt: "2026-08-21T12:00:00Z",
    lastDirection: "inbound",
    messageCount: 3,
    unreadCount: 1,
    identityAmbiguous: false,
    ...overrides,
  };
}

function renderRow(value: SMSConversationSummary): void {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() =>
    root.render(
      <ConversationRow
        conversation={value}
        selected={false}
        onClick={vi.fn()}
      />,
    ),
  );
}

describe("SMS conversation row evidence", () => {
  it("shows an explicit unavailable preview without inventing truncated text", () => {
    renderRow(
      summary({
        lastMessagePreview: "",
        lastMessagePreviewOmittedReason: "body_exceeds_inbox_limit",
      }),
    );
    expect(document.body.textContent).toContain("Message body unavailable");
    expect(document.body.textContent).toContain("evidence limit");
    expect(document.querySelector(".sms-message-text")).toBeNull();
  });

  it("distinguishes unavailable legacy preview content from oversize evidence", () => {
    renderRow(
      summary({
        lastMessagePreview: "",
        lastMessagePreviewOmittedReason: "legacy_body_unavailable",
      }),
    );
    expect(document.body.textContent).toContain(
      "Legacy message preview unavailable",
    );
    expect(document.body.textContent).not.toContain("exceeded");
    expect(document.querySelector(".sms-message-text")).toBeNull();
  });

  it("never chooses one subscriber email for an ambiguous phone identity", () => {
    renderRow(
      summary({
        identityAmbiguous: true,
        subscriberEmail: undefined,
      }),
    );
    expect(document.body.textContent).toContain("Multiple linked identities");
    expect(document.body.textContent).not.toContain("example.invalid");
  });
});
