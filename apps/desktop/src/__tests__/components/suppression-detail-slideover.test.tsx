// @vitest-environment happy-dom

import { act, type ReactElement } from "react";
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
  SuppressionAuditEntry,
  SuppressionEntry,
  SuppressionRow,
} from "../../lib/api-client";

const mocks = vi.hoisted(() => ({
  audit: vi.fn(),
  get: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  suppressionsApi: { audit: mocks.audit },
  suppressionsConvergedApi: { get: mocks.get },
}));

import { SuppressionDetailSlideover } from "../../components/suppressions/SuppressionDetailSlideover";

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

function row(email = "reader@example.com"): SuppressionRow {
  return {
    id: `row-${email}`,
    email,
    reason: "manual_unsubscribe",
    created_at: "2026-07-15T08:00:00.000Z",
  };
}

function entry(overrides: Partial<SuppressionEntry> = {}): SuppressionEntry {
  return {
    id: "entry-1",
    email: "reader@example.com",
    reason: "hard_bounce",
    source: "postmark",
    source_event_id: "source-event-a",
    channel: "email",
    scope: "all",
    created_at: "2026-07-15T08:00:00.000Z",
    expires_at: null,
    ...overrides,
  };
}

function auditEntry(
  overrides: Partial<SuppressionAuditEntry> = {},
): SuppressionAuditEntry {
  return {
    id: "audit-1",
    tenant_id: "tenant-1",
    email: "reader@example.com",
    action: "add",
    actor: "API key pw_ab…",
    reason: "hard_bounce",
    source_table: "subscriber_suppressions",
    created_at: "2026-07-15T08:00:00.000Z",
    ...overrides,
  };
}

function slideover(selectedRow = row()): ReactElement {
  return (
    <SuppressionDetailSlideover
      row={selectedRow}
      onClose={vi.fn()}
      onRemove={vi.fn()}
    />
  );
}

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

function button(label: string): HTMLButtonElement {
  const match = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((candidate) => candidate.textContent?.trim() === label);
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
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

describe("SuppressionDetailSlideover", () => {
  it("renders converged details and pages the audit trail", async () => {
    mocks.get.mockResolvedValueOnce({ data: entry() });
    mocks.audit
      .mockResolvedValueOnce({
        data: { items: [auditEntry()], total: 11, page: 1 },
      })
      .mockResolvedValueOnce({
        data: {
          items: [auditEntry({ id: "audit-2", actor: "Operator Two" })],
          total: 11,
          page: 2,
        },
      });
    render(slideover());

    await waitFor(() => {
      expect(document.body.textContent).toContain("Hard bounce");
      expect(document.body.textContent).toContain("Permanent");
      expect(document.body.textContent).toContain("API key pw_ab…");
      expect(document.body.textContent).toContain("Page 1 of 2");
    });
    expect(mocks.audit).toHaveBeenCalledWith("reader@example.com", {
      page: 1,
      size: 10,
    });

    act(() => button("Next").click());
    await waitFor(() => {
      expect(mocks.audit).toHaveBeenLastCalledWith("reader@example.com", {
        page: 2,
        size: 10,
      });
      expect(document.body.textContent).toContain("Operator Two");
      expect(document.body.textContent).toContain("Page 2 of 2");
    });
  });

  it("reports legacy entry and audit-route absence without false permanence", async () => {
    mocks.get.mockResolvedValueOnce({
      error: { kind: "http", status: 404, message: "Not found" },
    });
    mocks.audit.mockResolvedValueOnce({
      error: { kind: "http", status: 501, message: "Not implemented" },
    });
    render(slideover());

    await waitFor(() => {
      expect(document.body.textContent).toContain("Expiry isn't available");
      expect(document.body.textContent).toContain(
        "doesn't expose the suppression audit endpoint yet",
      );
    });
    expect(document.body.textContent).not.toContain(
      "This address never auto-expires",
    );
  });

  it("surfaces non-compatibility lookup and audit errors", async () => {
    mocks.get.mockResolvedValueOnce({
      error: { kind: "http", status: 500, message: "Entry failed" },
    });
    mocks.audit.mockResolvedValueOnce({
      error: { kind: "http", status: 503, message: "Audit failed" },
    });
    render(slideover());

    await waitFor(() => {
      expect(document.body.textContent).toContain("Entry failed");
      expect(document.body.textContent).toContain(
        "Couldn't load the audit trail: Audit failed",
      );
      expect(document.body.textContent).toContain("expiry unknown");
    });
  });

  it("clears the prior address details immediately when the row changes", async () => {
    const nextEntry = deferred<{ data: SuppressionEntry }>();
    const nextAudit = deferred<{
      data: { items: SuppressionAuditEntry[]; total: number; page: number };
    }>();
    mocks.get
      .mockResolvedValueOnce({
        data: entry({ source_event_id: "private-source-for-first" }),
      })
      .mockReturnValueOnce(nextEntry.promise);
    mocks.audit
      .mockResolvedValueOnce({ data: { items: [], total: 0, page: 1 } })
      .mockReturnValueOnce(nextAudit.promise);
    const view = render(slideover());
    await waitFor(() => {
      expect(document.body.textContent).toContain("private-source-for-first");
    });

    view.rerender(slideover(row("second@example.com")));
    expect(document.body.textContent).toContain("second@example.com");
    expect(document.body.textContent).not.toContain("private-source-for-first");

    nextEntry.resolve({
      data: entry({
        email: "second@example.com",
        source_event_id: "second-source",
      }),
    });
    nextAudit.resolve({ data: { items: [], total: 0, page: 1 } });
    await waitFor(() => {
      expect(document.body.textContent).toContain("second-source");
    });
  });
});
