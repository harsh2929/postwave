// @vitest-environment happy-dom
import { act, createElement } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import SequenceDetailPage from "@/app/(dashboard)/app/sequences/[id]/page";
import type { Sequence } from "@/lib/voice-types";

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  generateSubjectSuggestions: vi.fn(),
  getSequence: vi.fn(),
  regenerateEmail: vi.fn(),
  updateSequence: vi.fn(),
  getSequencePerformance: vi.fn(),
  whoami: vi.fn(),
  editorProps: null as Record<string, unknown> | null,
}));

const testQueryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, gcTime: 0 } },
});

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: mocks.whoami,
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "seq_legacy" }),
}));

vi.mock("@/lib/voice-api", () => ({
  generateSubjectSuggestions: mocks.generateSubjectSuggestions,
  getSequence: mocks.getSequence,
  regenerateEmail: mocks.regenerateEmail,
  updateSequence: mocks.updateSequence,
  getSequencePerformance: mocks.getSequencePerformance,
}));

vi.mock("@/components/editor/editor-shell", () => ({
  EditorShell: (props: Record<string, unknown>) => {
    mocks.editorProps = props;
    return createElement("div", { "data-testid": "editor-shell" });
  },
}));

vi.mock("@/app/(dashboard)/app/sequences/[id]/regenerate-email-dialog", () => ({
  RegenerateEmailDialog: (props: {
    candidate: Sequence["emails"][number] | null;
    error: string | null;
    onAccept: () => void;
    onRegenerate: () => void;
  }) =>
    createElement(
      "div",
      { "data-testid": "regeneration-dialog" },
      props.candidate
        ? createElement("button", { onClick: props.onAccept }, "Accept & save")
        : createElement(
            "button",
            { onClick: props.onRegenerate },
            props.error ? "Retry same request" : "Generate preview",
          ),
    ),
}));

vi.mock("@/components/copy-entity-link", () => ({
  CopyEntityLink: () => null,
}));

vi.mock("@/components/record-last-viewed", () => ({
  RecordLastViewed: () => null,
}));

vi.mock("@/app/(dashboard)/app/sequences/[id]/sequence-settings-card", () => ({
  SequenceSettingsCard: () => null,
}));

function sequence(patch: Partial<Sequence> = {}): Sequence {
  return {
    id: "seq_legacy",
    version: 8,
    name: "Stored journey",
    templateId: "welcome",
    templateName: "Welcome",
    status: "active",
    fidelityAvg: 82,
    emails: [
      {
        id: "email_1",
        position: 1,
        subject: "Welcome",
        bodyMarkdown: "Stored body",
        bodyHtml: "",
        bodyMjml: null,
        delayHours: 0,
        fidelity: 82,
        fidelityBreakdown: {
          embedding: 82,
          stylistic: 82,
          vocab: 82,
          structural: 82,
        },
      },
    ],
    createdAt: "2026-07-21T00:00:00Z",
    updatedAt: "2026-07-21T00:00:00Z",
    ...patch,
  };
}

function render(ui: ReactNode): Root {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() =>
    root.render(
      createElement(QueryClientProvider, { client: testQueryClient }, ui),
    ),
  );
  return root;
}

async function waitFor(assertion: () => void): Promise<void> {
  // Bounded rather than a fixed retry count: parts of the page (the email
  // step section, the header tools) are next/dynamic chunks whose first
  // load takes real time on a loaded machine.
  const deadline = Date.now() + 10_000;
  let lastError: unknown;
  do {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 10));
      });
    }
  } while (Date.now() < deadline);
  throw lastError;
}

