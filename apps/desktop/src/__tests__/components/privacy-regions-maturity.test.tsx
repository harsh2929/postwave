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
  createRegion: vi.fn(),
  removeRegion: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  api: {
    privacyPortal: {
      regions: {
        create: mocks.createRegion,
        remove: mocks.removeRegion,
      },
    },
  },
}));

vi.mock("../../components/Toast", () => ({
  toast: {
    error: mocks.toastError,
    success: mocks.toastSuccess,
  },
}));

import { RegionsCard } from "../../components/privacy/RegionsCard";

const configuredRegion = {
  id: "privacy-region-config-123456789",
  region_code: "US-CA",
  framework: "ccpa" as const,
  requires_double_optin: false,
  requires_explicit_consent: true,
  do_not_sell_default: true,
  gpc_honored: true,
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createRegion.mockResolvedValue({ data: {} });
  mocks.removeRegion.mockResolvedValue({ data: {} });
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

function button(label: string): HTMLButtonElement {
  const match = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((candidate) => candidate.textContent?.trim() === label);
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

function setInput(target: HTMLInputElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(target, value);
    target.dispatchEvent(new Event("input", { bubbles: true }));
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

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("RegionsCard interaction maturity", () => {
  it("exposes complete regional consequences without tooltip-only information", async () => {
    render(<RegionsCard regions={[configuredRegion]} onChanged={vi.fn()} />);

    expect(document.body.textContent).toContain(
      "CCPA/CPRA — California privacy",
    );
    expect(document.body.textContent).toContain(configuredRegion.id);
    expect(document.body.textContent).toContain("Explicit consent");
    expect(document.body.textContent).toContain("Required");
    expect(document.body.textContent).toContain("Do-not-sell default");
    expect(document.body.textContent).toContain("Global Privacy Control");
    expect(document.body.textContent).toContain("Honored");
    expect(container?.querySelector("[title]")).toBeNull();
    expect(button("Remove").disabled).toBe(false);
    expect(button("Remove").getAttribute("aria-label")).toContain("US-CA");

    const result = await axe.run(container ?? document.body);
    expect(
      result.violations.filter(
        (violation) =>
          violation.impact === "critical" || violation.impact === "serious",
      ),
    ).toEqual([]);
  });

  it("shows actionable format and duplicate validation before mutation", async () => {
    render(<RegionsCard regions={[configuredRegion]} onChanged={vi.fn()} />);
    act(() => button("Add region").click());
    const code = document.querySelector<HTMLInputElement>(
      'input[name="region-code"]',
    );
    if (!code) throw new Error("Missing region code input");

    setInput(code, "invalid code");
    act(() => button("Add region").click());
    expect(mocks.createRegion).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      "Use 2–8 uppercase letters or numbers per segment, separated by hyphens.",
    );
    expect(code.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(code);

    setInput(code, "us-ca");
    act(() => button("Add region").click());
    expect(mocks.createRegion).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("US-CA is already configured.");
  });

  it("single-flights creation, keeps the busy action focusable, and confirms scope", async () => {
    const pending = deferred<{ data: Record<string, never> }>();
    mocks.createRegion.mockReturnValue(pending.promise);
    const onChanged = vi.fn();
    render(<RegionsCard regions={[]} onChanged={onChanged} />);
    act(() => button("Add region").click());
    const code = document.querySelector<HTMLInputElement>(
      'input[name="region-code"]',
    );
    if (!code) throw new Error("Missing region code input");
    setInput(code, "EU");

    const add = button("Add region");
    act(() => {
      add.click();
      add.click();
    });
    expect(mocks.createRegion).toHaveBeenCalledTimes(1);
    expect(button("Adding region…").disabled).toBe(false);
    expect(button("Adding region…").getAttribute("aria-disabled")).toBe("true");
    expect(document.body.textContent).toContain(
      "The draft is preserved until the server confirms the change.",
    );

    await act(async () => {
      pending.resolve({ data: {} });
      await pending.promise;
    });
    await flush();
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain("EU was added.");
    expect(document.body.textContent).toContain(
      "future send-eligibility checks",
    );
  });

  it("keeps a failed removal open and discloses only safe recovery metadata", async () => {
    mocks.removeRegion.mockResolvedValue({
      error: {
        kind: "network",
        code: "offline",
        requestId: "request-safe-123",
        message: "private database host and subscriber detail",
      },
    });
    render(<RegionsCard regions={[configuredRegion]} onChanged={vi.fn()} />);
    act(() => button("Remove").click());
    await act(async () => {
      button("Remove region").click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.removeRegion).toHaveBeenCalledWith(configuredRegion.id);
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
    expect(document.body.textContent).toContain(
      "The service could not be reached. Check the connection and retry.",
    );
    expect(document.body.textContent).toContain("request request-safe-123");
    expect(document.body.textContent).not.toContain("private database host");
    expect(mocks.toastError).toHaveBeenCalledWith({
      message:
        "The service could not be reached. Check the connection and retry.",
      detail:
        "No region change was confirmed; the region remains configured. Support reference: code offline, request request-safe-123.",
    });
  });
});
