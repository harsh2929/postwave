// @vitest-environment happy-dom

import { act } from "react";
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

const mocks = vi.hoisted(() => ({ activity: vi.fn() }));

vi.mock("../../lib/api-client", () => ({
  api: { getSMSConversationActivity: mocks.activity },
}));

import { ActivityFeed } from "../../components/sms/ActivityFeed";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "visible",
  });
  mocks.activity.mockReset();
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
});

function render(phone = "+12025550101"): void {
  if (!container) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }
  act(() => root?.render(<ActivityFeed phone={phone} />));
}

async function openActivity(): Promise<void> {
  const details = document.querySelector("details");
  if (!(details instanceof HTMLDetailsElement)) {
    throw new Error("Missing activity disclosure");
  }
  await act(async () => {
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
    await Promise.resolve();
  });
}

describe("ActivityFeed evidence truth and cancellation", () => {
  it("aborts the confidential request on disclosure close and unmount", async () => {
    mocks.activity.mockReturnValue(new Promise(() => undefined));
    render();
    await openActivity();
    const signal = mocks.activity.mock.calls[0]?.[1]?.signal as
      | AbortSignal
      | undefined;
    expect(signal?.aborted).toBe(false);

    const details = document.querySelector("details") as HTMLDetailsElement;
    act(() => {
      details.open = false;
      details.dispatchEvent(new Event("toggle"));
    });
    expect(signal?.aborted).toBe(true);

    await openActivity();
    const secondSignal = mocks.activity.mock.calls[1]?.[1]?.signal as
      | AbortSignal
      | undefined;
    expect(secondSignal?.aborted).toBe(false);
    act(() => root?.unmount());
    root = null;
    expect(secondSignal?.aborted).toBe(true);
  });

  it("aborts the prior phone owner instead of only ignoring its result", async () => {
    mocks.activity.mockReturnValue(new Promise(() => undefined));
    render("+12025550101");
    await openActivity();
    const signal = mocks.activity.mock.calls[0]?.[1]?.signal as
      | AbortSignal
      | undefined;
    render("+12025550102");
    expect(signal?.aborted).toBe(true);
    expect(document.querySelector("details")?.hasAttribute("open")).toBe(false);
  });

  it("states the bounded evidence sources and explicit truncation truth", async () => {
    mocks.activity.mockResolvedValue({
      data: {
        tenantId: "10000000-0000-4000-8000-000000000001",
        phoneE164: "+12025550101",
        events: [],
        snapshotAt: "2026-08-21T11:55:00.000Z",
        truncated: true,
        sourcePlanes: ["sms_consent_events", "sms_subscriptions_current"],
        historyComplete: false,
      },
    });
    render();
    await openActivity();
    await act(async () => Promise.resolve());

    expect(document.body.textContent).toContain(
      "No events in the loaded evidence sources.",
    );
    expect(document.body.textContent).toContain(
      "This is not complete suppression or operator-state history.",
    );
    expect(document.body.textContent).toContain(
      "The server reports that the loaded evidence window is truncated.",
    );
    expect(document.body.textContent).not.toContain(
      "No lifecycle events recorded yet",
    );
  });
});
