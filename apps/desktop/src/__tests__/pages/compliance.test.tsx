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
  ComplianceEvent,
  ComplianceFramework,
  ComplianceProgram,
} from "../../lib/api-client";

const mocks = vi.hoisted(() => ({
  canAdmin: { value: true },
  downloadAIVSBundle: vi.fn(),
  getAuditStats: vi.fn(),
  getComplianceProgram: vi.fn(),
  listComplianceEvents: vi.fn(),
  listCompliancePrograms: vi.fn(),
  listRetentionActivity: vi.fn(),
  revokeComplianceProgram: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  api: {
    downloadAIVSBundle: mocks.downloadAIVSBundle,
    getAuditStats: mocks.getAuditStats,
    getComplianceProgram: mocks.getComplianceProgram,
    listComplianceEvents: mocks.listComplianceEvents,
    listCompliancePrograms: mocks.listCompliancePrograms,
    listRetentionActivity: mocks.listRetentionActivity,
    revokeComplianceProgram: mocks.revokeComplianceProgram,
  },
}));

vi.mock("../../lib/store", () => ({
  useCanAdmin: () => mocks.canAdmin.value,
}));

vi.mock("../../components/Toast", () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));

vi.mock("../../components/compliance/FrameworkCard", () => ({
  FrameworkCard: ({
    program,
    onOpen,
  }: {
    program: ComplianceProgram;
    onOpen: () => void;
  }) => (
    <button type="button" onClick={onOpen}>
      open:{program.framework}
    </button>
  ),
}));

vi.mock("../../components/compliance/IntegrityPanel", () => ({
  IntegrityPanel: () => <div>integrity-panel</div>,
}));

vi.mock("../../components/compliance/AttestModal", () => ({
  AttestModal: ({
    onDone,
    onClose,
  }: {
    onDone: () => void | Promise<void>;
    onClose: () => void;
  }) => (
    <div role="dialog" aria-label="attest-modal">
      <button type="button" onClick={() => void onDone()}>
        Complete attestation
      </button>
      <button type="button" onClick={onClose}>
        Close attestation
      </button>
    </div>
  ),
}));

import { Compliance } from "../../pages/Compliance";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  for (const mock of Object.values(mocks)) {
    if (typeof mock === "function" && "mockReset" in mock) mock.mockReset();
  }
  mocks.canAdmin.value = true;
  mocks.listCompliancePrograms.mockResolvedValue({
    data: { programs: [program("soc2"), program("gdpr")] },
  });
  mocks.getComplianceProgram.mockImplementation(
    (framework: ComplianceFramework) =>
      Promise.resolve({ data: program(framework) }),
  );
  mocks.listComplianceEvents.mockImplementation(
    (framework: ComplianceFramework) =>
      Promise.resolve({ data: { events: [complianceEvent(framework)] } }),
  );
  mocks.getAuditStats.mockResolvedValue({ data: { totalEvents: 0 } });
  mocks.listRetentionActivity.mockResolvedValue({
    data: { events: [], total_purged_last_30d: 0 },
  });
  mocks.revokeComplianceProgram.mockResolvedValue({ data: undefined });
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

function program(
  framework: ComplianceFramework,
  overrides: Partial<ComplianceProgram> = {},
): ComplianceProgram {
  return {
    framework,
    status: "in_progress",
    ...overrides,
  };
}

function complianceEvent(
  framework: ComplianceFramework,
  overrides: Partial<ComplianceEvent> = {},
): ComplianceEvent {
  return {
    id: framework === "soc2" ? 1 : 2,
    framework,
    eventType: "attested",
    signedByEmail: `${framework}@example.com`,
    notes: `${framework} evidence`,
    at: "2026-07-15T08:00:00.000Z",
    ...overrides,
  };
}

function render(node: ReactElement = <Compliance />): {
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

function hasButton(label: string): boolean {
  return Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).some((candidate) => candidate.textContent?.trim() === label);
}

