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
  vaultGet: vi.fn(),
  vaultSet: vi.fn(),
  navigateResource: vi.fn(),
  navigateSection: vi.fn(),
}));

vi.mock("../../lib/secure-vault", () => ({
  vaultGetJSON: mocks.vaultGet,
  vaultSetJSON: mocks.vaultSet,
}));
vi.mock("../../lib/desktop-router", () => ({
  navigateDesktopSectionResource: mocks.navigateResource,
  navigateDesktopSection: mocks.navigateSection,
}));

import { NotificationsPanel } from "../../components/NotificationsPanel";
import { popDialog, pushDialog } from "../../lib/dialogStack";
import {
  configureNotificationCenterIdentity,
  getNotificationCenterSnapshot,
  ingestNotification,
  resetNotificationCenterForTests,
} from "../../lib/notification-center";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(async () => {
  resetNotificationCenterForTests();
  mocks.vaultGet.mockReset().mockResolvedValue(null);
  mocks.vaultSet.mockReset().mockResolvedValue(undefined);
  mocks.navigateResource.mockReset();
  mocks.navigateSection.mockReset();
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    callback(0);
    return 1;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
  await configureNotificationCenterIdentity("user-1", "tenant-1");
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
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

async function addCampaign(): Promise<void> {
  await act(async () => {
    await ingestNotification({
      topic: "campaign.sent",
      title: "Campaign sent",
      body: "A campaign finished sending. Open Moosewave for delivery details.",
      occurredAt: new Date().toISOString(),
      eventIdentity: "campaign_42",
      deepLink: "moosewave://campaign/campaign_42",
    });
  });
}

function button(label: string): HTMLButtonElement {
  const match = [
    ...document.querySelectorAll<HTMLButtonElement>("button"),
  ].find((candidate) => candidate.textContent?.trim() === label);
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

describe("NotificationsPanel", () => {
  it("moves focus into the named non-modal dialog, preserves unread state, and passes axe", async () => {
    await addCampaign();
    render(<NotificationsPanel open onClose={vi.fn()} />);

    expect(document.activeElement).toBe(button("Close"));
    expect(document.body.textContent).toContain("1 unread notification");
    expect(getNotificationCenterSnapshot().unreadCount).toBe(1);
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog?.id).toBe("desktop-notification-center");
    expect(dialog?.getAttribute("aria-modal")).toBe("false");
    const result = await axe.run(dialog!);
    expect(
      result.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);

    act(() => button("Mark all read").click());
    expect(getNotificationCenterSnapshot().unreadCount).toBe(0);
    expect(document.body.textContent).toContain("No unread notifications");
  });

  it("marks a selection read and launches the exact validated resource", async () => {
    await addCampaign();
    const onClose = vi.fn();
    render(<NotificationsPanel open onClose={onClose} />);
    expect(getNotificationCenterSnapshot().entries[0]?.deepLink).toBe(
      "moosewave://campaign/campaign_42",
    );

    const row = document.querySelector<HTMLButtonElement>(".notif-row-main");
    act(() => {
      row?.click();
      row?.click();
    });

    expect(getNotificationCenterSnapshot().unreadCount).toBe(0);
    expect(mocks.navigateResource).toHaveBeenCalledWith(
      "campaigns",
      "campaign_42",
      { source: "deep-link" },
    );
    expect(mocks.navigateResource).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledWith("selection");
  });

  it("archives without deleting and offers an explicit restore path", async () => {
    await addCampaign();
    render(<NotificationsPanel open onClose={vi.fn()} />);

    const archive = document.querySelector<HTMLButtonElement>(
      '[aria-label="Archive Campaign sent"]',
    );
    act(() => archive?.click());
    expect(document.body.textContent).toContain("No notifications yet");

    act(() => button("Archived").click());
    expect(document.body.textContent).toContain("Campaign sent");
    const restore = document.querySelector<HTMLButtonElement>(
      '[aria-label="Restore Campaign sent"]',
    );
    act(() => restore?.click());
    expect(document.body.textContent).toContain("No archived notifications");
  });

  it("ignores composing and keyCode-229 Escape, then closes once with a focus-return reason", () => {
    const onClose = vi.fn();
    render(<NotificationsPanel open onClose={onClose} />);

    const composing = new KeyboardEvent("keydown", { key: "Escape" });
    Object.defineProperty(composing, "isComposing", { value: true });
    const ime229 = new KeyboardEvent("keydown", { key: "Escape" });
    Object.defineProperty(ime229, "keyCode", { value: 229 });
    act(() => {
      window.dispatchEvent(composing);
      window.dispatchEvent(ime229);
    });
    expect(onClose).not.toHaveBeenCalled();

    act(() => pushDialog("test:nested-over-notifications"));
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(onClose).not.toHaveBeenCalled();
    act(() => popDialog("test:nested-over-notifications"));

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(onClose).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledWith("escape");
  });

  it("dismisses once across outside pointer and focus departure without stealing focus", () => {
    const onClose = vi.fn();
    render(<NotificationsPanel open onClose={onClose} />);
    const outside = document.createElement("button");
    outside.textContent = "Outside task";
    document.body.appendChild(outside);

    act(() => {
      outside.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      outside.focus();
    });

    expect(onClose).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledWith("outside");
    expect(document.activeElement).toBe(outside);
  });
});
