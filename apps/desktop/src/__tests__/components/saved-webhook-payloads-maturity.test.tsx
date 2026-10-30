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
  success: vi.fn(),
  error: vi.fn(),
  recoveryScope: "a".repeat(64),
}));

vi.mock("../../components/Toast", () => ({
  toast: { success: mocks.success, error: mocks.error },
}));
vi.mock("../../lib/store", () => ({
  useMe: () => ({
    user: "same-api-key-actor",
    tenant: "tenant-1",
    credentialSource: "api-key",
    webhookPlaygroundRecoveryScope: mocks.recoveryScope,
  }),
}));

import { SavedPayloadsPanel } from "../../components/webhook-simulator/SavedPayloadsPanel";
import { sensitiveLocalVaultKey } from "../../lib/sensitive-local-data";
import { vaultGetJSON, vaultSetJSON } from "../../lib/secure-vault";

const STORAGE_KEY = "postwave.webhook-sim.saved-payloads.v1";
let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  localStorage.clear();
  mocks.recoveryScope = "a".repeat(64);
  mocks.success.mockReset();
  mocks.error.mockReset();
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function render(node: ReactElement): void {
  if (!container) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }
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
  let failure: unknown;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      failure = error;
      await act(async () => Promise.resolve());
    }
  }
  throw failure;
}

async function storedPayloads(
  scope = mocks.recoveryScope,
): Promise<Array<{ name: string; event_type: string; payload: string }>> {
  const record = await vaultGetJSON<{
    value: Array<{ name: string; event_type: string; payload: string }>;
  }>(sensitiveLocalVaultKey("webhook-fixtures", scope));
  return record?.value ?? [];
}

async function seedEncryptedPayloads(
  payloads: Array<{
    id: string;
    name: string;
    event_type: string;
    payload: string;
  }>,
): Promise<void> {
  const scope = mocks.recoveryScope;
  await vaultSetJSON(sensitiveLocalVaultKey("webhook-fixtures", scope), {
    version: 1,
    value: payloads,
  });
}

function panel(
  payload: string,
  eventType: string,
  onApply: (payload: string, eventType: string) => void = vi.fn(),
): ReactElement {
  return (
    <SavedPayloadsPanel
      currentPayload={payload}
      currentEventType={eventType}
      onApply={onApply}
    />
  );
}