function setTextarea(id: string, value: string): void {
  const element = document.querySelector<HTMLTextAreaElement>(`#${id}`);
  if (!element) throw new Error(`Missing textarea: ${id}`);
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 40; attempt += 1) {
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

async function waitForPageReady(): Promise<void> {
  await waitFor(() => {
    expect(document.body.textContent).toContain(
      "No retention-purge events recorded yet",
    );
    expect(document.body.textContent).toContain(
      "0 agent-actor events in the trailing 30-day window",
    );
    expect(mocks.listCompliancePrograms).toHaveBeenCalled();
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

describe("Compliance framework detail", () => {
  it("loads a framework status and immutable event ledger", async () => {
    mocks.getComplianceProgram.mockResolvedValueOnce({
      data: program("soc2", {
        status: "attested",
        signedByEmail: "security@example.com",
        attestedAt: "2026-07-14T08:00:00.000Z",
      }),
    });
    render();
    await waitForPageReady();
    act(() => button("open:soc2").click());

    await waitFor(() => {
      expect(document.body.textContent).toContain("SOC 2 attestation recorded");
      expect(document.body.textContent).toContain("security@example.com");
      expect(document.body.textContent).toContain("soc2 evidence");
    });
    expect(mocks.getComplianceProgram).toHaveBeenCalledWith("soc2");
    expect(mocks.listComplianceEvents).toHaveBeenCalledWith("soc2");
  });

  it("keeps the newest framework when older requests finish last", async () => {
    const oldProgram = deferred<{ data: ComplianceProgram }>();
    const oldEvents = deferred<{ data: { events: ComplianceEvent[] } }>();
    mocks.getComplianceProgram.mockImplementation(
      (framework: ComplianceFramework) =>
        framework === "soc2"
          ? oldProgram.promise
          : Promise.resolve({ data: program(framework) }),
    );
    mocks.listComplianceEvents.mockImplementation(
      (framework: ComplianceFramework) =>
        framework === "soc2"
          ? oldEvents.promise
          : Promise.resolve({
              data: { events: [complianceEvent("gdpr")] },
            }),
    );
    render();
    await waitForPageReady();
    act(() => button("open:soc2").click());
    await waitFor(() =>
      expect(mocks.getComplianceProgram).toHaveBeenCalledWith("soc2"),
    );
    act(() => button("open:gdpr").click());

    await waitFor(() => {
      expect(document.body.textContent).toContain("GDPR not attested");
      expect(document.body.textContent).toContain("gdpr evidence");
    });
    oldProgram.resolve({
      data: program("soc2", {
        status: "attested",
        signedByEmail: "stale@example.com",
      }),
    });
    oldEvents.resolve({
      data: {
        events: [complianceEvent("soc2", { notes: "stale ledger" })],
      },
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain("GDPR not attested");
    expect(document.body.textContent).not.toContain("stale@example.com");
    expect(document.body.textContent).not.toContain("stale ledger");
  });

  it("revokes with the exact reason, locks the modal, and refreshes both views", async () => {
    const revoke = deferred<{ data: undefined }>();
    mocks.getComplianceProgram.mockResolvedValue({
      data: program("soc2", {
        status: "attested",
        updatedAt: "2026-07-16T00:00:00Z",
      }),
    });
    mocks.revokeComplianceProgram.mockReturnValueOnce(revoke.promise);
    render();
    await waitForPageReady();
    expect(mocks.listCompliancePrograms).toHaveBeenCalledTimes(1);
    act(() => button("open:soc2").click());
    await waitFor(() =>
      expect(document.body.textContent).toContain("Record renewal"),
    );

    act(() => button("Revoke").click());
    setTextarea("revoke-reason", "Scope changed");
    act(() => button("Revoke SOC 2").click());
    expect(mocks.revokeComplianceProgram).toHaveBeenCalledWith(
      "soc2",
      "Scope changed",
      "2026-07-16T00:00:00Z",
    );
    expect(button("Revoking…").disabled).toBe(true);
    expect(button("Cancel").disabled).toBe(true);

    revoke.resolve({ data: undefined });
    await waitFor(() => {
      expect(mocks.getComplianceProgram).toHaveBeenCalledTimes(2);
      expect(mocks.listCompliancePrograms).toHaveBeenCalledTimes(2);
    });
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      "SOC 2 attestation revoked",
    );
  });

  it("fails closed when status is unavailable while preserving ledger evidence", async () => {
    mocks.getComplianceProgram.mockResolvedValueOnce({
      error: { status: 503, message: "status store unavailable" },
    });
    render();
    await waitForPageReady();
    act(() => button("open:soc2").click());

    await waitFor(() => {
      expect(document.body.textContent).toContain("status store unavailable");
      expect(document.body.textContent).toContain("soc2 evidence");
    });
    expect(hasButton("Attest")).toBe(false);
    expect(hasButton("Revoke")).toBe(false);
  });

  it("reloads the detail and catalogue after a completed attestation", async () => {
    render();
    await waitForPageReady();
    act(() => button("open:soc2").click());
    await waitFor(() =>
      expect(document.body.textContent).toContain("SOC 2 not attested"),
    );
    act(() => button("Attest").click());
    act(() => button("Complete attestation").click());

    await waitFor(() => {
      expect(mocks.getComplianceProgram).toHaveBeenCalledTimes(2);
      expect(mocks.listCompliancePrograms).toHaveBeenCalledTimes(2);
    });
  });
});
