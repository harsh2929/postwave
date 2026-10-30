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
  copy: vi.fn(),
  save: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  getApiUrl: () => "https://api.example.test",
}));

vi.mock("../../lib/clipboard", () => ({
  clipboardSuccessDetail: () =>
    "The secret will be cleared from the current clipboard after 60 seconds if unchanged.",
  writeClipboardText: mocks.copy,
}));

vi.mock("../../lib/file-transfer", () => ({
  saveFile: mocks.save,
}));

vi.mock("../../components/Toast", () => ({
  toast: {
    error: mocks.toastError,
    success: mocks.toastSuccess,
  },
}));

import { AgentConnectCard } from "../../components/ai/AgentConnectCard";

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
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.copy.mockResolvedValue({
    ok: true,
    backend: "web",
    contentClass: "secret",
    clearScheduled: true,
    clearAfterMs: 60_000,
    historyWarning: "Clipboard history may retain this secret.",
  });
  mocks.save.mockResolvedValue({
    ok: true,
    status: "saved",
    transferId: "save-1",
    collision: false,
  });
  localStorage.clear();
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  document.body.style.overflow = "";
  vi.clearAllMocks();
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
  if (!match) throw new Error("Missing button: " + label);
  return match;
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

describe("AgentConnectCard maturity", () => {
  it("single-flights secret clipboard writes with the secret policy", async () => {
    const clipboard = deferred<{
      ok: true;
      backend: "web";
      contentClass: "secret";
      clearScheduled: true;
      clearAfterMs: number;
      historyWarning: string;
    }>();
    mocks.copy.mockReturnValueOnce(clipboard.promise);
    render(<AgentConnectCard apiKey="pw_live_shown_once" />);

    const copy = button("Copy configuration");
    act(() => {
      copy.click();
      copy.click();
    });

    expect(mocks.copy).toHaveBeenCalledTimes(1);
    expect(mocks.copy).toHaveBeenCalledWith(
      expect.stringContaining("pw_live_shown_once"),
      {
        contentClass: "secret",
        label: "Agent connection configuration",
        clearIfUnchangedAfterMs: 60_000,
      },
    );
    expect(copy.disabled).toBe(false);
    expect(copy.getAttribute("aria-disabled")).toBe("true");

    clipboard.resolve({
      ok: true,
      backend: "web",
      contentClass: "secret",
      clearScheduled: true,
      clearAfterMs: 60_000,
      historyWarning: "Clipboard history may retain this secret.",
    });
    await act(async () => {
      await clipboard.promise;
      await Promise.resolve();
    });
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Configuration copied" }),
    );
  });

  it("requires explicit confirmation before writing a plaintext key to disk", async () => {
    const save = deferred<{
      ok: true;
      status: "saved";
      transferId: string;
      collision: false;
    }>();
    mocks.save.mockReturnValueOnce(save.promise);
    render(<AgentConnectCard apiKey="pw_live_disk_secret" />);

    act(() => button("Save credential config…").click());
    expect(mocks.save).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();

    const confirm = button("Save credential file…");
    act(() => {
      confirm.click();
      confirm.click();
    });
    expect(mocks.save).toHaveBeenCalledTimes(1);
    expect(mocks.save).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.stringContaining("pw_live_disk_secret"),
        privacy: "confidential",
      }),
    );

    save.resolve({
      ok: true,
      status: "saved",
      transferId: "save-1",
      collision: false,
    });
    await act(async () => {
      await save.promise;
      await Promise.resolve();
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("labels placeholder truth and saves it without credential ceremony", async () => {
    render(<AgentConnectCard apiKey="" />);
    expect(document.body.textContent).toContain(
      "Placeholder · cannot authenticate",
    );
    expect(document.body.textContent).toContain(
      "Insert a key before connecting",
    );

    act(() => button("Save placeholder config…").click());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.save).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.stringContaining("{{API_KEY}}"),
        privacy: "personal",
      }),
    );
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("repairs an obsolete or tampered client preference", () => {
    localStorage.setItem(
      "postwave.mcp.client.v1",
      "<invalid-client>pw_live_should_not_persist",
    );
    render(<AgentConnectCard apiKey="" />);

    expect(
      document.querySelector('[role="tab"][aria-selected="true"]')?.textContent,
    ).toContain("Claude Code");
    expect(localStorage.getItem("postwave.mcp.client.v1")).toBe("Claude Code");
    expect(localStorage.getItem("postwave.mcp.client.v1")).not.toContain(
      "pw_live_should_not_persist",
    );
  });

  it("has no title-only or native-disabled interaction and passes axe", async () => {
    render(<AgentConnectCard apiKey="pw_live_accessible" />);

    expect(container?.querySelectorAll("[title]")).toHaveLength(0);
    expect(container?.querySelectorAll(":disabled")).toHaveLength(0);
    const result = await axe.run(container!);
    expect(
      result.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);
  });

  it("mounts no runnable transfer action in a release-held projection", () => {
    render(<AgentConnectCard apiKey="" transfersEnabled={false} />);

    expect(document.body.textContent).toContain(
      "FORMAT REFERENCE — NOT A RUNNABLE CONFIGURATION",
    );
    expect(document.body.textContent).toContain(
      "No transfer actions are mounted",
    );
    expect(button).toBeDefined();
    expect(
      Array.from(document.querySelectorAll("button")).some((candidate) =>
        /copy|save/iu.test(candidate.textContent ?? ""),
      ),
    ).toBe(false);
    expect(document.body.textContent).not.toContain("{{API_KEY}}");
  });
});
