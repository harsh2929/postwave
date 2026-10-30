// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderPage, unmount, WHOAMI } from "../pages/_harness";

const mocks = vi.hoisted(() => ({
  fresh: vi.fn(),
  send: vi.fn(),
  uuid: vi.fn(() => "019d4a38-1e40-7000-8000-000000000001"),
}));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoamiFresh: mocks.fresh,
}));

vi.mock("@/lib/http-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/http-fetch")>()),
  newUUIDv7: mocks.uuid,
}));

vi.mock("@/lib/track-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/track-api")>()),
  sendSyntheticTrackEvent: mocks.send,
}));

async function setInput(
  input: HTMLInputElement | HTMLTextAreaElement,
  value: string,
) {
  const prototype =
    input instanceof HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function click(button: HTMLButtonElement) {
  await act(async () => {
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function button(label: string): HTMLButtonElement {
  const found = [
    ...document.querySelectorAll<HTMLButtonElement>("button"),
  ].find((candidate) => candidate.textContent?.trim() === label);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

describe("TrackEventComposer", () => {
  beforeEach(() => {
    mocks.fresh.mockResolvedValue(WHOAMI);
  });

  it("requires consequence acknowledgement and reuses one event ID after an uncertain failure", async () => {
    const firstEventId = "019d4a38-1e40-7000-8000-000000000001";
    const secondEventId = "019d4a38-1e40-7000-8000-000000000002";
    mocks.uuid
      .mockReset()
      .mockReturnValueOnce(firstEventId)
      .mockReturnValueOnce(secondEventId);
    mocks.send
      .mockRejectedValueOnce(new Error("Acknowledgement timed out"))
      .mockResolvedValueOnce({
        id: 55,
        subscriberId: "33333333-3333-4333-8333-333333333333",
        eventId: firstEventId,
      })
      .mockResolvedValueOnce({
        id: 56,
        subscriberId: "33333333-3333-4333-8333-333333333333",
        eventId: secondEventId,
      });
    const onSent = vi.fn();
    const Component = (
      await import("@/app/(dashboard)/app/track/track-event-composer")
    ).TrackEventComposer;
    const { root } = await renderPage(Component, {
      identity: WHOAMI,
      onSent,
    });
    try {
      await click(button("Send live event"));
      const subscriber = document.querySelector<HTMLInputElement>(
        "#track-composer-subscriber",
      );
      const eventName = document.querySelector<HTMLInputElement>(
        "#track-composer-name",
      );
      const properties = document.querySelector<HTMLTextAreaElement>(
        "#track-composer-properties",
      );
      const confirmation = document.querySelector<HTMLInputElement>(
        "#track-composer-confirm",
      );
      expect(
        subscriber && eventName && properties && confirmation,
      ).toBeTruthy();
      await setInput(
        subscriber as HTMLInputElement,
        "33333333-3333-4333-8333-333333333333",
      );
      await setInput(eventName as HTMLInputElement, "checkout_started");
      await setInput(properties as HTMLTextAreaElement, '{"synthetic":true}');
      await setInput(confirmation as HTMLInputElement, "SEND LIVE EVENT");
      const checkbox = document.querySelector<HTMLInputElement>(
        "[role='dialog'] input[type='checkbox']",
      );
      expect(checkbox).not.toBeNull();
      await act(async () => checkbox?.click());

      const submit = [...document.querySelectorAll<HTMLButtonElement>("button")]
        .filter(
          (candidate) => candidate.textContent?.trim() === "Send live event",
        )
        .at(-1);
      expect(submit?.disabled).toBe(false);
      await click(submit as HTMLButtonElement);
      expect(document.body.textContent).toContain(
        "stable event ID were retained",
      );
      expect(mocks.send).toHaveBeenCalledTimes(1);

      await click(submit as HTMLButtonElement);
      expect(mocks.send).toHaveBeenCalledTimes(2);
      expect(mocks.send.mock.calls[0]?.[0].eventId).toBe(
        mocks.send.mock.calls[1]?.[0].eventId,
      );
      expect(mocks.uuid).toHaveBeenCalledTimes(1);
      expect(mocks.fresh).toHaveBeenCalledTimes(2);
      expect(onSent).toHaveBeenCalledTimes(1);
      expect(document.body.textContent).toContain("Event 55 was accepted");

      await act(async () => checkbox?.click());
      await setInput(confirmation as HTMLInputElement, "SEND LIVE EVENT");
      const resend = button("Send another identical event");
      expect(resend.disabled).toBe(false);
      await click(resend);

      expect(mocks.send).toHaveBeenCalledTimes(3);
      expect(mocks.send.mock.calls[2]?.[0].eventId).toBe(secondEventId);
      expect(mocks.send.mock.calls[2]?.[0].eventId).not.toBe(firstEventId);
      expect(mocks.uuid).toHaveBeenCalledTimes(2);
      expect(mocks.fresh).toHaveBeenCalledTimes(3);
      expect(onSent).toHaveBeenCalledTimes(2);
      expect(document.body.textContent).toContain("Event 56 was accepted");
    } finally {
      unmount(root);
    }
  });

  it("does not expose a live-write dialog to a viewer", async () => {
    const Component = (
      await import("@/app/(dashboard)/app/track/track-event-composer")
    ).TrackEventComposer;
    const { container, root } = await renderPage(Component, {
      identity: { ...WHOAMI, role: "viewer", effective_role: "viewer" },
      onSent: vi.fn(),
    });
    try {
      const trigger = container.querySelector<HTMLButtonElement>("button");
      expect(trigger?.disabled).toBe(true);
      expect(document.querySelector("[role='dialog']")).toBeNull();
    } finally {
      unmount(root);
    }
  });

  it("fails closed when viewer mode is active and effective_role is absent", async () => {
    const Component = (
      await import("@/app/(dashboard)/app/track/track-event-composer")
    ).TrackEventComposer;
    const { container, root } = await renderPage(Component, {
      identity: {
        ...WHOAMI,
        viewer_mode: true,
        effective_role: undefined,
      },
      onSent: vi.fn(),
    });
    try {
      const trigger = container.querySelector<HTMLButtonElement>("button");
      expect(trigger?.disabled).toBe(true);
      expect(document.querySelector("[role='dialog']")).toBeNull();
      expect(mocks.send).not.toHaveBeenCalled();
    } finally {
      unmount(root);
    }
  });
});
