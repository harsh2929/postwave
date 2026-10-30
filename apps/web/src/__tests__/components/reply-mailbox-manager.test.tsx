// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  online: "online" as "online" | "connecting" | "offline",
  verifyAdmin: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  setEnabled: vi.fn(),
  remove: vi.fn(),
}));

vi.mock("@/lib/use-online", () => ({ useOnline: () => mocks.online }));
vi.mock("@/lib/admin-mutation-authority", () => ({
  verifyFreshAdminAuthority: mocks.verifyAdmin,
}));
vi.mock("@/lib/reply-mailboxes-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/reply-mailboxes-api")>()),
  listReplyMailboxes: mocks.list,
  createReplyMailbox: mocks.create,
  setReplyMailboxEnabled: mocks.setEnabled,
  deleteReplyMailbox: mocks.remove,
}));

import { ReplyMailboxManager } from "@/app/(dashboard)/app/deliverability/reply-mailbox-manager";
import type { MeResponse } from "@/lib/auth-api";
import type { ReplyMailbox } from "@/lib/reply-mailboxes-api";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const IDENTITY: MeResponse = {
  user_id: "11111111-1111-4111-8111-111111111111",
  tenant_id: "22222222-2222-4222-8222-222222222222",
  email: "admin@example.test",
  role: "admin",
  auth_provider: "password",
  email_verified: true,
  workspace_name: "Test",
  workspace_slug: "test",
};

const ROW: ReplyMailbox = {
  id: "33333333-3333-4333-8333-333333333333",
  label: "Support",
  host: "imap.example.net",
  port: 993,
  useTLS: true,
  folder: "INBOX",
  usernameSecretRef:
    "env:POSTWAVE_REPLY_IMAP_TENANT_22222222222242228222222222222222_SUPPORT_USERNAME",
  passwordSecretRef:
    "env:POSTWAVE_REPLY_IMAP_TENANT_22222222222242228222222222222222_SUPPORT_PASSWORD",
  enabled: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.online = "online";
  mocks.verifyAdmin.mockResolvedValue(IDENTITY);
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("reply mailbox manager", () => {
  it("renders an authoritative empty state only after a successful read and keeps viewers read-only", async () => {
    mocks.list.mockResolvedValue([]);
    const root = render(
      createElement(ReplyMailboxManager, {
        identity: { ...IDENTITY, role: "viewer" },
      }),
    );
    try {
      await flush();
      expect(document.body.textContent).toContain(
        "No reply mailboxes are registered",
      );
      expect(document.body.textContent).toContain("read-only");
      expect(buttonOrNull("Register disabled mailbox")).toBeNull();
    } finally {
      act(() => root.unmount());
    }
  });

  it("does not turn a failed read into an empty registry", async () => {
    mocks.list.mockRejectedValue(new Error("offline"));
    const root = render(createElement(ReplyMailboxManager, { identity: IDENTITY }));
    try {
      await flush();
      expect(document.body.textContent).toContain(
        "Reply mailboxes could not be verified",
      );
      expect(document.body.textContent).not.toContain(
        "No reply mailboxes are registered",
      );
    } finally {
      act(() => root.unmount());
    }
  });

  it("requires confirmation and fresh admin authority before enabling", async () => {
    mocks.list
      .mockResolvedValueOnce([ROW])
      .mockResolvedValueOnce([{ ...ROW, enabled: true }]);
    mocks.setEnabled.mockResolvedValue({ ...ROW, enabled: true });
    const root = render(createElement(ReplyMailboxManager, { identity: IDENTITY }));
    try {
      await flush();
      await click(button("Enable"));
      expect(mocks.setEnabled).not.toHaveBeenCalled();
      const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
      expect(dialog).toBeTruthy();
      await click(button("Enable polling", dialog as HTMLElement));
      await flush(8);
      expect(mocks.verifyAdmin).toHaveBeenCalledWith(
        IDENTITY,
        expect.any(AbortSignal),
      );
      expect(mocks.setEnabled).toHaveBeenCalledWith(
        ROW.id,
        true,
        expect.any(AbortSignal),
      );
      expect(document.body.textContent).toContain(
        "registry state, not a successful live poll",
      );
    } finally {
      act(() => root.unmount());
    }
  });

  it("disables all management while offline without hiding last-loaded rows", async () => {
    mocks.online = "offline";
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(
      ["reply-mailboxes", IDENTITY.tenant_id, "admin", false],
      [ROW],
    );
    const root = renderWithClient(
      createElement(ReplyMailboxManager, { identity: IDENTITY }),
      client,
    );
    try {
      await flush();
      expect(document.body.textContent).toContain("Last-loaded rows remain visible");
      expect(document.body.textContent).toContain("Support");
      expect(button("Enable").disabled).toBe(true);
      expect(button("Delete").disabled).toBe(true);
      expect(button("Register disabled mailbox").disabled).toBe(true);
      expect(mocks.list).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
    }
  });

  it("warns about the high-water cursor consequence before delete", async () => {
    mocks.list.mockResolvedValue([ROW]);
    const root = render(createElement(ReplyMailboxManager, { identity: IDENTITY }));
    try {
      await flush();
      await click(button("Delete"));
      expect(mocks.remove).not.toHaveBeenCalled();
      expect(document.body.textContent).toContain("then-current high-water mark");
      expect(document.body.textContent).toContain("may be skipped");
    } finally {
      act(() => root.unmount());
    }
  });
});

function render(node: ReactNode): Root {
  return renderWithClient(
    node,
    new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    }),
  );
}

function renderWithClient(node: ReactNode, client: QueryClient): Root {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(createElement(QueryClientProvider, { client }, node)));
  return root;
}

async function flush(times = 5): Promise<void> {
  await act(async () => {
    for (let index = 0; index < times; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
}

function button(label: string, root: ParentNode = document): HTMLButtonElement {
  const found = [...root.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

function buttonOrNull(label: string): HTMLButtonElement | null {
  return (
    [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) => candidate.textContent?.trim() === label,
    ) ?? null
  );
}

async function click(target: HTMLButtonElement): Promise<void> {
  await act(async () => {
    target.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
