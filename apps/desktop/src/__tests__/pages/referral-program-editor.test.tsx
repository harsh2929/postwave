// @vitest-environment happy-dom

import axe from "axe-core";
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

import type { ReferralProgram } from "../../lib/api-client";
import {
  inspectLifecycle,
  prepareLifecycle,
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

const mocks = vi.hoisted(() => ({
  onClose: vi.fn(),
  onSaved: vi.fn(),
  setProgram: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  api: { setReferralProgram: mocks.setProgram },
}));

vi.mock("../../components/Modal", () => ({
  Modal: ({
    children,
    open,
    title,
  }: {
    children: ReactNode;
    open: boolean;
    title: string;
  }) =>
    open ? (
      <section role="dialog" aria-label={title}>
        {children}
      </section>
    ) : null,
  ModalFooter: ({ children }: { children: ReactNode }) => (
    <footer>{children}</footer>
  ),
}));

vi.mock("../../components/InlineHelp", () => ({
  InlineHelp: () => null,
}));

vi.mock("../../components/library/AssetPicker", () => ({
  AssetPicker: () => null,
}));

vi.mock("../../components/Toast", () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));

import { ProgramEditor } from "../../pages/referrals/ProgramEditor";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

interface EditorProps {
  canMutate: boolean;
  focusRow?: number | null;
  onClose: () => void;
  onSaved: () => void;
  open: boolean;
  program: ReferralProgram | null;
}

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
  vi.clearAllMocks();
  mocks.setProgram.mockResolvedValue({ data: existingProgram() });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  resetLifecycleCoordinatorForTests();
  vi.clearAllMocks();
});

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function existingProgram(
  overrides: Partial<ReferralProgram> = {},
): ReferralProgram {
  return {
    id: "program-1",
    active: true,
    expiresAt: "2026-08-31T23:59:59.000Z",
    milestones: [
      {
        count: 5,
        reward_label: "[swag] Hoodie",
        reward_kind: "swag",
        reward_image_asset_id: "asset-1",
        reward_value_cents: 2500,
        reward_currency: "USD",
        reward_sku: "hoodie-blue",
      },
    ],
    referee_reward_kind: "custom",
    referee_reward_label: "Welcome credit",
    referee_reward_image_asset_id: "asset-referee",
    reward_value_cents: 500,
    reward_currency: "USD",
    reward_sku: "credit-5",
    verification_window_days: 14,
    ...overrides,
  };
}

function defaultProps(overrides: Partial<EditorProps> = {}): EditorProps {
  return {
    canMutate: true,
    focusRow: null,
    onClose: mocks.onClose,
    onSaved: mocks.onSaved,
    open: true,
    program: existingProgram(),
    ...overrides,
  };
}

function renderEditor(overrides: Partial<EditorProps> = {}): {
  rerender: (next: Partial<EditorProps>) => void;
} {
  let props = defaultProps(overrides);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const render = (): void => {
    act(() => root?.render(<ProgramEditor {...props} />));
  };
  render();
  return {
    rerender(next) {
      props = { ...props, ...next };
      render();
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

function field(label: string): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>(
    `input[aria-label="${label}"]`,
  );
  if (!input) throw new Error(`Missing input: ${label}`);
  return input;
}

function setField(input: HTMLInputElement, value: string): void {
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
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => Promise.resolve());
    }
  }
  throw lastError;
}

