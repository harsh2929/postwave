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

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  mint: vi.fn(),
  revoke: vi.fn(),
  writeClipboardText: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  getApiUrl: () => "https://api.example.test",
  podcastTokensApi: {
    get: mocks.get,
    mint: mocks.mint,
    revoke: mocks.revoke,
  },
}));

vi.mock("../../lib/clipboard", () => ({
  clipboardSuccessDetail: () => "Clipboard clears after 60 seconds.",
  writeClipboardText: mocks.writeClipboardText,
}));

vi.mock("../../components/Toast", () => ({
  toast: {
    error: mocks.toastError,
    success: mocks.toastSuccess,
  },
}));

import { PodcastTokensCard } from "../../components/archive/PodcastTokensCard";
import {
  inspectLifecycle,
  resetLifecycleCoordinatorForTests,
  type LifecycleIntent,
} from "../../lib/lifecycle-coordinator";

const quitIntent: LifecycleIntent = {
  kind: "quit-app",
  disposition: "exit",
  title: "Quit Moosewave?",
  description: "Review active work.",
  confirmLabel: "Quit",
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  window.localStorage.setItem("postwave_tenant_slug", "acme");
  mocks.get.mockResolvedValue({
    error: { status: 404, message: "not found" },
  });
  mocks.mint.mockResolvedValue({
    data: {
      tenant_id: "tenant-1",
      subscriber_email: "first@example.test",
      token: "podcast-secret",
      feed_url: "https://feeds.example.test/private/podcast-secret",
      created_at: "2026-07-16T00:00:00Z",
      updated_at: "2026-07-16T00:00:00Z",
    },
  });
  mocks.revoke.mockResolvedValue({ data: { ok: true } });
  mocks.writeClipboardText.mockResolvedValue({
    ok: true,
    clearScheduled: true,
  });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  window.localStorage.clear();
  resetLifecycleCoordinatorForTests();
});

function render(node: ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

function button(label: string): HTMLButtonElement {
  const found = Array.from(document.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!found) throw new Error(`Expected button: ${label}`);
  return found;
}

function setEmail(value: string): void {
  const input = document.querySelector<HTMLInputElement>(
    "#podcast-token-email",
  );
  if (!input) throw new Error("Expected podcast email field");
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function privateCopyButton(): HTMLButtonElement {
  const input = document.querySelector("#podcast-private-feed");
  const found = input?.parentElement?.querySelector("button");
  if (!(found instanceof HTMLButtonElement)) {
    throw new Error("Expected private feed copy button");
  }
  return found;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function mintShownOnceFeed(): Promise<void> {
  setEmail("first@example.test");
  act(() => button("Look up").click());
  await flush();
  act(() => button("Mint token").click());
  await flush();
  expect(document.querySelector("#podcast-private-feed")).not.toBeNull();
}

describe("private podcast shown-once lifecycle", () => {
  it("keeps failed copies protected and zeroizes only after a successful copy", async () => {
    render(<PodcastTokensCard canMutate />);
    await mintShownOnceFeed();

    await expect(inspectLifecycle(quitIntent)).resolves.toMatchObject([
      {
        label: "Private podcast feed URL",
        level: "blocking",
        canSave: false,
        canDiscard: false,
      },
    ]);

    mocks.writeClipboardText.mockResolvedValueOnce({
      ok: false,
      message: "clipboard denied",
    });
    act(() => privateCopyButton().click());
    await flush();
    expect(document.querySelector("#podcast-private-feed")).not.toBeNull();
    await expect(inspectLifecycle(quitIntent)).resolves.toHaveLength(1);

    mocks.writeClipboardText.mockResolvedValueOnce({
      ok: true,
      clearScheduled: true,
    });
    act(() => privateCopyButton().click());
    await flush();
    expect(document.querySelector("#podcast-private-feed")).toBeNull();
    expect(document.body.textContent).not.toContain("podcast-secret");
    await expect(inspectLifecycle(quitIntent)).resolves.toEqual([]);
  });

  it("requires explicit abandon before a different subscriber replaces the reveal", async () => {
    render(<PodcastTokensCard canMutate />);
    await mintShownOnceFeed();
    expect(mocks.get).toHaveBeenCalledTimes(1);

    // Even a stale same-subscriber lookup that reports no metadata must not
    // expose a direct mint path capable of overwriting the live plaintext.
    act(() => button("Look up").click());
    await flush();
    act(() => button("Mint token").click());
    expect(button("Discard and rotate")).toBeTruthy();
    expect(mocks.mint).toHaveBeenCalledTimes(1);
    act(() => button("Keep URL open").click());

    setEmail("second@example.test");
    act(() => button("Look up").click());
    expect(button("Discard and look up")).toBeTruthy();
    expect(mocks.get).toHaveBeenCalledTimes(2);
    await expect(inspectLifecycle(quitIntent)).resolves.toHaveLength(1);

    act(() => button("Discard and look up").click());
    await flush();
    expect(mocks.get).toHaveBeenCalledTimes(3);
    expect(document.body.textContent).not.toContain("podcast-secret");
    await expect(inspectLifecycle(quitIntent)).resolves.toEqual([]);
  });

  it("contains a thrown mint, releases the operation guard, and keeps retry available", async () => {
    mocks.mint.mockRejectedValueOnce(new Error("network down"));
    render(<PodcastTokensCard canMutate />);
    setEmail("first@example.test");
    act(() => button("Look up").click());
    await flush();
    act(() => button("Mint token").click());
    await flush();

    expect(mocks.toastError).toHaveBeenCalledWith(
      expect.stringContaining("network down"),
    );
    expect(button("Mint token").disabled).toBe(false);
    await expect(inspectLifecycle(quitIntent)).resolves.toEqual([]);
  });
});
