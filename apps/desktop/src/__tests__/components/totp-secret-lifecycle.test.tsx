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

const mocks = vi.hoisted(() => ({
  enroll: vi.fn(),
  verify: vi.fn(),
  writeClipboardText: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  toDataURL: vi.fn(),
}));

vi.mock("qrcode", () => ({
  default: { toDataURL: mocks.toDataURL },
}));

vi.mock("../../lib/api-client", () => ({
  apiAuth: {
    totpEnroll: mocks.enroll,
    totpVerify: mocks.verify,
  },
}));

vi.mock("../../lib/auth", () => ({
  redact: (value: string) => value,
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

import { TotpSetupModal } from "../../components/TotpSetupModal";
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
  mocks.enroll.mockResolvedValue({
    data: {
      otpauth_uri: "otpauth://totp/Moosewave:test?secret=BASE32SECRET",
      recovery_codes: ["recover-one", "recover-two"],
    },
  });
  mocks.verify.mockResolvedValue({ data: { ok: true } });
  mocks.toDataURL.mockResolvedValue("data:image/png;base64,qr");
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
  resetLifecycleCoordinatorForTests();
});

function button(label: string): HTMLButtonElement {
  const found = Array.from(document.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!found) throw new Error(`Expected button: ${label}`);
  return found;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function reachRecovery(): Promise<void> {
  await flush();
  const code = document.querySelector<HTMLInputElement>("#totp-code");
  if (!code) throw new Error("Expected TOTP code field");
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(code, "123456");
    code.dispatchEvent(new Event("input", { bubbles: true }));
  });
  act(() => button("Verify and enable").click());
  await flush();
  expect(document.body.textContent).toContain("recover-one");
}

describe("TOTP recovery-code lifecycle", () => {
  it("does not release on copy failure and zeroizes before acknowledgement callbacks", async () => {
    const onClose = vi.fn();
    const onEnrolled = vi.fn();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() =>
      root?.render(
        <TotpSetupModal open onClose={onClose} onEnrolled={onEnrolled} />,
      ),
    );
    await reachRecovery();

    await expect(inspectLifecycle(quitIntent)).resolves.toMatchObject([
      {
        label: "MFA recovery codes",
        level: "blocking",
        canSave: false,
        canDiscard: false,
      },
    ]);
    mocks.writeClipboardText.mockResolvedValueOnce({
      ok: false,
      message: "clipboard denied",
    });
    act(() => button("Copy all").click());
    await flush();
    expect(mocks.toastError).toHaveBeenCalledWith("clipboard denied");
    await expect(inspectLifecycle(quitIntent)).resolves.toHaveLength(1);

    const finish = button("I've saved these — finish");
    expect(finish.disabled).toBe(false);
    expect(finish.getAttribute("aria-disabled")).toBe("true");
    expect(finish.getAttribute("aria-describedby")).toBe(
      "totp-recovery-acknowledgement",
    );
    act(() => finish.click());
    expect(onEnrolled).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    const checkbox = document.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    );
    if (!checkbox) throw new Error("Expected recovery acknowledgement");
    act(() => checkbox.click());
    await expect(inspectLifecycle(quitIntent)).resolves.toHaveLength(1);
    act(() => finish.click());
    await flush();

    expect(onEnrolled).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).not.toContain("recover-one");
    await expect(inspectLifecycle(quitIntent)).resolves.toEqual([]);
  });

  it("contains a thrown verification and releases its retained operation", async () => {
    mocks.verify.mockRejectedValueOnce(new Error("verification unavailable"));
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() =>
      root?.render(
        <TotpSetupModal open onClose={vi.fn()} onEnrolled={vi.fn()} />,
      ),
    );
    await flush();
    const code = document.querySelector<HTMLInputElement>("#totp-code");
    if (!code) throw new Error("Expected TOTP code field");
    act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set?.call(code, "123456");
      code.dispatchEvent(new Event("input", { bubbles: true }));
      button("Verify and enable").click();
    });
    await flush();

    expect(document.body.textContent).toContain("verification unavailable");
    expect(button("Verify and enable").disabled).toBe(false);
    await expect(inspectLifecycle(quitIntent)).resolves.toEqual([]);
  });
});
