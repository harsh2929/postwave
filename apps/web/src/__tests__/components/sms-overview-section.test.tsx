// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SmsOverviewSection } from "@/app/(dashboard)/app/sms/sms-overview-section";
import type { SmsSenderProfile, SmsSetupStatus } from "@/lib/sms-api";

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
});

const sender: SmsSenderProfile = {
  id: "sender_1",
  provider: "twilio",
  country: "US",
  sender_type: "10dlc",
  phone_number: "+14155550100",
  registration_status: "approved",
  created_at: "2026-08-27T00:00:00.000Z",
  updated_at: "2026-08-27T00:00:00.000Z",
};

const setup: SmsSetupStatus = {
  senders: [sender],
  can_send: true,
  blocking_reasons: [],
};

function exactButton(label: string): HTMLButtonElement {
  const match = Array.from(document.querySelectorAll("button")).find(
    (button) => button.textContent?.trim() === label,
  );
  if (!(match instanceof HTMLButtonElement)) {
    throw new Error(`Button not found: ${label}`);
  }
  return match;
}

describe("SmsOverviewSection", () => {
  it("returns focus to the pause-sender trigger when Escape closes its controlled dialog", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    const onSenderPauseChange = vi.fn();

    await act(async () => {
      root?.render(
        <SmsOverviewSection
          loading={false}
          pending={null}
          setup={setup}
          compliance={null}
          pilotReadiness={null}
          senderCertifications={{}}
          onSenderPauseChange={onSenderPauseChange}
          onGoToTab={vi.fn()}
        />,
      );
    });

    const trigger = exactButton("Pause sender");
    trigger.focus();
    expect(document.activeElement).toBe(trigger);
    const focusSpy = vi.spyOn(trigger, "focus");

    await act(async () => {
      trigger.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(trigger);

    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "Escape",
        }),
      );
      await Promise.resolve();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });

    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(onSenderPauseChange).not.toHaveBeenCalled();
    expect(focusSpy).toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger);
  });
});
