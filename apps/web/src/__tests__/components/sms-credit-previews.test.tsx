// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useSmsCreditPreviews } from "@/app/(dashboard)/app/sms/use-sms-credit-previews";

const mocks = vi.hoisted(() => ({
  preview: vi.fn(),
  quote: vi.fn(),
}));

vi.mock("@/lib/sms-api", () => ({
  previewSmsCredits: mocks.preview,
  quoteSmsCreditTopUp: mocks.quote,
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

describe("useSmsCreditPreviews", () => {
  it("keeps every financial preview and top-up route structurally held", () => {
    let latest: ReturnType<typeof useSmsCreditPreviews> | null = null;
    function Harness() {
      latest = useSmsCreditPreviews({
        activeSender: { country: "CA", sender_type: "toll_free" },
        campaignDraft: {
          body: "private draft",
          media_url: "https://private.example/media.jpg",
        },
        campaignRecipientCount: 5_000,
        campaignSender: { country: "US", sender_type: "short_code" },
        debounceMs: 1,
        sender: { country: "US", sender_type: "10dlc" },
        smsCreditBalance: null,
        testSend: { body: "private test", media_url: "" },
      });
      return null;
    }
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    act(() => root.render(<Harness />));

    expect(latest).toEqual({
      campaignCreditPreview: null,
      smsTopUpQuote: null,
      testCreditPreview: null,
    });
    expect(mocks.preview).not.toHaveBeenCalled();
    expect(mocks.quote).not.toHaveBeenCalled();

    act(() => root.unmount());
  });
});
