// @vitest-environment happy-dom

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  ConflictModal,
  conflictFieldRows,
  mergeConflictFields,
} from "../../components/ConflictModal";
import type { OfflineMutation } from "../../lib/offline-store";

const mocks = vi.hoisted(() => ({
  apiRequest: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  apiRequest: mocks.apiRequest,
}));

vi.mock("../../components/QueuedMutationEditor", () => ({
  QueuedMutationEditor: () => null,
}));

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  if (root) {
    const currentRoot = root;
    act(() => {
      currentRoot.unmount();
    });
    root = null;
  }
  container?.remove();
  container = null;
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function render(node: ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  const nextRoot = createRoot(container);
  root = nextRoot;
  act(() => {
    nextRoot.render(node);
  });
}

async function flush(): Promise<void> {
  await new Promise((resolve) => window.requestAnimationFrame(resolve));
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => {
        await flush();
      });
    }
  }
  throw lastError;
}

const conflictItem: OfflineMutation = {
  id: "mut_1",
  method: "PATCH",
  path: "/api/v1/campaigns/cmp_1",
  body: { subject: "Mine" },
  headers: {},
  idempotencyKey: "idem_1",
  queuedAt: "2026-06-28T00:00:00.000Z",
  attempts: 1,
  status: "conflict",
};

describe("ConflictModal", () => {
  it("loads the server version through the canonical API request layer", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    mocks.apiRequest.mockResolvedValue({
      data: { subject: "Server" },
    });

    render(
      <ConflictModal
        open={true}
        item={conflictItem}
        onClose={vi.fn()}
        onKeepMine={vi.fn()}
        onKeepServer={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(document.body.textContent).toContain('"Server"');
      expect(document.body.textContent).toContain("Retry selected merge");
    });

    expect(mocks.apiRequest).toHaveBeenCalledWith("/api/v1/campaigns/cmp_1", {
      method: "GET",
      cache: "no-store",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("builds field-level differences and applies a selective merge", () => {
    expect(
      conflictFieldRows(
        { subject: "Mine", preview: "Same", removed: undefined },
        { subject: "Server", preview: "Same", added: true },
      ).map((row) => row.key),
    ).toEqual(["added", "subject"]);

    expect(
      mergeConflictFields(
        { subject: "Mine", preview: "Local preview" },
        { subject: "Server", preview: "Server preview", status: "draft" },
        new Set(["subject"]),
      ),
    ).toEqual({
      subject: "Mine",
      preview: "Server preview",
      status: "draft",
    });
  });
});