beforeEach(() => {
  testQueryClient.clear();
  mocks.getSequence.mockReset();
  mocks.regenerateEmail.mockReset();
  mocks.updateSequence.mockReset();
  mocks.whoami.mockReset();
  mocks.whoami.mockResolvedValue({
    user_id: "11111111-1111-4111-8111-111111111111",
    tenant_id: "22222222-2222-4222-8222-222222222222",
    email: "owner@postwave.test",
    role: "owner",
    effective_role: "owner",
    viewer_mode: false,
  });
  mocks.editorProps = null;
  // The send-performance panel is out of scope for containment: resolve it to
  // an empty rollup so it settles into its "no send data yet" branch instead
  // of leaving an unresolved promise racing the assertions below.
  mocks.getSequencePerformance.mockResolvedValue({
    reached: 0,
    opened: 0,
    clicked: 0,
    positions: [],
  });
});

afterEach(() => {
  testQueryClient.clear();
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

describe("sequence detail runtime containment", () => {
  it("renders a legacy active row as read-only with no activation or regeneration path", async () => {
    mocks.getSequence.mockResolvedValue(sequence());
    const root = render(createElement(SequenceDetailPage));

    await waitFor(() => {
      expect(document.body.textContent).toContain("Legacy active label");
      expect(document.body.textContent).toContain("runtime unavailable");
    });

    const name = document.querySelector('input[aria-label="Sequence name"]');
    expect(name).toBeInstanceOf(HTMLInputElement);
    expect((name as HTMLInputElement).disabled).toBe(true);
    // The read-only body lives in the deferred email step section.
    await waitFor(() => {
      expect(
        document.querySelector('[aria-label="Read-only email body"]'),
      ).not.toBeNull();
    });
    expect(document.querySelector('[data-testid="editor-shell"]')).toBeNull();
    expect(
      document.querySelector<HTMLButtonElement>(
        'button[aria-label="Regenerate selected email"]',
      )?.disabled,
    ).toBe(true);
    expect(document.body.textContent).not.toContain("Regenerate all");
    expect(document.body.textContent).not.toContain("set to active");
    expect(mocks.updateSequence).not.toHaveBeenCalled();

    act(() => root.unmount());
  });

  it("only mounts the editor for a draft with a confirmed positive version", async () => {
    const draft = sequence({ status: "draft" });
    draft.emails[0] = {
      ...draft.emails[0],
      bodyMarkdown: "stale markdown",
      bodyHtml: "<p>Authoritative stored HTML</p>",
    };
    mocks.getSequence.mockResolvedValue(draft);
    const root = render(createElement(SequenceDetailPage));

    await waitFor(() => {
      expect(
        document.querySelector('[data-testid="editor-shell"]'),
      ).not.toBeNull();
    });
    expect(
      (
        document.querySelector(
          'input[aria-label="Sequence name"]',
        ) as HTMLInputElement
      ).disabled,
    ).toBe(false);
    expect(mocks.editorProps?.initialHtml).toBe(
      "<p>Authoritative stored HTML</p>",
    );

    const onMarkdownChange = mocks.editorProps?.onMarkdownChange as
      | ((markdown: string) => void)
      | undefined;
    await act(async () => onMarkdownChange?.("Fresh **copy**"));
    expect(mocks.editorProps?.initialMarkdown).toBe("Fresh **copy**");
    expect(mocks.editorProps?.initialHtml).toBe(
      "<p>Fresh <strong>copy</strong></p>",
    );

    act(() => root.unmount());
  });

  it("single-flights preview and explicit versioned acceptance", async () => {
    const draft = sequence({ status: "draft" });
    draft.emails[0] = { ...draft.emails[0], delayHours: 6 };
    mocks.getSequence.mockResolvedValue(draft);

    let resolveCandidate!: (candidate: Sequence["emails"][number]) => void;
    mocks.regenerateEmail.mockReturnValue(
      new Promise((resolve) => {
        resolveCandidate = resolve;
      }),
    );
    let resolveSave!: (saved: Sequence) => void;
    mocks.updateSequence.mockReturnValue(
      new Promise((resolve) => {
        resolveSave = resolve;
      }),
    );
    const root = render(createElement(SequenceDetailPage));

    await waitFor(() => {
      expect(
        document.querySelector<HTMLButtonElement>(
          'button[aria-label="Regenerate selected email"]',
        )?.disabled,
      ).toBe(false);
    });
    act(() => {
      document
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Regenerate selected email"]',
        )
        ?.click();
    });
    await waitFor(() => {
      expect(document.body.textContent).toContain("Generate preview");
    });
    const previewButton = Array.from(
      document.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent?.includes("Generate preview"));
    expect(previewButton).toBeDefined();
    act(() => {
      previewButton?.click();
      previewButton?.click();
    });
    // The voice client is imported lazily at the call site; the single-flight
    // guard is set synchronously, so the call still lands exactly once.
    await waitFor(() => {
      expect(mocks.regenerateEmail).toHaveBeenCalledTimes(1);
    });
    expect(mocks.regenerateEmail.mock.calls[0]?.[3]).toMatchObject({
      idempotencyKey: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
      ),
    });

    await act(async () => {
      resolveCandidate({
        ...draft.emails[0],
        id: "candidate-id",
        subject: "Candidate subject",
        bodyMarkdown: "Candidate body",
        bodyHtml: "<p>Candidate body</p>",
        delayHours: 99,
        fidelity: 94,
        regenerationCount: 1,
      });
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(document.body.textContent).toContain("Accept & save");
    });
    const acceptButton = Array.from(
      document.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent?.includes("Accept & save"));
    expect(acceptButton).toBeDefined();
    act(() => {
      acceptButton?.click();
      acceptButton?.click();
    });
    await waitFor(() => {
      expect(mocks.updateSequence).toHaveBeenCalledTimes(1);
    });
    const [snapshot, options] = mocks.updateSequence.mock.calls[0] as [
      Sequence,
      { requireOnline: boolean },
    ];
    expect(options).toEqual({ requireOnline: true });
    expect(snapshot.version).toBe(8);
    expect(snapshot.emails[0]).toMatchObject({
      id: "email_1",
      position: 1,
      subject: "Candidate subject",
      bodyMarkdown: "Candidate body",
      delayHours: 6,
      fidelity: 94,
    });

    await act(async () => {
      resolveSave({ ...snapshot, version: 9 });
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(document.body.textContent).not.toContain("Accept & save");
    });

    act(() => root.unmount());
  });

  it("reuses the paid-preview idempotency key after an ambiguous failure", async () => {
    const draft = sequence({ status: "draft" });
    mocks.getSequence.mockResolvedValue(draft);
    mocks.regenerateEmail
      .mockRejectedValueOnce(new Error("Network response was lost"))
      .mockResolvedValueOnce({
        ...draft.emails[0],
        subject: "Recovered candidate",
      });
    const root = render(createElement(SequenceDetailPage));

    await waitFor(() => {
      expect(
        document.querySelector<HTMLButtonElement>(
          'button[aria-label="Regenerate selected email"]',
        )?.disabled,
      ).toBe(false);
    });
    act(() => {
      document
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Regenerate selected email"]',
        )
        ?.click();
    });
    await waitFor(() => {
      expect(document.body.textContent).toContain("Generate preview");
    });
    act(() => {
      Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
        .find((button) => button.textContent?.includes("Generate preview"))
        ?.click();
    });
    await waitFor(() => {
      expect(document.body.textContent).toContain("Retry same request");
    });
    act(() => {
      Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
        .find((button) => button.textContent?.includes("Retry same request"))
        ?.click();
    });
    await waitFor(() => {
      expect(mocks.regenerateEmail).toHaveBeenCalledTimes(2);
    });
    const firstOptions = mocks.regenerateEmail.mock.calls[0]?.[3] as {
      idempotencyKey: string;
    };
    const retryOptions = mocks.regenerateEmail.mock.calls[1]?.[3] as {
      idempotencyKey: string;
    };
    expect(retryOptions.idempotencyKey).toBe(firstOptions.idempotencyKey);

    act(() => root.unmount());
  });
});
