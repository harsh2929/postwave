// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// SMS conversation notes (parity row messaging-25, seed route
// POST /api/v1/sms/conversations/{phone}/notes). Asserts the confirm names the
// blind-overwrite consequence, the exact request (path, CAS body, one attempt),
// the fresh authority re-read, and that the tenant-bound receipt reaches the
// caller.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const TENANT = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const PHONE = "+14155550123";
const LOADED_VERSION = "2026-09-10T12:00:00.123456Z";

const mocks = vi.hoisted(() => ({
  post: vi.fn(
    async (
      _path: string,
      _body?: unknown,
      _opts?: { maxAttempts?: number; requireOnline?: boolean },
    ): Promise<unknown> => ({}),
  ),
  whoamiFresh: vi.fn(async (): Promise<unknown> => null),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: { ...actual.api, post: mocks.post } };
});
vi.mock("@/lib/auth-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth-api")>();
  return { ...actual, whoamiFresh: mocks.whoamiFresh };
});

import { ConversationNotesEditor } from "@/components/sms/ConversationNotesEditor";
import { ApiError } from "@/lib/api";

const me = (role: string) => ({
  user_id: USER,
  tenant_id: TENANT,
  role,
  effective_role: role,
  viewer_mode: false,
});

let root: Root | null = null;
const onStateChanged = vi.fn((_receipt: unknown) => undefined);
const onRefreshRequired = vi.fn(() => undefined);

function render() {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() =>
    root!.render(
      createElement(ConversationNotesEditor, {
        conversation: { phoneE164: PHONE, stateUpdatedAt: LOADED_VERSION },
        identity: { tenantId: TENANT, userId: USER, effectiveRole: "admin" },
        online: "online",
        assertCurrent: () => undefined,
        onStateChanged,
        onRefreshRequired,
      }),
    ),
  );
}

const flush = async (times = 6) => {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
};

function notesField(): HTMLTextAreaElement {
  return document.querySelector<HTMLTextAreaElement>("textarea")!;
}

function typeNotes(value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      notesField(),
      value,
    );
    notesField().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function button(label: string, scope: ParentNode = document): HTMLButtonElement {
  const found = Array.from(scope.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === label,
  );
  if (!found) throw new Error(`button ${label} missing`);
  return found as HTMLButtonElement;
}

beforeEach(() => {
  mocks.whoamiFresh.mockImplementation(async () => me("admin"));
  mocks.post.mockImplementation(async () => ({
    ok: true,
    tenantId: TENANT,
    phoneE164: PHONE,
    action: "notes",
    stateUpdatedAt: "2026-09-12T10:00:00.5Z",
  }));
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  vi.clearAllMocks();
  document.body.replaceChildren();
});

describe("ConversationNotesEditor", () => {
  it("confirms the blind overwrite, then POSTs the notes with the loaded version as one attempt", async () => {
    render();
    typeNotes("VIP — prefers evening replies");
    act(() => button("Save notes").click());
    await flush(2);
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Replace conversation notes?");
    expect(dialog.textContent).toContain(
      `This overwrites the internal notes for ${PHONE}`,
    );
    expect(dialog.textContent).toContain("cannot be reviewed or recovered");
    expect(mocks.post).not.toHaveBeenCalled();

    act(() => button("Replace notes", dialog).click());
    await flush();
    expect(mocks.post).toHaveBeenCalledTimes(1);
    const [path, body, opts] = mocks.post.mock.calls[0]!;
    expect(path).toBe("/api/v1/sms/conversations/%2B14155550123/notes");
    expect(body).toEqual({
      notes: "VIP — prefers evening replies",
      expectedUpdatedAt: LOADED_VERSION,
    });
    expect(opts).toMatchObject({ maxAttempts: 1, requireOnline: true });
    expect(mocks.whoamiFresh).toHaveBeenCalledTimes(2);
    expect(onStateChanged).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "notes",
        phoneE164: PHONE,
        stateUpdatedAt: "2026-09-12T10:00:00.5Z",
      }),
    );
    expect(document.body.textContent).toContain("Notes saved");
  });

  it("clearing sends an empty string, labelled as a clear", async () => {
    render();
    act(() => button("Clear notes").click());
    await flush(2);
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Clear conversation notes?");
    act(() => button("Clear notes", dialog).click());
    await flush();
    expect(mocks.post.mock.calls[0]![1]).toEqual({
      notes: "",
      expectedUpdatedAt: LOADED_VERSION,
    });
  });

  it("refuses notes the server would reject, before any request", () => {
    render();
    typeNotes(" leading space");
    expect(button("Save notes").disabled).toBe(true);
    expect(document.body.textContent).toContain(
      "Remove leading and trailing spaces from the notes.",
    );
    typeNotes("line one\nline two");
    expect(button("Save notes").disabled).toBe(true);
    expect(document.body.textContent).toContain("single line");
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it("stops without writing when authority changed, and renders the server's conflict sentence", async () => {
    mocks.whoamiFresh.mockImplementationOnce(async () => me("editor"));
    render();
    typeNotes("note");
    act(() => button("Save notes").click());
    await flush(2);
    act(() => button("Replace notes", document.querySelector('[role="dialog"]')!).click());
    await flush();
    expect(mocks.post).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("SMS inbox authorization changed");
    expect(onRefreshRequired).toHaveBeenCalledTimes(1);

    mocks.post.mockImplementationOnce(async () => {
      throw new ApiError(
        "conversation state changed; refresh before retrying",
        409,
        undefined,
        { code: "conversation_state_conflict" },
      );
    });
    act(() => button("Save notes").click());
    await flush(2);
    act(() => button("Replace notes", document.querySelector('[role="dialog"]')!).click());
    await flush();
    expect(document.body.textContent).toContain(
      "conversation state changed; refresh before retrying",
    );
    expect(onStateChanged).not.toHaveBeenCalled();
  });
});
