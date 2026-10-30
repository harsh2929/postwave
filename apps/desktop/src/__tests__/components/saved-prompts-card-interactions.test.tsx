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
  getVoiceTemplates: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  api: { getVoiceTemplates: mocks.getVoiceTemplates },
}));
vi.mock("../../lib/store", () => ({
  tenantScopedKey: (tenantId: string, suffix: string) =>
    `pw:tenant:${tenantId}:${suffix}`,
  useMe: () => ({ user: "user-1", tenant: "tenant-1" }),
}));

import { SavedPromptsCard } from "../../components/ai/SavedPromptsCard";
import {
  sensitiveLocalIdentityScope,
  sensitiveLocalVaultKey,
} from "../../lib/sensitive-local-data";
import { vaultSetJSON } from "../../lib/secure-vault";

const STORAGE_KEY = "postwave.ai.saved-prompts.v1";
const TENANT_LEGACY_STORAGE_KEY = "pw:tenant:tenant-1:saved-prompts.v1";
let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  localStorage.clear();
  mocks.getVoiceTemplates.mockReset();
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

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
    throw new Error(`Missing ${label} button`);
  }
  return match;
}

function changeInput(input: HTMLInputElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function seedEncryptedPrompts(
  prompts: Array<{ id: string; name: string; prompt: string }>,
): Promise<void> {
  const scope = sensitiveLocalIdentityScope("user-1", "tenant-1");
  if (!scope) throw new Error("Missing test identity scope");
  await vaultSetJSON(sensitiveLocalVaultKey("ai-prompts", scope), {
    version: 1,
    value: prompts,
  });
}

async function waitFor(assertion: () => void): Promise<void> {
  let failure: unknown;
  for (let attempt = 0; attempt < 50; attempt += 1) {
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

describe("SavedPromptsCard interactions", () => {
  it("keeps save reasons visible and makes the naming flow IME-safe", async () => {
    mocks.getVoiceTemplates.mockResolvedValue({ data: { items: [] } });
    const onApply = vi.fn();
    render(<SavedPromptsCard currentPrompt="" onApply={onApply} />);
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "No voice templates are available.",
      ),
    );
    await waitFor(() =>
      expect(document.body.textContent).not.toContain(
        "Loading encrypted saved prompts",
      ),
    );

    const unavailable = button("+ Save");
    expect(unavailable.disabled).toBe(false);
    expect(unavailable.getAttribute("aria-disabled")).toBe("true");
    const reasonId = unavailable.getAttribute("aria-describedby");
    expect(document.getElementById(reasonId ?? "")?.textContent).toBe(
      "Type a prompt in the chat composer before saving it.",
    );
    expect(document.querySelector("[title]")).toBeNull();

    render(
      <SavedPromptsCard
        currentPrompt="Draft a weekly recap"
        onApply={onApply}
      />,
    );
    act(() => button("+ Save").click());
    const name = document.querySelector<HTMLInputElement>(
      'input[aria-label="Prompt name"]',
    );
    expect(name).not.toBeNull();
    changeInput(name!, "");
    const save = button("Save");
    expect(save.getAttribute("aria-disabled")).toBe("true");
    expect(
      document.getElementById(save.getAttribute("aria-describedby") ?? "")
        ?.textContent,
    ).toBe("Enter a name before saving this prompt.");

    const composingEnter = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      isComposing: true,
    });
    act(() => {
      name?.dispatchEvent(composingEnter);
    });
    expect(document.body.textContent).toContain(
      "Enter a name before saving this prompt.",
    );

    changeInput(name!, "Weekly recap");
    act(() => button("Save").click());
    expect(document.body.textContent).toContain("Weekly recap");
    await waitFor(() => expect(localStorage.length).toBeGreaterThan(0));
    expect(
      Array.from({ length: localStorage.length }, (_, index) =>
        localStorage.getItem(localStorage.key(index) ?? ""),
      ).join(""),
    ).not.toContain("Weekly recap");
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();

    const results = await axe.run(container!, {
      rules: { region: { enabled: false } },
    });
    expect(
      results.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);
  });

  it("contains thrown template loads and coalesces same-tick retries", async () => {
    mocks.getVoiceTemplates.mockImplementationOnce(() => {
      throw new Error("voice service offline");
    });
    const onApply = vi.fn();
    render(<SavedPromptsCard currentPrompt="Draft" onApply={onApply} />);
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "Voice templates couldn't be loaded. Retry when ready.",
      ),
    );
    expect(document.body.textContent).not.toContain("voice service offline");

    const pending = deferred<{
      data: {
        items: Array<{
          id: string;
          slug: string;
          name: string;
          description: string;
        }>;
      };
    }>();
    mocks.getVoiceTemplates.mockReturnValue(pending.promise);
    const retry = button("Retry");
    act(() => {
      retry.click();
      retry.click();
    });
    expect(mocks.getVoiceTemplates).toHaveBeenCalledTimes(2);

    pending.resolve({
      data: {
        items: [
          {
            id: "weekly",
            slug: "weekly-recap",
            name: "Weekly recap",
            description: "Summarise the most important updates.",
          },
        ],
      },
    });
    await act(async () => pending.promise);
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "Draft a Weekly recap. Summarise the most important updates.",
      ),
    );
    expect(document.querySelector("[title]")).toBeNull();
    act(() =>
      button(
        "Weekly recapDraft a Weekly recap. Summarise the most important updates.",
      ).click(),
    );
    expect(onApply).toHaveBeenCalledWith(
      "Draft a Weekly recap. Summarise the most important updates.",
    );
  });

  it("offers an immediate undo for deleting a local prompt", async () => {
    await seedEncryptedPrompts([
      { id: "prompt-1", name: "VIP nudge", prompt: "Write a VIP nudge" },
    ]);
    mocks.getVoiceTemplates.mockResolvedValue({ data: { items: [] } });
    render(<SavedPromptsCard currentPrompt="Draft" onApply={vi.fn()} />);
    await waitFor(() =>
      expect(document.body.textContent).toContain("Write a VIP nudge"),
    );

    const remove = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Remove saved prompt VIP nudge"]',
    );
    act(() => remove?.click());
    expect(document.body.textContent).toContain("Removed “VIP nudge”.");
    expect(document.body.textContent).not.toContain("Write a VIP nudge");

    act(() => button("Undo").click());
    expect(document.body.textContent).toContain("Write a VIP nudge");
    await waitFor(() => expect(localStorage.getItem(STORAGE_KEY)).toBeNull());
    expect(
      Array.from({ length: localStorage.length }, (_, index) =>
        localStorage.getItem(localStorage.key(index) ?? ""),
      ).join(""),
    ).not.toContain("VIP nudge");
  });

  it("purges ambiguous plaintext prompts without showing or importing them", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        {
          id: "unowned-prompt",
          name: "Previous account secret",
          prompt: "Never adopt this private prompt",
        },
      ]),
    );
    localStorage.setItem(
      TENANT_LEGACY_STORAGE_KEY,
      JSON.stringify([
        {
          id: "tenant-only-unowned-prompt",
          name: "Tenant-only previous account secret",
          prompt: "Never adopt this tenant-only prompt",
        },
      ]),
    );
    mocks.getVoiceTemplates.mockResolvedValue({ data: { items: [] } });
    render(<SavedPromptsCard currentPrompt="Draft" onApply={vi.fn()} />);

    await waitFor(() => expect(localStorage.getItem(STORAGE_KEY)).toBeNull());
    expect(localStorage.getItem(TENANT_LEGACY_STORAGE_KEY)).toBeNull();
    await waitFor(() =>
      expect(document.body.textContent).toContain("removed without importing"),
    );
    expect(document.body.textContent).not.toContain("Previous account secret");
    expect(document.body.textContent).not.toContain(
      "Never adopt this private prompt",
    );
    expect(document.body.textContent).not.toContain(
      "Never adopt this tenant-only prompt",
    );
    expect(
      Array.from(document.querySelectorAll("button")).some(
        (candidate) =>
          candidate.textContent?.trim() === "Retry encrypted storage",
      ),
    ).toBe(false);
    expect(
      Array.from({ length: localStorage.length }, (_, index) =>
        localStorage.getItem(localStorage.key(index) ?? ""),
      ).join(""),
    ).not.toContain("Never adopt this private prompt");
  });
});
