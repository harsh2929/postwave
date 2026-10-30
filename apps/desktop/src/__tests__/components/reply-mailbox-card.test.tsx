// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  online: "online" as "online" | "connecting" | "offline",
  canAdmin: true,
  roleStatus: "resolved" as "loading" | "resolved" | "unavailable",
  me: {
    user: "11111111-1111-4111-8111-111111111111",
    tenant: "22222222-2222-4222-8222-222222222222",
    role: "admin" as const,
    effectiveRole: "admin" as "admin" | "editor" | "viewer",
  },
  list: vi.fn(),
  create: vi.fn(),
  setEnabled: vi.fn(),
  remove: vi.fn(),
}));

vi.mock("../../lib/online-manager", () => ({ useOnline: () => mocks.online }));
vi.mock("../../lib/store", () => ({
  useCanAdmin: () => mocks.canAdmin,
  useMe: () => mocks.me,
  useRoleStatus: () => mocks.roleStatus,
}));
vi.mock("../../lib/reply-mailboxes", () => ({
  tenantMailboxSecretPrefix: (tenant: string) =>
    `env:POSTWAVE_REPLY_IMAP_TENANT_${tenant.replaceAll("-", "").toUpperCase()}_`,
  listReplyMailboxes: mocks.list,
  createReplyMailbox: mocks.create,
  setReplyMailboxEnabled: mocks.setEnabled,
  deleteReplyMailbox: mocks.remove,
}));

import { ReplyMailboxCard } from "../../components/deliverability/ReplyMailboxCard";

const ROW = {
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

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.online = "online";
  mocks.canAdmin = true;
  mocks.roleStatus = "resolved";
  mocks.me.effectiveRole = "admin";
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  document.body.innerHTML = "";
});

describe("desktop reply mailbox management", () => {
  it("shows an authoritative empty state only after a successful read", async () => {
    mocks.list.mockResolvedValue([]);
    await render();
    expect(document.body.textContent).toContain(
      "No reply mailboxes are registered",
    );
    expect(document.body.textContent).toContain("Register a disabled mailbox");
  });

  it("contains a failed read instead of rendering a false empty registry", async () => {
    mocks.list.mockRejectedValue(new Error("secret-token at internal host"));
    await render();
    expect(document.body.textContent).toContain(
      "Reply mailboxes could not be verified",
    );
    expect(document.body.textContent).not.toContain(
      "No reply mailboxes are registered",
    );
    expect(document.body.textContent).not.toContain("secret-token");
  });

  it("requires confirmation before enabling and reconciles a fresh row", async () => {
    mocks.list
      .mockResolvedValueOnce([ROW])
      .mockResolvedValueOnce([{ ...ROW, enabled: true }]);
    mocks.setEnabled.mockResolvedValue({ ...ROW, enabled: true });
    await render();
    await click(button("Enable"));
    expect(mocks.setEnabled).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).toBeTruthy();
    await click(button("Enable polling"));
    await settle(8);
    expect(mocks.setEnabled).toHaveBeenCalledWith(
      ROW.id,
      true,
      expect.any(AbortSignal),
    );
    expect(document.body.textContent).toContain(
      "registry state, not live mailbox certification",
    );
  });

  it("keeps viewer rows visible but removes management controls", async () => {
    mocks.canAdmin = false;
    mocks.me.effectiveRole = "viewer";
    mocks.list.mockResolvedValue([ROW]);
    await render();
    expect(document.body.textContent).toContain("Support");
    expect(document.body.textContent).toContain("read-only");
    expect(buttonOrNull("Enable")).toBeNull();
    expect(buttonOrNull("Delete")).toBeNull();
    expect(buttonOrNull("Register disabled mailbox")).toBeNull();
  });

  it("preserves last-loaded rows and disables writes when connectivity drops", async () => {
    mocks.list.mockResolvedValue([ROW]);
    await render();
    mocks.online = "offline";
    await act(async () => {
      root?.render(<ReplyMailboxCard />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(document.body.textContent).toContain("Support");
    expect(document.body.textContent).toContain("Last-loaded rows remain visible");
    expect(button("Enable").disabled).toBe(true);
    expect(button("Delete").disabled).toBe(true);
  });

  it("warns about the high-water cursor consequence before delete", async () => {
    mocks.list.mockResolvedValue([ROW]);
    await render();
    await click(button("Delete"));
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("then-current high-water mark");
    expect(document.body.textContent).toContain("may be skipped");
  });
});

async function render(): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root?.render(<ReplyMailboxCard />));
  await settle();
}

async function settle(times = 5): Promise<void> {
  await act(async () => {
    for (let index = 0; index < times; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
}

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
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
