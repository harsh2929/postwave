// @vitest-environment happy-dom

import { act } from "react";
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

const mocks = vi.hoisted(() => ({
  importBulk: vi.fn(),
  redact: vi.fn(
    (message: string) => `safe: ${message.replace(/secret/gi, "[redacted]")}`,
  ),
}));

vi.mock("../../lib/api-client", () => ({
  SUPPRESSION_REASONS_X1: [
    { value: "manual_unsubscribe", label: "Manual unsubscribe" },
    { value: "hard_bounce", label: "Hard bounce" },
    { value: "list_manual", label: "List manual" },
  ],
  suppressionsApi: { importBulk: mocks.importBulk },
}));

vi.mock("../../lib/auth", () => ({ redact: mocks.redact }));

import { BulkImportSuppressionsModal } from "../../components/suppressions/BulkImportSuppressionsModal";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  mocks.importBulk.mockReset();
  mocks.redact.mockClear();
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  document.body.style.overflow = "";
  vi.clearAllMocks();
});

function renderModal({
  onClose = vi.fn(),
  onImported = vi.fn(),
}: {
  onClose?: () => void;
  onImported?: (result: {
    imported: number;
    skipped: number;
    errors: string[];
  }) => void;
} = {}): { onClose: () => void; onImported: typeof onImported } {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root?.render(
      <BulkImportSuppressionsModal
        open
        onClose={onClose}
        onImported={onImported}
      />,
    ),
  );
  return { onClose, onImported };
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((candidate) => candidate.textContent?.trim() === label);
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

function setInput(value: string): void {
  const input = document.querySelector<HTMLTextAreaElement>(
    "#bulk-import-suppression-data",
  );
  if (!input) throw new Error("Missing suppression-data textarea");
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function chooseMode(value: "emails" | "csv" | "json"): void {
  const input = document.querySelector<HTMLInputElement>(
    `input[type="radio"][value="${value}"]`,
  );
  if (!input) throw new Error(`Missing input mode: ${value}`);
  act(() => input.click());
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

describe("BulkImportSuppressionsModal", () => {
  it("blocks the whole submission when any pasted token is invalid", () => {
    renderModal();
    setInput("valid@example.com invalid-token");

    expect(document.body.textContent).toContain("Not an email: invalid-token");
    expect(document.body.textContent).toContain("No rows have been submitted.");
    expect(button("Import 1 address").disabled).toBe(true);
    expect(
      document
        .querySelector("#bulk-import-suppression-data")
        ?.getAttribute("aria-invalid"),
    ).toBe("true");
    expect(mocks.importBulk).not.toHaveBeenCalled();
  });

  it("blocks one address carrying conflicting compliance reasons", () => {
    renderModal();
    chooseMode("json");
    setInput(
      JSON.stringify([
        { email: "same@example.com", reason: "manual_unsubscribe" },
        { email: "same@example.com", reason: "hard_bounce" },
      ]),
    );

    expect(document.body.textContent).toContain("Conflicting reasons (1)");
    expect(document.body.textContent).toContain(
      "same@example.com: choose one reason",
    );
    expect(button("Import 1 address").disabled).toBe(true);
    expect(mocks.importBulk).not.toHaveBeenCalled();
  });

  it("serializes same-tick submits and prevents every dismissal while busy", async () => {
    const request = deferred<{
      data: { imported: number; skipped: number; errors: string[] };
    }>();
    mocks.importBulk.mockReturnValue(request.promise);
    const { onClose, onImported } = renderModal();
    setInput("one@example.com");

    const submit = button("Import 1 address");
    act(() => {
      submit.click();
      submit.click();
    });

    expect(mocks.importBulk).toHaveBeenCalledTimes(1);
    expect(mocks.importBulk).toHaveBeenCalledWith({
      emails: ["one@example.com"],
      reason: "manual_unsubscribe",
    });
    expect(button("Importing…").disabled).toBe(true);
    expect(
      document.querySelector<HTMLButtonElement>(".modal-close")?.disabled,
    ).toBe(true);

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      document
        .querySelector<HTMLElement>(".modal-backdrop")
        ?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    });
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => {
      request.resolve({ data: { imported: 1, skipped: 0, errors: [] } });
      await request.promise;
    });
    await waitFor(() => {
      expect(document.body.textContent).toContain("Import complete");
      expect(onImported).toHaveBeenCalledWith({
        imported: 1,
        skipped: 0,
        errors: [],
      });
    });
  });

  it("retains successful groups and reports a redacted partial failure", async () => {
    mocks.importBulk
      .mockResolvedValueOnce({
        data: { imported: 1, skipped: 0, errors: [] },
      })
      .mockResolvedValueOnce({
        error: { message: "secret database trace" },
      });
    const { onImported } = renderModal();
    chooseMode("json");
    setInput(
      JSON.stringify([
        { email: "one@example.com", reason: "manual_unsubscribe" },
        { email: "two@example.com", reason: "hard_bounce" },
      ]),
    );

    act(() => button("Import 2 addresses").click());
    await waitFor(() => {
      expect(document.body.textContent).toContain("Import partially complete");
      expect(document.body.textContent).toContain("Failed reason groups (1)");
      expect(document.body.textContent).toContain(
        "hard_bounce · 1 address: safe: [redacted] database trace",
      );
    });
    expect(document.body.textContent).not.toContain("secret database trace");
    expect(mocks.importBulk).toHaveBeenCalledTimes(2);
    expect(onImported).toHaveBeenCalledWith({
      imported: 1,
      skipped: 0,
      errors: [],
    });
  });

  it("keeps an all-failed import editable and does not claim completion", async () => {
    mocks.importBulk.mockRejectedValueOnce(new Error("network secret"));
    const { onImported } = renderModal();
    setInput("one@example.com");

    act(() => button("Import 1 address").click());
    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "No reason group completed. The request did not complete.",
      );
    });
    expect(document.body.textContent).not.toContain("Import complete");
    expect(document.querySelector("textarea")).not.toBeNull();
    expect(onImported).not.toHaveBeenCalled();
  });
});
