// @vitest-environment happy-dom

import axe from "axe-core";
import { act, type ReactElement, useState } from "react";
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

const mocks = vi.hoisted(() => ({ preview: vi.fn() }));

vi.mock("../../lib/api-client", () => ({
  previewSavedSegmentDetail: mocks.preview,
}));

import { SavedSegmentDropdown } from "../../components/segments/SavedSegmentDropdown";

function segment(id: string, name: string) {
  return {
    id,
    tenant_id: "tenant-1",
    name,
    description: `${name} complete description`,
    predicate_json: {},
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-15T00:00:00.000Z",
    is_pinned: false,
    visibility_scope: "workspace" as const,
  };
}

const alpha = segment("segment-alpha", "Alpha audience");
const beta = segment("segment-beta", "Beta audience");

function preview(id: string, count = 25) {
  return {
    id,
    count,
    workspace_total: 100,
    workspace_percentage: count,
    generated_at: "2026-07-18T12:00:00.000Z",
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.preview.mockImplementation((id: string) =>
    Promise.resolve({ data: preview(id) }),
  );
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
});

function render(node: ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
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

function button(label: string): HTMLButtonElement {
  const match = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((candidate) => candidate.textContent?.trim() === label);
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

describe("SavedSegmentDropdown interaction maturity", () => {
  it("shows complete aggregate membership context without exposing samples", async () => {
    render(
      <SavedSegmentDropdown
        value={alpha.id}
        segments={[beta, alpha]}
        onChange={vi.fn()}
        ariaLabel="Audience segment"
      />,
    );
    await flush();
    const select = document.querySelector<HTMLSelectElement>("select");
    expect(
      Array.from(select?.options ?? []).map((option) => option.textContent),
    ).toEqual(["Pick a segment…", "Alpha audience", "Beta audience"]);
    expect(document.body.textContent).toContain(
      "25 of 100 workspace subscribers",
    );
    expect(document.body.textContent).toContain("25% of workspace");
    expect(document.body.textContent).toContain("Aggregate only");
    expect(document.body.textContent).toContain(
      "No member identities are exposed",
    );
    expect(document.querySelector("details")).toBeNull();
    expect(document.body.textContent).not.toContain("@example.test");
    expect(container?.querySelector("[title]")).toBeNull();

    const result = await axe.run(container ?? document.body);
    expect(
      result.violations.filter(
        (violation) =>
          violation.impact === "critical" || violation.impact === "serious",
      ),
    ).toEqual([]);
  });

  it("keeps unavailable selection focusable with a visible reason", () => {
    render(
      <SavedSegmentDropdown
        value=""
        segments={null}
        onChange={vi.fn()}
        disabled
        disabledReason="A campaign save is still in progress."
      />,
    );
    const select = document.querySelector<HTMLSelectElement>("select");
    expect(select?.disabled).toBe(false);
    expect(select?.getAttribute("aria-disabled")).toBe("true");
    expect(select?.getAttribute("aria-busy")).toBe("true");
    expect(document.body.textContent).toContain(
      "A campaign save is still in progress.",
    );
  });

  it("keeps a fetch failure distinct from an empty library and offers retry", () => {
    const onRetry = vi.fn();
    render(
      <SavedSegmentDropdown
        value=""
        segments={null}
        error="The service could not complete the request."
        onRetry={onRetry}
        onChange={vi.fn()}
      />,
    );
    expect(document.body.textContent).toContain(
      "Saved segments could not be verified",
    );
    expect(document.body.textContent).not.toContain("No saved segments yet");
    act(() => button("Retry saved segments").click());
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(
      document.querySelector<HTMLSelectElement>("select"),
    );
    expect(mocks.preview).not.toHaveBeenCalled();
  });

  it("contains preview failure and single-flights retry with safe diagnostics", async () => {
    mocks.preview
      .mockRejectedValueOnce(new Error("private segment SQL and tenant detail"))
      .mockResolvedValueOnce({ data: preview(alpha.id) });
    render(
      <SavedSegmentDropdown
        value={alpha.id}
        segments={[alpha]}
        onChange={vi.fn()}
      />,
    );
    await flush();
    expect(document.body.textContent).toContain(
      "The service could not be reached. Check the connection and retry.",
    );
    expect(document.body.textContent).not.toContain("private segment SQL");
    const retry = button("Retry preview");
    act(() => {
      retry.click();
      retry.click();
    });
    expect(document.activeElement).toBe(
      document.querySelector<HTMLSelectElement>("select"),
    );
    await flush();
    expect(mocks.preview).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain(
      "25 of 100 workspace subscribers",
    );
  });

  it("caches in-flight previews across rapid selection changes without stale display", async () => {
    const alphaPending = deferred<{ data: ReturnType<typeof preview> }>();
    const betaPending = deferred<{ data: ReturnType<typeof preview> }>();
    mocks.preview.mockImplementation((id: string) =>
      id === alpha.id ? alphaPending.promise : betaPending.promise,
    );

    function Harness() {
      const [value, setValue] = useState(alpha.id);
      return (
        <SavedSegmentDropdown
          value={value}
          segments={[alpha, beta]}
          onChange={setValue}
        />
      );
    }
    render(<Harness />);
    const select = document.querySelector<HTMLSelectElement>("select");
    if (!select) throw new Error("Missing segment picker");
    act(() => {
      select.value = beta.id;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    act(() => {
      select.value = alpha.id;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(mocks.preview).toHaveBeenCalledTimes(2);

    await act(async () => {
      betaPending.resolve({ data: preview(beta.id, 80) });
      alphaPending.resolve({ data: preview(alpha.id, 20) });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.preview).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain("Alpha audience");
    expect(document.body.textContent).toContain(
      "20 of 100 workspace subscribers",
    );
    expect(document.body.textContent).not.toContain(
      "80 of 100 workspace subscribers",
    );
  });

  it("aborts and discards an old workspace preview when segment ownership changes", async () => {
    const oldRequest = deferred<{ data: ReturnType<typeof preview> }>();
    const nextRequest = deferred<{ data: ReturnType<typeof preview> }>();
    mocks.preview
      .mockReturnValueOnce(oldRequest.promise)
      .mockReturnValueOnce(nextRequest.promise);
    render(
      <SavedSegmentDropdown
        value={alpha.id}
        segments={[alpha]}
        onChange={vi.fn()}
      />,
    );
    const oldSignal = mocks.preview.mock.calls[0]?.[1].signal as AbortSignal;
    const nextWorkspaceAlpha = { ...alpha, tenant_id: "tenant-2" };
    act(() => {
      root?.render(
        <SavedSegmentDropdown
          value={nextWorkspaceAlpha.id}
          segments={[nextWorkspaceAlpha]}
          onChange={vi.fn()}
        />,
      );
    });
    expect(oldSignal.aborted).toBe(true);
    expect(mocks.preview).toHaveBeenCalledTimes(2);

    await act(async () => {
      oldRequest.resolve({ data: preview(alpha.id, 80) });
      nextRequest.resolve({ data: preview(alpha.id, 20) });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain(
      "20 of 100 workspace subscribers",
    );
    expect(document.body.textContent).not.toContain(
      "80 of 100 workspace subscribers",
    );
  });
});
