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
  canAdmin: true,
  get: vi.fn(),
  upsert: vi.fn(),
  remove: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("../../lib/store", () => ({
  useCanAdmin: () => mocks.canAdmin,
}));

vi.mock("../../lib/api-client", () => ({
  sendWindowApi: {
    get: mocks.get,
    upsert: mocks.upsert,
    remove: mocks.remove,
  },
}));

vi.mock("../../components/Toast", () => ({
  toast: { success: mocks.toastSuccess },
}));

import { SendWindowPolicyModal } from "../../components/composer/SendWindowPolicyModal";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  mocks.canAdmin = true;
  mocks.get.mockReset();
  mocks.upsert.mockReset();
  mocks.remove.mockReset();
  mocks.toastSuccess.mockReset();
  mocks.get.mockResolvedValue({
    data: {
      policy: {
        start_local: "09:00:00",
        end_local: "17:00:00",
        timezone: "Asia/Kolkata",
        weekday_bitmap: 62,
        weekdays: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
        enforcement: "warn",
        created_at: "2026-07-01T00:00:00Z",
        updated_at: "2026-07-01T00:00:00Z",
      },
    },
  });
  mocks.upsert.mockResolvedValue({ data: {} });
  mocks.remove.mockResolvedValue({ data: undefined });
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

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function button(label: string): HTMLButtonElement {
  const found = Array.from(document.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!(found instanceof HTMLButtonElement)) {
    throw new Error(`Missing button: ${label}`);
  }
  return found;
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

function policy(
  overrides: {
    canMutate?: boolean;
    onChanged?: () => void;
    onClose?: () => void;
  } = {},
): ReactElement {
  return (
    <SendWindowPolicyModal
      open
      canMutate={overrides.canMutate ?? true}
      onChanged={overrides.onChanged ?? vi.fn()}
      onClose={overrides.onClose ?? vi.fn()}
    />
  );
}

describe("SendWindowPolicyModal maturity", () => {
  it("keeps admin-gated actions discoverable, inert, title-free, and axe-clean", async () => {
    mocks.canAdmin = false;
    render(policy());
    await flush();

    const save = button("Save policy");
    const remove = button("Remove policy");
    expect(save.disabled).toBe(false);
    expect(save.getAttribute("aria-disabled")).toBe("true");
    expect(remove.disabled).toBe(false);
    expect(remove.getAttribute("aria-disabled")).toBe("true");
    expect(document.body.textContent).toContain("needs an admin role");
    expect(document.querySelector("[title]")).toBeNull();

    act(() => {
      save.click();
      remove.click();
    });
    expect(mocks.upsert).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();

    const result = await axe.run(document.body, {
      rules: { region: { enabled: false } },
    });
    expect(
      result.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);
  });

  it("owns a save in the same tick and honors only the verified outcome", async () => {
    let resolve!: (value: { data: Record<string, never> }) => void;
    const pending = new Promise<{ data: Record<string, never> }>((done) => {
      resolve = done;
    });
    mocks.upsert.mockReturnValue(pending);
    const onChanged = vi.fn();
    const onClose = vi.fn();
    render(policy({ onChanged, onClose }));
    await flush();

    const timezone = document.querySelector<HTMLInputElement>("#sw-tz");
    if (!timezone) throw new Error("Missing timezone input");
    setInput(timezone, "UTC");
    const save = button("Save policy");
    expect(save.getAttribute("aria-disabled")).toBe("false");
    act(() => {
      save.click();
      save.click();
    });
    await flush();
    expect(mocks.upsert).toHaveBeenCalledTimes(1);
    expect(button("Saving…").disabled).toBe(true);

    await act(async () => {
      resolve({ data: {} });
      await pending;
    });
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mocks.toastSuccess).toHaveBeenCalledWith("Send-window policy saved");
  });

  it("surfaces synchronous load failures and provides a working retry", async () => {
    mocks.get.mockImplementationOnce(() => {
      throw new Error("transport unavailable");
    });
    render(policy());
    await flush();

    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "transport unavailable",
    );
    act(() => button("Retry").click());
    await flush();
    expect(mocks.get).toHaveBeenCalledTimes(2);
    expect(document.querySelector<HTMLInputElement>("#sw-tz")?.value).toBe(
      "Asia/Kolkata",
    );
  });
});
