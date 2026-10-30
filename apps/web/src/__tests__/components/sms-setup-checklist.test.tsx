// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { SmsSetupChecklist } from "@/app/(dashboard)/app/sms/sms-setup-checklist";

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
});

describe("SmsSetupChecklist", () => {
  it("names its progress meter with the completed-check count", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);

    await act(async () => {
      root?.render(
        <SmsSetupChecklist
          compliance={{
            can_send: true,
            senders: [],
            items: [
              {
                key: "approved_sender",
                label: "Sender registration approved",
                complete: true,
              },
            ],
          }}
          pilotReadiness={{
            can_pilot: true,
            counts: { approved_senders: 1, opted_in_subscriptions: 12 },
            items: [],
          }}
          loading={false}
          onGoToTab={() => undefined}
        />,
      );
    });

    const progress = host.querySelector('[role="progressbar"]');
    expect(progress?.getAttribute("aria-label")).toBe("SMS setup completion");
    expect(progress?.getAttribute("aria-valuetext")).toBe("1 of 1 complete");
    expect(progress?.getAttribute("aria-valuenow")).toBe("100");
  });
});
