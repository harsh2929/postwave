// @vitest-environment happy-dom

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  all: [] as Array<Record<string, unknown>>,
}));

vi.mock("../../lib/outbox", () => ({
  useOutbox: () => ({ all: mocks.all }),
}));

import { PendingSyncStatus } from "../../components/PendingSyncStatus";

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
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  mocks.all = [];
});

function render(node: ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

describe("PendingSyncStatus", () => {
  it("projects the durable journal next to the matching object", () => {
    mocks.all = [
      {
        id: "mut_1",
        method: "PATCH",
        path: "/api/v1/forms/form_1?draft=1",
        idempotencyKey: "idem_1",
        queuedAt: "2026-07-16T00:00:00.000Z",
        attempts: 0,
        status: "pending",
        resource: "forms",
      },
      {
        id: "mut_2",
        method: "PATCH",
        path: "/api/v1/forms/form_2",
        idempotencyKey: "idem_2",
        queuedAt: "2026-07-16T00:00:00.000Z",
        attempts: 0,
        status: "conflict",
        resource: "forms",
      },
    ];

    render(<PendingSyncStatus path="/api/v1/forms/form_1" />);

    expect(document.body.textContent).toContain(
      "Saved on this device · pending sync",
    );
    expect(document.querySelector('[role="status"]')).not.toBeNull();
  });

  it("uses an alert for a resource-level conflict", () => {
    mocks.all = [
      {
        id: "mut_2",
        method: "PATCH",
        path: "/api/v1/forms/form_2",
        idempotencyKey: "idem_2",
        queuedAt: "2026-07-16T00:00:00.000Z",
        attempts: 1,
        status: "conflict",
        resource: "forms",
      },
    ];

    render(<PendingSyncStatus resource="forms" />);

    expect(document.body.textContent).toContain(
      "Sync conflict · review journal",
    );
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
  });
});
