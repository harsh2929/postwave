// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SmsTestSendCard } from "@/app/(dashboard)/app/sms/sms-test-send-card";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("SmsTestSendCard dispatch readiness", () => {
  it("prevents form and button submission while dispatch is release-held", () => {
    const onSubmit = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        <SmsTestSendCard
          activeSender={undefined}
          creditPreview={null}
          credits={1}
          dispatchAvailable={false}
          dispatchUnavailableReason="Provider runtime readiness is unavailable."
          draft={{
            sender_profile_id: "",
            list_id: "",
            to: "+14155551212",
            body: "Test",
            media_url: "",
          }}
          lists={[]}
          pending={null}
          segments={1}
          senders={[]}
          setDraft={vi.fn()}
          onSubmit={onSubmit}
        />,
      );
    });

    try {
      expect(container.textContent).toContain(
        "Provider runtime readiness is unavailable.",
      );
      expect(
        (container.querySelector('button[type="submit"]') as HTMLButtonElement)
          .disabled,
      ).toBe(true);
      let accepted = true;
      act(() => {
        accepted = (container.querySelector("form") as HTMLFormElement)
          .dispatchEvent(
            new Event("submit", { bubbles: true, cancelable: true }),
          );
      });
      expect(accepted).toBe(false);
      expect(onSubmit).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
    }
  });
});
