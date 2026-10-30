// @vitest-environment happy-dom

import axe from "axe-core";
import { act, type ComponentProps, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type {
  SubscriberNote,
  SubscriberNoteAttachment,
} from "../../lib/api-client";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  addAttachment: vi.fn(),
  removeAttachment: vi.fn(),
  downloadAttachment: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  subscriberNotesApi: {
    list: mocks.list,
    create: mocks.create,
    update: mocks.update,
    remove: mocks.remove,
    addAttachment: mocks.addAttachment,
    removeAttachment: mocks.removeAttachment,
  },
}));

vi.mock("../../lib/store", () => ({
  useMe: () => ({
    user: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    tenant: "tenant-1",
    role: "admin",
    effectiveRole: "admin",
  }),
}));

vi.mock("../../lib/file-transfer", () => ({
  downloadUrlToFile: mocks.downloadAttachment,
}));

vi.mock("../../components/Toast", () => ({
  toast: {
    error: mocks.toastError,
    success: mocks.toastSuccess,
  },
}));

import {
  SUBSCRIBER_NOTE_ATTACHMENT_DOWNLOAD_MAX_BYTES,
  SubscriberNotesPanel,
  buildNoteMentionCandidates,
} from "../../components/subscribers/SubscriberNotesPanel";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.create.mockResolvedValue({ data: { id: "note-created" } });
  mocks.update.mockResolvedValue({ data: {} });
  mocks.remove.mockResolvedValue({ data: undefined });
  mocks.addAttachment.mockResolvedValue({
    data: { id: "attachment-created", file_key: "notes/new.pdf" },
  });
  mocks.removeAttachment.mockResolvedValue({ data: undefined });
  mocks.downloadAttachment.mockResolvedValue({
    ok: true,
    status: "saved",
    transferId: "note-download",
    collision: false,
  });
});

afterEach(() => {
  if (root) {
    const currentRoot = root;
    act(() => currentRoot.unmount());
    root = null;
  }
  container?.remove();
  container = null;
  document.body.replaceChildren();
  document.body.style.overflow = "";
  vi.clearAllMocks();
});

function render(node: ReactElement): {
  rerender: (next: ReactElement) => void;
} {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
  return {
    rerender(next) {
      act(() => root?.render(next));
    },
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      });
    }
  }
  throw lastError;
}

function note(overrides: Partial<SubscriberNote> = {}): SubscriberNote {
  return {
    id: "note-1",
    subscriber_id: "subscriber-1",
    subscriber_email: "reader@example.com",
    body: "Legacy body",
    markdown_body: "**Private** context",
    mentions: [],
    attachments: [],
    author_user_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    author_email: "operator@example.com",
    pinned: false,
    created_at: "2026-07-15T08:00:00.000Z",
    ...overrides,
  };
}

function attachment(
  overrides: Partial<SubscriberNoteAttachment> = {},
): SubscriberNoteAttachment {
  return {
    id: "attachment-1",
    note_id: "note-1",
    file_key: "notes/private.pdf",
    filename: "private.pdf",
    content_type: "application/pdf",
    size_bytes: 512,
    uploaded_at: "2026-07-15T08:00:00.000Z",
    download_url: "https://files.example.test/private.pdf",
    ...overrides,
  };
}

function panel(
  overrides: Partial<ComponentProps<typeof SubscriberNotesPanel>> = {},
): ReactElement {
  return (
    <SubscriberNotesPanel
      active
      subscriberId="subscriber-1"
      canMutate
      canAdmin
      formatRelativeTime={() => "just now"}
      {...overrides}
    />
  );
}