describe("referral ProgramEditor", () => {
  it("never creates a new referral program from global lifecycle Save", async () => {
    renderEditor({ program: null });
    await waitFor(() =>
      expect(field("Milestone 1 reward label").value).toBe("Branded swag"),
    );
    setField(field("Milestone 1 reward label"), "Launch reward");

    await expect(inspectLifecycle(quitIntent)).resolves.toMatchObject([
      {
        label: "Referral program create draft",
        level: "warning",
        canSave: false,
        canDiscard: true,
      },
    ]);
    await act(async () => prepareLifecycle(quitIntent));
    expect(mocks.setProgram).not.toHaveBeenCalled();
  });

  it("uses a compare-and-set create precondition for a verified empty program", async () => {
    renderEditor({ program: null });
    await waitFor(() =>
      expect(field("Milestone 1 reward label").value).toBe("Branded swag"),
    );

    act(() => button("Create program").click());
    await waitFor(() => expect(mocks.setProgram).toHaveBeenCalledOnce());

    expect(mocks.setProgram).toHaveBeenCalledWith({
      milestones: [
        {
          count: 3,
          reward_label: "Branded swag",
          reward_kind: "swag",
          reward_image_asset_id: undefined,
          reward_value_cents: undefined,
          reward_currency: undefined,
          reward_sku: undefined,
        },
        {
          count: 10,
          reward_label: "1 month free",
          reward_kind: "free",
          reward_image_asset_id: undefined,
          reward_value_cents: undefined,
          reward_currency: undefined,
          reward_sku: undefined,
        },
        {
          count: 25,
          reward_label: "Annual subscription",
          reward_kind: "annual",
          reward_image_asset_id: undefined,
          reward_value_cents: undefined,
          reward_currency: undefined,
          reward_sku: undefined,
        },
      ],
      expires_at: null,
      expect_no_active_program: true,
    });
  });

  it("sends a plain structural label and preserves every hidden full-replace field", async () => {
    const pending = deferred<{ data: ReferralProgram }>();
    mocks.setProgram.mockReturnValue(pending.promise);
    renderEditor();
    await waitFor(() =>
      expect(field("Milestone 1 reward label").value).toBe("Hoodie"),
    );

    const save = button("Save changes");
    act(() => {
      save.click();
      save.click();
    });
    expect(mocks.setProgram).toHaveBeenCalledTimes(1);
    expect(mocks.setProgram).toHaveBeenCalledWith({
      milestones: [
        {
          count: 5,
          reward_label: "Hoodie",
          reward_kind: "swag",
          reward_image_asset_id: "asset-1",
          reward_value_cents: 2500,
          reward_currency: "USD",
          reward_sku: "hoodie-blue",
        },
      ],
      expires_at: "2026-08-31T23:59:59.000Z",
      expected_program_id: "program-1",
      referee_reward_kind: "custom",
      referee_reward_label: "Welcome credit",
      referee_reward_image_asset_id: "asset-referee",
      reward_value_cents: 500,
      reward_currency: "USD",
      reward_sku: "credit-5",
      verification_window_days: 14,
    });
    expect(button("Saving…").disabled).toBe(true);

    await act(async () => {
      pending.resolve({ data: existingProgram() });
      await pending.promise;
    });
    expect(mocks.toastSuccess).toHaveBeenCalledWith("Program updated");
    expect(mocks.onSaved).toHaveBeenCalledTimes(1);
  });

  it("rejects fractional counts and empty labels without a request", async () => {
    renderEditor({ program: null });
    await waitFor(() =>
      expect(field("Milestone 1 referral count").value).toBe("3"),
    );
    setField(field("Milestone 1 referral count"), "1.5");
    act(() => button("Create program").click());
    expect(mocks.setProgram).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "whole number",
    );

    setField(field("Milestone 1 referral count"), "3");
    setField(field("Milestone 1 reward label"), "   ");
    act(() => button("Create program").click());
    expect(mocks.setProgram).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "reward label is required",
    );
  });

  it("keeps an in-flight save owned across a role downgrade", async () => {
    const pending = deferred<{ data: ReferralProgram }>();
    mocks.setProgram.mockReturnValue(pending.promise);
    const view = renderEditor();
    await waitFor(() =>
      expect(field("Milestone 1 reward label").value).toBe("Hoodie"),
    );
    act(() => button("Save changes").click());
    view.rerender({ canMutate: false });
    expect(button("Saving…").disabled).toBe(true);

    await act(async () => {
      pending.resolve({ data: existingProgram() });
      await pending.promise;
    });
    expect(mocks.toastSuccess).toHaveBeenCalledWith("Program updated");
    expect(mocks.onSaved).toHaveBeenCalledTimes(1);
  });

  it("surfaces thrown save failures and unlocks retry", async () => {
    mocks.setProgram.mockRejectedValue(new Error("network interrupted"));
    renderEditor();
    await waitFor(() =>
      expect(field("Milestone 1 reward label").value).toBe("Hoodie"),
    );
    await act(async () => {
      button("Save changes").click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "network interrupted",
    );
    expect(button("Save changes").disabled).toBe(false);
  });

  it("keeps viewer actions focusable, visibly guarded, title-free, and axe-clean", async () => {
    renderEditor({ canMutate: false });
    await waitFor(() =>
      expect(field("Milestone 1 reward label").value).toBe("Hoodie"),
    );

    const save = button("Save changes");
    const add = button("+ Add milestone");
    const image = button("Change image");
    expect(save.disabled).toBe(false);
    expect(save.getAttribute("aria-disabled")).toBe("true");
    expect(add.disabled).toBe(false);
    expect(add.getAttribute("aria-disabled")).toBe("true");
    expect(image.disabled).toBe(false);
    expect(image.getAttribute("aria-disabled")).toBe("true");
    expect(document.body.textContent).toContain(
      "Referral program administration is restricted to workspace admins",
    );
    expect(document.querySelector("[title]")).toBeNull();

    act(() => {
      save.click();
      add.click();
      image.click();
    });
    expect(mocks.setProgram).not.toHaveBeenCalled();
    expect(document.querySelectorAll("fieldset")).toHaveLength(1);

    const result = await axe.run(container ?? document.body, {
      rules: { region: { enabled: false } },
    });
    expect(
      result.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);
  });
});
