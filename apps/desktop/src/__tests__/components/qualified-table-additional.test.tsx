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

import { ActivationExclusionsPanel } from "../../components/compliance/ActivationExclusionsPanel";
import { ResponseHeadersTable } from "../../components/playground/PlaygroundHeaders";

const mocks = vi.hoisted(() => ({
  listExclusions: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  activationExclusionsApi: {
    list: mocks.listExclusions,
  },
}));

vi.mock("../../components/playground/Copy", () => ({
  CopyButton: ({ label }: { label: string }) => (
    <button type="button">Copy {label}</button>
  ),
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

beforeEach(() => {
  mocks.listExclusions.mockReset();
});

afterEach(() => {
  if (root) {
    const current = root;
    act(() => current.unmount());
  }
  root = null;
  container?.remove();
  container = null;
});

async function render(node: ReactElement): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(node);
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("additional qualified table migrations", () => {
  it("gives response headers column relationships, stable ordering, and explicit copy actions", async () => {
    await render(
      <ResponseHeadersTable
        headers={{
          "X-Request-Id": "request-1",
          "Content-Type": "application/json",
        }}
      />,
    );
    expect(document.querySelector("caption")?.textContent).toBe(
      "Response headers",
    );
    expect(
      Array.from(document.querySelectorAll("thead th")).map(
        (header) => header.textContent,
      ),
    ).toEqual(["Header", "Value", "Actions"]);
    const rows = Array.from(document.querySelectorAll("tbody tr"));
    expect(rows.map((row) => row.textContent)).toEqual([
      "Content-Typeapplication/jsonCopy Content-Type value",
      "X-Request-Idrequest-1Copy X-Request-Id value",
    ]);
  });

  it("retains activation exclusion receipts when a refresh fails", async () => {
    mocks.listExclusions
      .mockResolvedValueOnce({
        data: [
          {
            id: 1,
            run_id: "run-1",
            run_type: "campaign",
            subscriber_email: "reader@example.test",
            rule_class: "consent",
            rule_reason: "No marketing consent",
            purpose: "marketing",
            destination_type: "email",
            excluded_at: "2026-07-16T10:00:00Z",
            signature: "redacted",
          },
        ],
        error: null,
      })
      .mockResolvedValueOnce({
        data: null,
        error: { message: "Compliance service unavailable" },
      });
    await render(<ActivationExclusionsPanel />);
    expect(document.body.textContent).toContain("reader@example.test");

    const refresh = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent === "Refresh",
    )!;
    await act(async () => {
      refresh.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Compliance service unavailable",
    );
    expect(document.body.textContent).toContain("reader@example.test");
    expect(document.body.textContent).not.toContain("No exclusions recorded");
  });
});
