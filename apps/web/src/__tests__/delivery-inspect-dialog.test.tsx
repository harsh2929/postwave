// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// SETA-004: the delivery inspector dialog renders the retained request payload
// (pretty-printed), a distinct "pre-dates retention" empty state, and clean
// loading / error states. Radix Dialog portals its content into document.body,
// so this is a DOM-based (not renderToStaticMarkup) test.

import { act, createElement, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { DeliveryInspectDialog } from "@/app/(dashboard)/app/settings/webhooks/[id]/deliveries/delivery-inspect-dialog";
import type { WebhookDeliveryDetail } from "@/lib/webhooks-api";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function detail(
  over: Partial<WebhookDeliveryDetail> = {},
): WebhookDeliveryDetail {
  return {
    id: 7,
    webhookId: "wh_1",
    event: "subscriber.created",
    statusCode: 200,
    attempt: 1,
    responseMs: 42,
    at: "2026-04-30T18:42:00Z",
    requestBody: '{"id":"evt_1","type":"subscriber.created"}',
    payloadRetained: true,
    ...over,
  };
}

function render(ui: React.ReactNode): Root {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(ui));
  return root;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("DeliveryInspectDialog (SETA-004)", () => {
  it("returns focus to the explicit Inspect trigger when closed", async () => {
    function ControlledInspector() {
      const [open, setOpen] = useState(false);
      const triggerRef = useRef<HTMLButtonElement>(null);
      return (
        <>
          <button ref={triggerRef} type="button" onClick={() => setOpen(true)}>
            Inspect
          </button>
          <DeliveryInspectDialog
            open={open}
            onOpenChange={setOpen}
            returnFocusRef={triggerRef}
            detail={detail()}
            loading={false}
            error={null}
          />
        </>
      );
    }

    const root = render(<ControlledInspector />);
    try {
      const trigger = Array.from(document.querySelectorAll("button")).find(
        (button) => button.textContent === "Inspect",
      );
      act(() => trigger?.click());
      const close = Array.from(document.querySelectorAll("button")).find(
        (button) => button.textContent?.trim() === "Close",
      );
      close?.focus();
      await act(async () => {
        close?.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => requestAnimationFrame(resolve));
      });

      expect(document.activeElement).toBe(trigger);
    } finally {
      act(() => root.unmount());
    }
  });

  it("pretty-prints the retained request payload", () => {
    const root = render(
      createElement(DeliveryInspectDialog, {
        open: true,
        onOpenChange: () => {},
        detail: detail(),
        loading: false,
        error: null,
      }),
    );
    try {
      const text = document.body.textContent ?? "";
      expect(text).toContain("Request payload");
      // 2-space pretty-print inserts a space after the colon.
      expect(text).toContain('"id": "evt_1"');
      expect(text).toContain('"type": "subscriber.created"');
      const payload = document.body.querySelector("pre");
      expect(payload?.getAttribute("tabindex")).toBe("0");
      expect(payload?.getAttribute("aria-label")).toBe(
        "Retained webhook request payload",
      );
    } finally {
      act(() => root.unmount());
    }
  });

  it("shows a distinct empty state (not the payload) when retention is off", () => {
    const root = render(
      createElement(DeliveryInspectDialog, {
        open: true,
        onOpenChange: () => {},
        detail: detail({ payloadRetained: false, requestBody: "" }),
        loading: false,
        error: null,
      }),
    );
    try {
      const text = document.body.textContent ?? "";
      expect(text).toContain("pre-dates payload retention");
      expect(text).not.toContain('"id": "evt_1"');
    } finally {
      act(() => root.unmount());
    }
  });

  it("renders a loading state", () => {
    const root = render(
      createElement(DeliveryInspectDialog, {
        open: true,
        onOpenChange: () => {},
        detail: null,
        loading: true,
        error: null,
      }),
    );
    try {
      expect(document.body.textContent).toContain("Loading delivery");
    } finally {
      act(() => root.unmount());
    }
  });

  it("renders an error state", () => {
    const root = render(
      createElement(DeliveryInspectDialog, {
        open: true,
        onOpenChange: () => {},
        detail: null,
        loading: false,
        error: "boom",
      }),
    );
    try {
      expect(document.body.textContent).toContain(
        "Could not load delivery: boom",
      );
      expect(document.body.querySelector('[role="alert"]')).toBeTruthy();
    } finally {
      act(() => root.unmount());
    }
  });
});
