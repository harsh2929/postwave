// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
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
  openUrl: vi.fn(async () => undefined),
  requestNew: vi.fn(),
  useAnother: vi.fn(),
  retry: vi.fn(),
}));

vi.mock("../../components/AuthShell", () => ({
  AuthShell: ({
    heading,
    headingSub,
    children,
  }: {
    heading: ReactNode;
    headingSub?: ReactNode;
    children: ReactNode;
  }) => (
    <main>
      <h1>{heading}</h1>
      <p>{headingSub}</p>
      {children}
    </main>
  ),
}));

vi.mock("../../lib/dashboard-url", () => ({
  getDashboardUrl: () => "https://app.moosewave.com",
  buildDashboardHref: (base: string, path: string) => `${base}${path}`,
}));

vi.mock("../../lib/tauri", () => ({
  tauriApi: { openUrl: mocks.openUrl },
}));

import { AuthLinkRecovery } from "../../pages/AuthLinkRecovery";

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

function button(label: string): HTMLButtonElement {
  const match = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!(match instanceof HTMLButtonElement)) {
    throw new Error(`button not found: ${label}`);
  }
  return match;
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe("AuthLinkRecovery", () => {
  it("focuses the alert and exposes every recovery route", async () => {
    act(() =>
      root.render(
        <AuthLinkRecovery
          flow="reset"
          reason="temporary_failure"
          onRequestNewLink={mocks.requestNew}
          onUseAnotherMethod={mocks.useAnother}
          onRetry={mocks.retry}
        />,
      ),
    );

    const alert = container.querySelector('[role="alert"]');
    expect(document.activeElement).toBe(alert);
    expect(alert?.getAttribute("aria-label")).toMatch(/could not finish/i);
    act(() => button("Retry this link").click());
    act(() => button("Request a new reset link").click());
    act(() => button("Use another sign-in method").click());
    await act(async () => button("Continue in browser").click());
    await act(async () => button("Contact support").click());

    expect(mocks.retry).toHaveBeenCalledOnce();
    expect(mocks.requestNew).toHaveBeenCalledOnce();
    expect(mocks.useAnother).toHaveBeenCalledOnce();
    expect(mocks.openUrl).toHaveBeenNthCalledWith(
      1,
      "https://app.moosewave.com/forgot-password",
    );
    expect(mocks.openUrl).toHaveBeenNthCalledWith(
      2,
      "https://docs.moosewave.com/",
    );
  });

  it("explains unsupported links and defaults to a fresh-link primary action", () => {
    act(() =>
      root.render(
        <AuthLinkRecovery
          flow="magic"
          reason="unsupported_version"
          onRequestNewLink={mocks.requestNew}
          onUseAnotherMethod={mocks.useAnother}
        />,
      ),
    );
    expect(container.textContent).toMatch(/newer version of Moosewave/i);
    expect(button("Request a new sign-in link").className).toContain(
      "btn-primary",
    );
    expect(container.textContent).not.toContain("Retry this link");
  });
});
