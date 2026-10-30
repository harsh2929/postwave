// @vitest-environment happy-dom

import axe from "axe-core";
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

const mocks = vi.hoisted(() => ({
  listSources: vi.fn(),
}));

vi.mock("../../lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api-client")>();
  return {
    ...actual,
    api: { ...actual.api, listMigrationSources: mocks.listSources },
  };
});

import { MigrationWizard } from "../../components/MigrationWizard";

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
  vi.clearAllMocks();
  mocks.listSources.mockResolvedValue({
    data: [
      {
        source: "csv",
        auth_method: "csv_upload",
        intake_available: true,
        commit_available: true,
        supports: { subscribers: true },
      },
    ],
  });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  document.body.style.overflow = "";
});

function render(node: ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(document.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!(match instanceof HTMLButtonElement)) {
    throw new Error(`Missing button: ${label}`);
  }
  return match;
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      assertion();
      return;
    } catch (caught) {
      lastError = caught;
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      });
    }
  }
  throw lastError;
}

describe("migration wizard maturity", () => {
  it("reuses a freshly verified parent capability snapshot without a duplicate catalog read", async () => {
    render(
      <MigrationWizard
        initialSourceId="csv"
        initialCapabilities={[
          {
            source: "csv",
            auth_method: "csv_upload",
            intake_available: true,
            commit_available: true,
            supports: { subscribers: true },
          },
        ]}
        onClose={vi.fn()}
      />,
    );

    await waitFor(() =>
      expect(document.activeElement?.textContent).toBe("Step 2 of 5: Connect"),
    );
    expect(mocks.listSources).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Drop a CSV here");
  });

  it("moves focus and announces each in-dialog step transition", async () => {
    render(<MigrationWizard initialSourceId="csv" onClose={vi.fn()} />);
    await waitFor(() => expect(mocks.listSources).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(document.activeElement?.textContent).toBe("Step 2 of 5: Connect"),
    );
    expect(
      document.querySelector<HTMLElement>("[data-migration-step-announcement]")
        ?.textContent,
    ).toBe("Step 2 of 5: Connect");

    act(() => button("Back").click());
    await waitFor(() =>
      expect(document.activeElement?.textContent).toBe(
        "Step 1 of 5: Pick source",
      ),
    );
    expect(
      document.querySelector<HTMLElement>("[data-migration-step-announcement]")
        ?.textContent,
    ).toBe("Step 1 of 5: Pick source");

    const csv = Array.from(document.querySelectorAll("button")).find(
      (candidate) =>
        candidate.getAttribute("aria-label")?.startsWith("CSV upload"),
    );
    expect(csv).toBeInstanceOf(HTMLButtonElement);
    act(() => (csv as HTMLButtonElement).click());
    await waitFor(() =>
      expect(document.activeElement?.textContent).toBe("Step 2 of 5: Connect"),
    );
  });

  it("keeps validation unavailable actions focusable with explicit reasons", async () => {
    render(<MigrationWizard initialSourceId="csv" onClose={vi.fn()} />);
    await waitFor(() => expect(mocks.listSources).toHaveBeenCalledTimes(1));

    const connect = button("Connect & preview");
    expect(connect.disabled).toBe(false);
    expect(connect.getAttribute("aria-disabled")).toBe("true");
    const reasonId = connect.getAttribute("aria-describedby");
    expect(reasonId).toBeTruthy();
    expect(document.getElementById(reasonId!)?.textContent).toContain(
      "CSV file is required",
    );
    expect(document.querySelectorAll("[title]")).toHaveLength(0);

    const result = await axe.run(document.body, {
      rules: { region: { enabled: false } },
    });
    expect(
      result.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);
  });

  it("withholds raw capability errors and single-flights retry", async () => {
    mocks.listSources.mockResolvedValueOnce({
      error: {
        status: 500,
        code: "migration_capability_failed",
        requestId: "req-safe-123",
        message: "Authorization: Bearer do-not-render",
      },
    });
    render(<MigrationWizard onClose={vi.fn()} />);
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "Migration capabilities could not be confirmed.",
      ),
    );
    expect(document.body.textContent).not.toContain("do-not-render");
    expect(document.body.textContent).toContain("req-safe-123");
    expect(document.body.textContent).toContain(
      "No connection can start until a fresh catalog is verified",
    );

    let resolveRetry!: (value: { data: never[] }) => void;
    const pending = new Promise<{ data: never[] }>((resolve) => {
      resolveRetry = resolve;
    });
    mocks.listSources.mockReturnValueOnce(pending);
    const retry = button("Retry capability check");
    act(() => {
      retry.click();
      retry.click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(mocks.listSources).toHaveBeenCalledTimes(2);
    expect(button("Retrying…").disabled).toBe(false);

    await act(async () => {
      resolveRetry({ data: [] });
      await pending;
    });
    await waitFor(() =>
      expect(document.body.textContent).not.toContain(
        "Migration capabilities could not be confirmed.",
      ),
    );
  });

  it("fails a malformed successful catalog closed before any connection can start", async () => {
    mocks.listSources.mockResolvedValueOnce({
      data: { count: 0 },
    });
    render(<MigrationWizard initialSourceId="csv" onClose={vi.fn()} />);

    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "Migration capabilities could not be confirmed.",
      ),
    );
    const connect = button("Connect & preview");
    expect(connect.disabled).toBe(false);
    expect(connect.getAttribute("aria-disabled")).toBe("true");
    const reasonId = connect.getAttribute("aria-describedby");
    expect(document.getElementById(reasonId!)?.textContent).toContain(
      "not freshly verified",
    );
  });
});