describe("SavedPayloadsPanel maturity", () => {
  it("persists the exact opening snapshot once under rapid activation", async () => {
    const exactPayload = ' \n{"version":1}\n ';
    render(panel(exactPayload, "subscriber.created"));
    await waitFor(() =>
      expect(document.body.textContent).not.toContain(
        "Loading encrypted saved payloads",
      ),
    );
    act(() => button("+ Save").click());

    render(panel('{"version":2}', "campaign.sent"));
    const name = document.querySelector<HTMLInputElement>(
      "#saved-payload-name",
    );
    if (!name) throw new Error("Missing saved-payload name");
    setInput(name, "Original fixture");
    const save = button("Save payload");
    act(() => {
      save.click();
      save.click();
    });

    await waitFor(() => expect(mocks.success).toHaveBeenCalledTimes(1));
    const stored = await storedPayloads();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      name: "Original fixture",
      event_type: "subscriber.created",
      payload: exactPayload,
    });
    expect(mocks.success).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(
      Array.from({ length: localStorage.length }, (_, index) =>
        localStorage.getItem(localStorage.key(index) ?? ""),
      ).join(""),
    ).not.toContain("Original fixture");
  });

  it("keeps the modal open and tells the truth when device persistence fails", async () => {
    const setItemSpy = vi
      .spyOn(localStorage, "setItem")
      .mockImplementation(() => {
        throw new DOMException("Quota exceeded", "QuotaExceededError");
      });
    try {
      render(panel('{"ok":true}', "subscriber.updated"));
      await waitFor(() =>
        expect(document.body.textContent).not.toContain(
          "Loading encrypted saved payloads",
        ),
      );
      act(() => button("+ Save").click());
      const name = document.querySelector<HTMLInputElement>(
        "#saved-payload-name",
      );
      if (!name) throw new Error("Missing saved-payload name");
      setInput(name, "Quota fixture");
      act(() => button("Save payload").click());

      await waitFor(() =>
        expect(document.querySelector('[role="alert"]')?.textContent).toContain(
          "couldn't be encrypted",
        ),
      );
      expect(document.querySelector('[role="dialog"]')).not.toBeNull();
      expect(mocks.success).not.toHaveBeenCalled();
    } finally {
      setItemSpy.mockRestore();
    }
  });

  it("guards IME Enter, supports confirmed delete undo, and is axe-clean", async () => {
    await seedEncryptedPayloads([
      {
        id: "payload-1",
        name: "Happy path",
        event_type: "subscriber.created",
        payload: '{"email":"reader@example.com"}',
      },
    ]);
    render(panel('{"ok":true}', "subscriber.created"));
    await waitFor(() =>
      expect(document.body.textContent).toContain("Happy path"),
    );
    act(() => button("+ Save").click());
    const name = document.querySelector<HTMLInputElement>(
      "#saved-payload-name",
    );
    if (!name) throw new Error("Missing saved-payload name");
    const composingEnter = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
      isComposing: true,
    });
    act(() => {
      name.dispatchEvent(composingEnter);
    });
    expect(composingEnter.defaultPrevented).toBe(true);
    act(() => button("Cancel").click());

    const deleteButton = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Delete Happy path"]',
    );
    if (!deleteButton) throw new Error("Missing delete button");
    act(() => deleteButton.click());
    act(() => button("Delete").click());
    await waitFor(() =>
      expect(document.body.textContent).toContain("Undo delete of Happy path"),
    );
    act(() => button("Undo delete of Happy path").click());
    await waitFor(() =>
      expect(document.body.textContent).toContain("Restored Happy path."),
    );
    expect(await storedPayloads()).toHaveLength(1);
    expect(document.querySelector("[title]")).toBeNull();

    const result = await axe.run(document.body, {
      rules: { region: { enabled: false } },
    });
    expect(
      result.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);
  });

  it("purges an unowned plaintext fixture without exposing or adopting it", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        {
          id: "unowned-payload",
          name: "Previous account fixture",
          event_type: "subscriber.created",
          payload: '{"token":"do-not-import"}',
        },
      ]),
    );
    render(panel('{"ok":true}', "subscriber.created"));

    await waitFor(() => expect(localStorage.getItem(STORAGE_KEY)).toBeNull());
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "removed without importing or reading",
      ),
    );
    expect(document.body.textContent).not.toContain("Previous account fixture");
    expect(document.body.textContent).not.toContain("do-not-import");
    expect(await storedPayloads()).toEqual([]);
    expect(
      Array.from(document.querySelectorAll("button")).some(
        (candidate) =>
          candidate.textContent?.trim() === "Retry encrypted storage",
      ),
    ).toBe(false);
  });

  it("isolates same-actor API keys with different strong recovery scopes", async () => {
    const firstScope = mocks.recoveryScope;
    await seedEncryptedPayloads([
      {
        id: "first-key-payload",
        name: "First key fixture",
        event_type: "subscriber.created",
        payload: '{"owner":"first"}',
      },
    ]);
    render(panel('{"ok":true}', "subscriber.created"));
    await waitFor(() =>
      expect(document.body.textContent).toContain("First key fixture"),
    );

    mocks.recoveryScope = "b".repeat(64);
    render(panel('{"ok":true}', "subscriber.created"));
    await waitFor(() =>
      expect(document.body.textContent).not.toContain(
        "Loading encrypted saved payloads",
      ),
    );

    expect(document.body.textContent).not.toContain("First key fixture");
    expect(await storedPayloads(firstScope)).toHaveLength(1);
    expect(await storedPayloads()).toEqual([]);
  });

  it("purges ownership-ambiguous 16-hex fixture ciphertext without reading it", async () => {
    const retiredKey = `postwave.desktop.vault.v1:sensitive-local.v1.webhook-fixtures.${"f".repeat(16)}`;
    localStorage.setItem(retiredKey, "retired-ciphertext");
    const originalGet = localStorage.getItem.bind(localStorage);
    const reads: string[] = [];
    vi.spyOn(localStorage, "getItem").mockImplementation((key: string) => {
      reads.push(key);
      return originalGet(key);
    });

    render(panel('{"ok":true}', "subscriber.created"));
    await waitFor(() => expect(originalGet(retiredKey)).toBeNull());
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "removed without importing or reading",
      ),
    );

    expect(reads).not.toContain(retiredKey);
  });

  it("rejects escape-equivalent duplicate members before opening save review", async () => {
    render(panel('{"a":1,"\\u0061":2}', "subscriber.created"));
    await waitFor(() =>
      expect(document.body.textContent).not.toContain(
        "Loading encrypted saved payloads",
      ),
    );

    act(() => button("+ Save").click());

    expect(mocks.error).toHaveBeenCalledWith(
      "The current payload must be a valid JSON object before saving.",
    );
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(await storedPayloads()).toEqual([]);
  });
});
