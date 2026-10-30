// @vitest-environment happy-dom

import axe from "axe-core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ContextualHelpPanel } from "../../components/tour/ContextualHelpPanel";
import { buildContextualHelpSnapshot } from "../../lib/contextual-help";
import { popDialog, pushDialog } from "../../lib/dialogStack";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  copy: vi.fn(),
  navigate: vi.fn(),
  openUrl: vi.fn(),
}));

vi.mock("../../lib/clipboard", () => ({
  writeClipboardText: mocks.copy,
}));

vi.mock("../../lib/desktop-router", () => ({
  navigateDesktopSection: mocks.navigate,
}));

vi.mock("../../lib/tauri", () => ({
  safeOpenExternalUrl: (value: string) =>
    value.startsWith("https://") ? value : null,
  tauriApi: { openUrl: mocks.openUrl },
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  mocks.copy.mockResolvedValue({
    ok: true,
    backend: "web",
    contentClass: "personal",
    clearScheduled: false,
    clearAfterMs: null,
    historyWarning: null,
  });
  mocks.openUrl.mockResolvedValue(undefined);
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    callback(0);
    return 1;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

function renderPanel(
  section: Parameters<
    typeof buildContextualHelpSnapshot
  >[0]["section"] = "discounts",
): {
  onClose: ReturnType<typeof vi.fn>;
  onStartTour: ReturnType<typeof vi.fn>;
  trigger: HTMLButtonElement;
} {
  const snapshot = buildContextualHelpSnapshot({
    section,
    connectivity: "proxy-tls",
    request: {
      task: "recovery",
      errorCode: "SYNC_FAILED",
      incidentId: "PW-20260716-A1B2C3D4E5",
    },
  });
  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.textContent = "Help";
  document.body.insertBefore(trigger, container);
  const onClose = vi.fn();
  const onStartTour = vi.fn();
  act(() => {
    root.render(
      <ContextualHelpPanel
        dialogId="contextual-help-panel-test"
        panelRef={{ current: null }}
        triggerRef={{ current: trigger }}
        snapshot={snapshot}
        side="right"
        commandShortcut={null}
        helpShortcut={null}
        onboardingShortcut={null}
        dashboardShortcut={null}
        canRestartSetup
        onClose={onClose}
        onMove={vi.fn()}
        onStartTour={onStartTour}
        onReplayTour={vi.fn()}
        onRestartSetup={vi.fn()}
      />,
    );
  });
  return { onClose, onStartTour, trigger };
}

function button(label: string): HTMLButtonElement {
  const match = [...container.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.includes(label),
  );
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("ContextualHelpPanel", () => {
  it("presents a named non-modal self-service dialog and passes the serious axe gate", async () => {
    renderPanel();
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]');
    const text = dialog?.textContent ?? "";

    expect(dialog?.getAttribute("aria-modal")).toBe("false");
    expect(text).toContain("Discount history");
    expect(text).toContain("Restore the connection");
    expect(text).toContain("Check availability");
    expect(text.indexOf("Try these first")).toBeLessThan(
      text.indexOf("Still need help?"),
    );
    expect(text).not.toContain("PW-20260716-A1B2C3D4E5");
    expect(text).not.toContain("SYNC_FAILED");
    expect(document.activeElement).toBe(dialog);
    const result = await axe.run(dialog!);
    expect(
      result.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);
  });

  it("copies only the bounded structural context with explicit classification", async () => {
    renderPanel();

    await click(button("Copy support context"));

    expect(mocks.copy).toHaveBeenCalledTimes(1);
    const [value, options] = mocks.copy.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(value).toContain("Destination: Discount history (discounts)");
    expect(value).toContain("Error code: SYNC_FAILED");
    expect(value).toContain("Incident: PW-20260716-A1B2C3D4E5");
    expect(value).not.toContain("resource ID:");
    expect(options).toEqual({
      contentClass: "personal",
      label: "Moosewave support context",
    });
    expect(container.textContent).toContain(
      "Privacy-safe support context copied.",
    );
  });

  it("opens support with structural query fields and no route payload", async () => {
    renderPanel();

    await click(button("Contact support"));

    expect(mocks.openUrl).toHaveBeenCalledTimes(1);
    const url = new URL(mocks.openUrl.mock.calls[0]?.[0] as string);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      source: "desktop",
      destination: "discounts",
      domain: "growth",
      readiness: "read-only",
      connection: "proxy-tls",
      task: "recovery",
      error_code: "SYNC_FAILED",
      incident_id: "PW-20260716-A1B2C3D4E5",
    });
    expect(url.toString()).not.toContain("resourceId");
    expect(url.toString()).not.toContain("@example.com");
  });

  it("routes the availability recovery action through the typed router", async () => {
    renderPanel("audienceSyncs");

    await click(button("Open Integrations"));

    expect(mocks.navigate).toHaveBeenCalledWith("integrations");
  });

  it("contains handoff failures without exposing the underlying error", async () => {
    mocks.openUrl.mockRejectedValueOnce(
      new Error("private token pw_live_do_not_render"),
    );
    renderPanel();

    await click(button("Contact support"));

    expect(container.textContent).toContain("Support could not be opened");
    expect(container.textContent).not.toContain("pw_live_do_not_render");
  });

  it("ignores composing and keyCode-229 Escape, then closes only once on real Escape", () => {
    const { onClose } = renderPanel();
    const composing = new KeyboardEvent("keydown", { key: "Escape" });
    Object.defineProperty(composing, "isComposing", { value: true });
    const ime229 = new KeyboardEvent("keydown", { key: "Escape" });
    Object.defineProperty(ime229, "keyCode", { value: 229 });

    act(() => {
      window.dispatchEvent(composing);
      window.dispatchEvent(ime229);
    });
    expect(onClose).not.toHaveBeenCalled();

    act(() => pushDialog("test:nested-over-help"));
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(onClose).not.toHaveBeenCalled();
    act(() => popDialog("test:nested-over-help"));

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(onClose).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledWith(true);
  });

  it("dismisses once when focus and pointer depart while preserving the outside target", () => {
    const { onClose } = renderPanel();
    const outside = document.createElement("button");
    outside.textContent = "Outside task";
    document.body.appendChild(outside);

    act(() => {
      outside.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      outside.focus();
    });

    expect(onClose).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledWith(false);
    expect(document.activeElement).toBe(outside);
  });

  it("single-flights support work and contains synchronous adapter failures", async () => {
    mocks.copy.mockImplementationOnce(() => {
      throw new Error("private clipboard adapter detail");
    });
    renderPanel();
    const copy = button("Copy support context");

    act(() => {
      copy.click();
      copy.click();
    });
    expect(copy.disabled).toBe(true);
    expect(container.textContent).toContain(
      "Copying privacy-safe support context…",
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.copy).toHaveBeenCalledOnce();
    expect(container.textContent).toContain(
      "Support context could not be copied",
    );
    expect(container.textContent).not.toContain("private clipboard adapter");
  });

  it("issues a guided departure only once under same-tick activation", () => {
    const { onStartTour } = renderPanel();
    const start = button("Take the tour");
    act(() => {
      start.click();
      start.click();
    });
    expect(onStartTour).toHaveBeenCalledOnce();
  });

  it("drops late async completion after the panel unmounts", async () => {
    let finish:
      | ((value: {
          ok: boolean;
          backend: string;
          contentClass: string;
          clearScheduled: boolean;
          clearAfterMs: null;
          historyWarning: null;
        }) => void)
      | undefined;
    mocks.copy.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    renderPanel();
    act(() => button("Copy support context").click());
    act(() => root.render(<></>));

    await act(async () => {
      finish?.({
        ok: true,
        backend: "web",
        contentClass: "personal",
        clearScheduled: false,
        clearAfterMs: null,
        historyWarning: null,
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent).toBe("");
  });
});
