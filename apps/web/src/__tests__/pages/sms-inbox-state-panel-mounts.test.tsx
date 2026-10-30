// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// messaging-25 — the conversation notes editor is reachable from the SMS
// inbox's conversation-controls panel (the panel sms-message-log-card.tsx
// renders for the open thread), and saving from there issues the notes write
// for THIS conversation and hands the receipt to the panel's caller.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setOnlineStatusForTest } from "@/lib/online-manager";
import {
  buttonByText,
  clickEl,
  recordingTransport,
  settle,
  typeInto,
} from "./_mount-transport";

const TENANT = "22222222-2222-4222-8222-222222222222";
const USER = "11111111-1111-4111-8111-111111111111";
const PHONE = "+14155550123";

vi.mock("@/lib/auth-api", async (importOriginal) => {
  const me = {
    user_id: "11111111-1111-4111-8111-111111111111",
    tenant_id: "22222222-2222-4222-8222-222222222222",
    role: "admin",
    effective_role: "admin",
    viewer_mode: false,
  };
  return {
    ...(await importOriginal<typeof import("@/lib/auth-api")>()),
    whoami: vi.fn(async () => me),
    whoamiFresh: vi.fn(async () => me),
  };
});

import { SmsInboxStatePanel } from "@/app/(dashboard)/app/sms/sms-inbox-state-panel";

let root: Root | null = null;

beforeEach(() => {
  setOnlineStatusForTest("online");
});
afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("SMS inbox conversation controls — notes editor (messaging-25)", () => {
  it("renders the notes editor in the panel and saves notes for the open conversation", async () => {
    const { calls } = recordingTransport((req) =>
      req.method === "POST" && req.path.endsWith("/notes")
        ? {
            body: {
              ok: true,
              tenantId: TENANT,
              phoneE164: PHONE,
              action: "notes",
              stateUpdatedAt: "2026-09-12T10:00:00.5Z",
            },
          }
        : undefined,
    );
    const onStateChanged = vi.fn((_receipt: unknown) => undefined);
    const container = document.createElement("div");
    document.body.append(container);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    await act(async () => {
      root = createRoot(container);
      root.render(
        createElement(
          QueryClientProvider,
          { client },
          createElement(SmsInboxStatePanel, {
            conversation: {
              phoneE164: PHONE,
              identityAmbiguous: false,
              lastMessagePreview: "hi",
              lastMessageAt: "2026-09-12T09:00:00Z",
              lastDirection: "inbound",
              messageCount: 1,
              unreadCount: 0,
              stateUpdatedAt: "2026-09-10T12:00:00.123456Z",
            },
            identity: {
              tenantId: TENANT,
              userId: USER,
              effectiveRole: "admin",
              viewerMode: false,
              fingerprint: "fp",
            },
            online: "online",
            queryBase: ["sms", TENANT, "inbox", PHONE],
            assertCurrent: () => undefined,
            onStateChanged,
            onRefreshRequired: () => undefined,
          }),
        ),
      );
    });
    await settle();

    const notes = container.querySelector<HTMLElement>(
      'section[aria-label="Internal conversation notes"]',
    );
    expect(notes).not.toBeNull();
    expect(container.textContent).not.toContain(
      "Internal notes remain read-only unavailable",
    );

    await typeInto(notes!.querySelector("textarea")!, "VIP — call before noon");
    await clickEl(buttonByText(notes!, "Save notes"));
    await settle(2);
    await clickEl(buttonByText(document.body, "Replace notes"));
    await settle();

    const writes = calls.filter(
      (c) => c.method === "POST" && c.path.endsWith("/notes"),
    );
    expect(writes).toHaveLength(1);
    expect(writes[0].path).toBe(
      `/api/v1/sms/conversations/${encodeURIComponent(PHONE)}/notes`,
    );
    expect(writes[0].body).toEqual({
      notes: "VIP — call before noon",
      expectedUpdatedAt: "2026-09-10T12:00:00.123456Z",
    });
    expect(onStateChanged).toHaveBeenCalledTimes(1);
    expect(onStateChanged.mock.calls[0][0]).toMatchObject({
      phoneE164: PHONE,
      action: "notes",
    });
  });
});