describe("SubscriberNotesPanel", () => {
  it("loads only when active and refetches for a different subscriber", async () => {
    mocks.list
      .mockResolvedValueOnce({ data: { notes: [], count: 0 } })
      .mockResolvedValueOnce({
        data: {
          notes: [note({ id: "note-2", markdown_body: "Second profile" })],
          count: 1,
        },
      });
    const view = render(panel({ active: false }));

    await act(async () => Promise.resolve());
    expect(mocks.list).not.toHaveBeenCalled();

    view.rerender(panel({ active: true }));
    await waitFor(() => {
      expect(mocks.list).toHaveBeenCalledWith("subscriber-1");
      expect(document.body.textContent).toContain("No notes yet");
    });

    view.rerender(panel({ active: true, subscriberId: "subscriber-2" }));
    await waitFor(() => {
      expect(mocks.list).toHaveBeenCalledWith("subscriber-2");
      expect(document.body.textContent).toContain("Second profile");
    });
    expect(mocks.list).toHaveBeenCalledTimes(2);
  });

  it("recovers from a thrown load and provides an in-place retry", async () => {
    mocks.list
      .mockRejectedValueOnce(new Error("private transport detail"))
      .mockResolvedValueOnce({ data: { notes: [], count: 0 } });
    render(panel());

    await waitFor(() => {
      expect(document.querySelector('[role="alert"]')?.textContent).toContain(
        "couldn't be loaded",
      );
    });
    expect(document.body.textContent).not.toContain("private transport detail");
    const retry = Array.from(
      document.querySelectorAll<HTMLButtonElement>("button"),
    ).find((candidate) => candidate.textContent === "Retry");
    act(() => retry?.click());
    await waitFor(() => {
      expect(document.body.textContent).toContain("No notes yet");
    });
    expect(mocks.list).toHaveBeenCalledTimes(2);
  });

  it("keeps verified notes visible when a post-refresh identity check fails", async () => {
    mocks.list
      .mockResolvedValueOnce({ data: { notes: [note()], count: 1 } })
      .mockResolvedValueOnce({
        error: {
          kind: "parse",
          code: "subscriber_response_identity_mismatch",
          message:
            "The server returned data for a different subscriber. The previous verified data was kept; retry the request.",
        },
      })
      .mockResolvedValueOnce({ data: { notes: [note()], count: 1 } });
    render(panel());
    await waitFor(() => {
      expect(document.body.textContent).toContain("Private");
    });

    const editor = document.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="New note"]',
    );
    if (!editor) throw new Error("Expected note editor");
    act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set?.call(editor, "Follow-up note");
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const add = Array.from(
      document.querySelectorAll<HTMLButtonElement>("button"),
    ).find((candidate) => candidate.textContent === "Add note");
    act(() => add?.click());

    await waitFor(() => {
      expect(document.querySelector('[role="alert"]')).not.toBeNull();
      expect(document.body.textContent).toContain("different subscriber");
    });
    expect(document.body.textContent).toContain("Private");
    expect(document.body.textContent).not.toContain("Follow-up note");

    const retry = Array.from(
      document.querySelectorAll<HTMLButtonElement>("button"),
    ).find((candidate) => candidate.textContent === "Retry");
    act(() => retry?.click());
    await waitFor(() => {
      expect(document.querySelector('[role="alert"]')).toBeNull();
      expect(document.body.textContent).toContain("Private");
    });
    expect(mocks.list).toHaveBeenCalledTimes(3);
  });

  it("removes the previous subscriber's notes before the replacement request resolves", async () => {
    const replacement = deferred<{
      data: { notes: SubscriberNote[]; count: number };
    }>();
    mocks.list
      .mockResolvedValueOnce({
        data: {
          notes: [note({ markdown_body: "First subscriber private note" })],
          count: 1,
        },
      })
      .mockReturnValueOnce(replacement.promise);
    const view = render(panel());

    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "First subscriber private note",
      );
    });

    view.rerender(panel({ subscriberId: "subscriber-2" }));
    expect(document.body.textContent).not.toContain(
      "First subscriber private note",
    );
    expect(mocks.list).toHaveBeenLastCalledWith("subscriber-2");

    replacement.resolve({
      data: {
        notes: [note({ markdown_body: "Second subscriber note" })],
        count: 1,
      },
    });
    await waitFor(() => {
      expect(document.body.textContent).toContain("Second subscriber note");
    });
  });

  it("ignores a mutation completion after switching subscribers", async () => {
    const deletion = deferred<{ data: undefined }>();
    mocks.list
      .mockResolvedValueOnce({ data: { notes: [note()], count: 1 } })
      .mockResolvedValueOnce({ data: { notes: [], count: 0 } });
    mocks.remove.mockReturnValueOnce(deletion.promise);
    const view = render(panel());
    await waitFor(() => expect(document.body.textContent).toContain("Private"));

    const deleteTrigger = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent === "Delete",
    );
    act(() => deleteTrigger?.click());
    const confirm = Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        '[role="alertdialog"] button',
      ),
    ).find((button) => button.textContent === "Delete note");
    act(() => confirm?.click());
    expect(mocks.remove).toHaveBeenCalledWith("subscriber-1", "note-1");

    view.rerender(panel({ subscriberId: "subscriber-2" }));
    await waitFor(() => {
      expect(document.body.textContent).toContain("No notes yet");
    });
    deletion.resolve({ data: undefined });
    await act(async () => Promise.resolve());

    expect(mocks.toastSuccess).not.toHaveBeenCalledWith("Note deleted");
    expect(document.body.textContent).toContain("No notes yet");
  });

  it("does not create a link for an unsafe attachment URL", async () => {
    mocks.list.mockResolvedValue({
      data: {
        notes: [
          note({
            attachments: [
              attachment({
                download_url: "javascript:alert(document.domain)",
              }),
            ],
          }),
        ],
        count: 1,
      },
    });
    render(panel());

    await waitFor(() => {
      expect(document.body.textContent).toContain("private.pdf");
    });
    expect(
      document.querySelector('a.note-attachment-link[href^="javascript:"]'),
    ).toBeNull();
    expect(document.querySelector("a.note-attachment-link")).toBeNull();
    expect(
      document.querySelector('button[aria-label="Download private.pdf"]'),
    ).toBeNull();
  });

  it("keeps attachment creation unavailable without calling registration or opening a chooser", async () => {
    mocks.list.mockResolvedValue({
      data: { notes: [note()], count: 1 },
    });
    render(panel());

    await waitFor(() => {
      expect(document.body.textContent).toContain("Attach file · Unavailable");
    });
    const action = Array.from(
      document.querySelectorAll<HTMLButtonElement>("button"),
    ).find((candidate) => candidate.textContent?.includes("Attach file"));
    expect(action?.disabled).toBe(true);
    const reasonId = action?.getAttribute("aria-describedby") ?? "";
    expect(document.getElementById(reasonId)?.textContent).toContain(
      "verify object ownership and scan the uploaded bytes",
    );
    expect(document.querySelector('input[type="file"]')).toBeNull();
    expect(document.body.textContent).not.toContain("object-store key");
    expect(mocks.addAttachment).not.toHaveBeenCalled();
  });

  it("uses a fixed private download cap and never delegates around it", async () => {
    mocks.list.mockResolvedValue({
      data: {
        notes: [
          note({
            attachments: [attachment({ size_bytes: 12 * 1024 * 1024 })],
          }),
        ],
        count: 1,
      },
    });
    render(panel());

    await waitFor(() => {
      expect(
        document.querySelector('button[aria-label="Download private.pdf"]'),
      ).not.toBeNull();
    });
    const download = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Download private.pdf"]',
    );
    act(() => download?.click());
    await waitFor(() => {
      expect(mocks.downloadAttachment).toHaveBeenCalledTimes(1);
    });
    expect(mocks.downloadAttachment).toHaveBeenCalledWith({
      url: "https://files.example.test/private.pdf",
      suggestedName: "private.pdf",
      label: "Subscriber note attachment",
      privacy: "confidential",
      maxBytes: SUBSCRIBER_NOTE_ATTACHMENT_DOWNLOAD_MAX_BYTES,
      allowExternalFallback: false,
    });
  });

  it("blocks metadata-declared oversize files without letting metadata raise the cap", async () => {
    mocks.list.mockResolvedValue({
      data: {
        notes: [
          note({
            attachments: [
              attachment({
                size_bytes: SUBSCRIBER_NOTE_ATTACHMENT_DOWNLOAD_MAX_BYTES + 1,
              }),
            ],
          }),
        ],
        count: 1,
      },
    });
    render(panel());

    await waitFor(() => {
      expect(
        document.querySelector('button[aria-label="Download private.pdf"]'),
      ).not.toBeNull();
    });
    act(() =>
      document
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Download private.pdf"]',
        )
        ?.click(),
    );
    expect(mocks.downloadAttachment).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledWith(
      "This attachment is marked larger than the 50 MB download safety limit.",
    );
  });

  it("keeps cancellation silent and surfaces a real download failure", async () => {
    mocks.list.mockResolvedValue({
      data: {
        notes: [note({ attachments: [attachment()] })],
        count: 1,
      },
    });
    mocks.downloadAttachment
      .mockResolvedValueOnce({
        ok: true,
        status: "cancelled",
        transferId: "picker-cancelled-download",
      })
      .mockResolvedValueOnce({
        ok: false,
        code: "cancelled",
        message: "The download was cancelled.",
        transferId: "cancelled-download",
      })
      .mockResolvedValueOnce({
        ok: false,
        code: "download_failed",
        message: "Moosewave could not download this file.",
        transferId: "failed-download",
      });
    render(panel());

    await waitFor(() => {
      expect(
        document.querySelector('button[aria-label="Download private.pdf"]'),
      ).not.toBeNull();
    });
    const download = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Download private.pdf"]',
    );
    act(() => download?.click());
    await waitFor(() => {
      expect(mocks.downloadAttachment).toHaveBeenCalledTimes(1);
      expect(download?.disabled).toBe(false);
    });
    expect(mocks.toastError).not.toHaveBeenCalled();

    act(() => download?.click());
    await waitFor(() => {
      expect(mocks.downloadAttachment).toHaveBeenCalledTimes(2);
      expect(download?.disabled).toBe(false);
    });
    expect(mocks.toastError).not.toHaveBeenCalled();

    act(() => download?.click());
    await waitFor(() => {
      expect(mocks.toastError).toHaveBeenCalledWith(
        "Moosewave could not download this file.",
      );
    });
    expect(mocks.downloadAttachment).toHaveBeenCalledTimes(3);
  });

  it("renders legacy filenames as inert text, strips bidi controls, and hides storage keys", async () => {
    const unsafeFilename = "\u202Ereport<script>alert(1)</script>.pdf\u0000";
    mocks.list.mockResolvedValue({
      data: {
        notes: [
          note({
            attachments: [
              attachment({
                file_key: "private/tenant/object-key-not-for-display",
                filename: unsafeFilename,
              }),
            ],
          }),
        ],
        count: 1,
      },
    });
    render(panel());

    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "report<script>alert(1)</script>.pdf",
      );
    });
    expect(document.body.textContent).not.toContain("\u202E");
    expect(document.body.textContent).not.toContain(
      "private/tenant/object-key-not-for-display",
    );
    expect(document.querySelector("script")).toBeNull();
    expect(document.querySelector("img")).toBeNull();
    expect(
      document.querySelector(
        'button[aria-label="Download report<script>alert(1)</script>.pdf"]',
      ),
    ).not.toBeNull();
  });

  it("keeps note mutations admin-gated and exposes the reason access is denied", async () => {
    mocks.list.mockResolvedValue({
      data: { notes: [note()], count: 1 },
    });
    render(panel({ canAdmin: false }));

    await waitFor(() => {
      expect(document.body.textContent).toContain("Private");
    });

    const pin = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent === "Pin",
    );
    const remove = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent === "Delete",
    );
    const editor = document.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="New note"]',
    );
    expect(pin?.disabled).toBe(false);
    expect(pin?.getAttribute("aria-disabled")).toBe("true");
    expect(remove?.disabled).toBe(false);
    expect(remove?.getAttribute("aria-disabled")).toBe("true");
    const accessId = pin?.getAttribute("aria-describedby") ?? "";
    expect(document.getElementById(accessId)?.textContent).toContain(
      "Notes need an admin role",
    );
    expect(pin?.hasAttribute("title")).toBe(false);
    expect(remove?.hasAttribute("title")).toBe(false);
    expect(editor?.disabled).toBe(true);
    const attach = Array.from(
      document.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent?.includes("Attach file"));
    expect(attach?.disabled).toBe(true);
    const attachReason = document.getElementById(
      attach?.getAttribute("aria-describedby") ?? "",
    );
    expect(attachReason?.textContent).toContain("Notes need an admin role");
    expect(attachReason?.textContent).toContain(
      "Secure note uploads are unavailable",
    );
    expect(mocks.addAttachment).not.toHaveBeenCalled();

    const result = await axe.run(container ?? document.body, {
      rules: { region: { enabled: false } },
    });
    expect(
      result.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);
  });

  it("single-flights a thrown pin update and releases the action for retry", async () => {
    mocks.list.mockResolvedValue({ data: { notes: [note()], count: 1 } });
    mocks.update.mockRejectedValueOnce(new Error("private transport detail"));
    render(panel());
    await waitFor(() => expect(document.body.textContent).toContain("Private"));
    const pin = Array.from(
      document.querySelectorAll<HTMLButtonElement>("button"),
    ).find((candidate) => candidate.textContent === "Pin");
    expect(pin).toBeDefined();

    act(() => {
      pin?.click();
      pin?.click();
    });
    await waitFor(() => {
      expect(mocks.toastError).toHaveBeenCalledWith(
        expect.stringContaining("Check your connection"),
      );
    });
    expect(mocks.update).toHaveBeenCalledTimes(1);
    expect(pin?.disabled).toBe(false);
    expect(document.body.textContent).not.toContain("private transport detail");

    act(() => pin?.click());
    await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(2));
  });

  it("confirms deletion before removing a note and updates the visible list", async () => {
    mocks.list.mockResolvedValue({
      data: { notes: [note()], count: 1 },
    });
    render(panel());
    await waitFor(() => expect(document.body.textContent).toContain("Private"));

    const deleteTrigger = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent === "Delete",
    );
    act(() => deleteTrigger?.click());
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
    expect(mocks.remove).not.toHaveBeenCalled();

    const confirm = Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        '[role="alertdialog"] button',
      ),
    ).find((button) => button.textContent === "Delete note");
    await act(async () => confirm?.click());

    await waitFor(() => {
      expect(mocks.remove).toHaveBeenCalledWith("subscriber-1", "note-1");
      expect(document.body.textContent).not.toContain("Private");
    });
    expect(mocks.toastSuccess).toHaveBeenCalledWith("Note deleted");
  });

  it("deduplicates mention identities and prefers a human display name", () => {
    const userId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const candidates = buildNoteMentionCandidates(
      [
        note({
          author_user_id: userId.toUpperCase(),
          author_email: undefined,
          mentions: [{ user_id: userId, display: "Casey" }],
        }),
      ],
      "not-a-uuid",
    );

    expect(candidates).toEqual([
      { id: userId, display: "Casey", hint: undefined },
    ]);
  });
});
