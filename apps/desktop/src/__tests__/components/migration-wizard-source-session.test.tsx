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

import type { MigrationJob } from "../../lib/api-client";

const mocks = vi.hoisted(() => ({
  listSources: vi.fn(),
  create: vi.fn(),
  preview: vi.fn(),
  getMigration: vi.fn(),
  run: vi.fn(),
  refreshSession: vi.fn(),
}));

vi.mock("../../lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api-client")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      listMigrationSources: mocks.listSources,
      createMigration: mocks.create,
      previewMigration: mocks.preview,
      getMigration: mocks.getMigration,
      runMigration: mocks.run,
      refreshMigrationSourceSession: mocks.refreshSession,
    },
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
        source: "beehiiv",
        auth_method: "api_key",
        intake_available: true,
        commit_available: true,
        supports: { subscribers: true, automation_mode: "rebuild_review" },
      },
    ],
  });
  mocks.create.mockResolvedValue({
    data: { job_id: "job-wizard-session", account_id: "pub_one" },
  });
  mocks.preview.mockResolvedValue({
    data: { job_id: "job-wizard-session" },
  });
  mocks.run.mockResolvedValue({
    data: { job_id: "job-wizard-session" },
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

function previewJob(overrides: Partial<MigrationJob> = {}): MigrationJob {
  return {
    id: "job-wizard-session",
    source: "beehiiv",
    status: "awaiting_confirmation",
    started_at: "2026-08-01T00:00:00.000Z",
    source_session_expires_at: "2099-01-01T00:00:00.000Z",
    verification_report: {
      subscribers_imported: 12,
      data_loss_estimate_pct: 0,
      resource_completeness: [
        {
          resource: "subscribers",
          label: "Subscribers",
          source_total: 12,
          imported: 12,
          supported: true,
          status: "imported_runtime",
        },
      ],
    },
    ...overrides,
  };
}

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
    throw new Error("Missing button: " + label);
  }
  return match;
}

function setInput(input: HTMLInputElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 70; attempt += 1) {
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

async function connectToPreview(job: MigrationJob): Promise<void> {
  mocks.getMigration.mockResolvedValue({ data: job });
  render(<MigrationWizard initialSourceId="beehiiv" onClose={vi.fn()} />);
  await waitFor(() => expect(mocks.listSources).toHaveBeenCalledTimes(1));

  const inputs = Array.from(
    document.querySelectorAll<HTMLInputElement>("input"),
  );
  const apiKey = inputs.find((input) => input.type === "password");
  const publication = inputs.find((input) =>
    input.placeholder.includes("pub_"),
  );
  expect(apiKey).toBeDefined();
  expect(publication).toBeDefined();
  setInput(apiKey!, "initial-beehiiv-key");
  setInput(publication!, "pub_one");
  act(() => button("Connect & preview").click());
  await waitFor(() =>
    expect(document.body.textContent).toContain(
      "Dry-run for Beehiiv · exact job",
    ),
  );
}

describe("migration wizard source-session boundary", () => {
  it("clears accepted setup material before preview and does not restore it on edit", async () => {
    await connectToPreview(previewJob());

    act(() => button("Cancel").click());
    await waitFor(() =>
      expect(document.activeElement?.textContent).toBe("Step 2 of 5: Connect"),
    );
    const inputs = Array.from(
      document.querySelectorAll<HTMLInputElement>("input"),
    );
    expect(inputs.find((input) => input.type === "password")?.value).toBe("");
    expect(
      inputs.find((input) => input.placeholder.includes("pub_"))?.value,
    ).toBe("");
  });

  it("blocks the rendered commit, recovers the same job, and refetches before unlocking", async () => {
    const stale = previewJob({ source_session_expires_at: null });
    const healthy = previewJob();
    await connectToPreview(stale);

    const blocked = button("Import unavailable");
    expect(blocked.getAttribute("aria-disabled")).toBe("true");
    act(() => blocked.click());
    expect(mocks.run).not.toHaveBeenCalled();

    const recoveryKey = document.querySelector<HTMLInputElement>(
      'input[type="password"]',
    );
    expect(recoveryKey).not.toBeNull();
    setInput(recoveryKey!, "replacement-beehiiv-key");
    mocks.refreshSession.mockResolvedValue({ data: healthy });
    mocks.getMigration.mockResolvedValue({ data: healthy });
    act(() => button("Refresh this job's session").click());

    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "Looks good — start the real import",
      ),
    );
    expect(mocks.refreshSession).toHaveBeenCalledWith("job-wizard-session", {
      apiKey: "replacement-beehiiv-key",
      accountId: "",
      extra: {},
    });
    expect(mocks.getMigration.mock.calls.length).toBeGreaterThanOrEqual(2);

    act(() => button("Looks good — start the real import").click());
    await waitFor(() => expect(mocks.run).toHaveBeenCalledTimes(1));
    expect(mocks.run).toHaveBeenCalledWith(
      "beehiiv",
      "job-wizard-session",
      undefined,
    );
  });

  it("rechecks identity and status at click time even after a healthy render", async () => {
    const healthy = previewJob();
    await connectToPreview(healthy);
    expect(
      button("Looks good — start the real import").getAttribute(
        "aria-disabled",
      ),
    ).toBeNull();

    mocks.getMigration.mockResolvedValue({
      data: { ...healthy, source: "klaviyo" },
    });
    act(() => button("Looks good — start the real import").click());

    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "migration_commit_preflight_unavailable",
      ),
    );
    expect(mocks.run).not.toHaveBeenCalled();
  });
});
