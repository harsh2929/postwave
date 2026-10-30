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

import type { FrameworkMeta } from "../../components/compliance/FrameworkMeta";
import {
  inspectLifecycle,
  resetLifecycleCoordinatorForTests,
  type LifecycleIntent,
} from "../../lib/lifecycle-coordinator";

const mocks = vi.hoisted(() => ({
  attest: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  api: { attestComplianceProgram: mocks.attest },
}));

vi.mock("../../components/Toast", () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));

import { AttestModal } from "../../components/compliance/AttestModal";

let container: HTMLDivElement | null = null;
let root: Root | null = null;
const quitIntent: LifecycleIntent = {
  kind: "quit-app",
  disposition: "exit",
  title: "Quit Moosewave?",
  description: "Review active work.",
  confirmLabel: "Quit",
};

beforeAll(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.attest.mockResolvedValue({ data: undefined });
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
  resetLifecycleCoordinatorForTests();
});

function meta(overrides: Partial<FrameworkMeta> = {}): FrameworkMeta {
  return {
    slug: "soc2",
    short: "SOC 2",
    full: "SOC 2 Type II",
    blurb: "Independent controls attestation.",
    region: "Global",
    renewalCadenceMonths: 12,
    url: "https://example.com/soc2",
    gates: [],
    ...overrides,
  };
}

function modal({
  framework = meta(),
  onClose = vi.fn(),
  onDone = vi.fn(),
}: {
  framework?: FrameworkMeta;
  onClose?: () => void;
  onDone?: () => void | Promise<void>;
} = {}): ReactElement {
  return (
    <AttestModal
      key={framework.slug}
      meta={framework}
      onClose={onClose}
      onDone={onDone}
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

function setField(id: string, value: string): void {
  const element = document.querySelector<
    HTMLInputElement | HTMLTextAreaElement
  >(`#${id}`);
  if (!element) throw new Error(`Missing field: ${id}`);
  const prototype =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
      element,
      value,
    );
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function flush(): Promise<void> {
  await act(async () => {
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

describe("AttestModal", () => {
  it("validates required signer and tamper-evidence fields inline", async () => {
    render(modal());
    act(() => button("Record attestation").click());
    await flush();
    expect(document.body.textContent).toContain("Signer email required");
    expect(mocks.attest).not.toHaveBeenCalled();

    setField("attest-email", "not-an-email");
    setField("attest-sha", "abc");
    act(() => button("Record attestation").click());
    await flush();
    expect(document.body.textContent).toContain("Enter a valid email address");
    expect(document.body.textContent).toContain("Must be 64 hex characters");
    expect(mocks.attest).not.toHaveBeenCalled();
  });

  it("submits the exact normalized evidence and awaits completion", async () => {
    const onDone = vi.fn().mockResolvedValue(undefined);
    render(modal({ onDone }));
    setField("attest-email", " security@example.com ");
    setField("attest-name", " Acme Legal ");
    setField("attest-doc", " s3://evidence/soc2.pdf ");
    setField("attest-sha", "a".repeat(64));
    setField("attest-notes", " Current scope ");
    setField("attest-renewal", "");
    act(() => button("Record attestation").click());
    await flush();

    expect(mocks.attest).toHaveBeenCalledWith("soc2", {
      signedByEmail: "security@example.com",
      signerName: "Acme Legal",
      documentPath: "s3://evidence/soc2.pdf",
      documentSha256: "a".repeat(64),
      notes: "Current scope",
      renewalAt: undefined,
    });
    expect(mocks.toastSuccess).toHaveBeenCalledWith("Attested to SOC 2");
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(button("Record attestation").disabled).toBe(false);
  });

  it("retains an accepted request after unmount until it settles", async () => {
    const request = deferred<{ data: undefined }>();
    const onDone = vi.fn();
    mocks.attest.mockReturnValueOnce(request.promise);
    const view = render(modal({ onDone }));
    setField("attest-email", "security@example.com");
    act(() => button("Record attestation").click());
    view.rerender(<></>);

    await expect(inspectLifecycle(quitIntent)).resolves.toMatchObject([
      {
        label: "SOC 2 attestation draft operation",
        level: "blocking",
        canSave: false,
        canDiscard: false,
      },
    ]);

    request.resolve({ data: undefined });
    await flush();
    expect(mocks.toastSuccess).toHaveBeenCalledWith("Attested to SOC 2");
    expect(onDone).toHaveBeenCalledTimes(1);
    await expect(inspectLifecycle(quitIntent)).resolves.toEqual([]);
  });

  it("keys framework identity while retaining the accepted old request", async () => {
    const request = deferred<{ data: undefined }>();
    const onDone = vi.fn();
    mocks.attest.mockReturnValueOnce(request.promise);
    const view = render(modal({ onDone }));
    setField("attest-email", "security@example.com");
    act(() => button("Record attestation").click());

    view.rerender(
      modal({
        framework: meta({
          slug: "gdpr",
          short: "GDPR",
          full: "General Data Protection Regulation",
          renewalCadenceMonths: null,
        }),
        onDone,
      }),
    );
    expect(
      document.querySelector<HTMLInputElement>("#attest-email")?.value,
    ).toBe("");
    expect(document.body.textContent).toContain("Attest to GDPR");

    request.resolve({ data: undefined });
    await flush();
    expect(mocks.toastSuccess).toHaveBeenCalledWith("Attested to SOC 2");
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("requires explicit discard for a dirty action draft", async () => {
    const onClose = vi.fn();
    render(modal({ onClose }));
    setField("attest-email", "security@example.com");

    await expect(inspectLifecycle(quitIntent)).resolves.toMatchObject([
      {
        label: "SOC 2 attestation draft",
        level: "warning",
        canSave: false,
        canDiscard: true,
      },
    ]);
    act(() => button("Cancel").click());
    expect(document.body.textContent).toContain("Discard attestation draft?");
    expect(onClose).not.toHaveBeenCalled();

    act(() => button("Discard draft").click());
    await flush();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(
      document.querySelector<HTMLInputElement>("#attest-email")?.value,
    ).toBe("");
    await expect(inspectLifecycle(quitIntent)).resolves.toEqual([]);
  });
});
