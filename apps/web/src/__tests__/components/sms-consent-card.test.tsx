// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SmsConsentCard,
  type SmsConsentDraft,
} from "@/app/(dashboard)/app/sms/sms-consent-card";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

function Harness() {
  const [draft, setDraft] = useState<SmsConsentDraft>({
    list_id: "33333333-3333-4333-8333-333333333333",
    phone_e164: "+14155550123",
    proof_text: "Operator safety request",
    action: "revoked",
    source: "manual",
  });
  return (
    <SmsConsentCard
      draft={draft}
      lists={[
        {
          id: "33333333-3333-4333-8333-333333333333",
          name: "Safety list",
          description: "Manual holds",
          created_at: "2026-08-21T00:00:00Z",
          updated_at: "2026-08-21T00:00:00Z",
        },
      ]}
      pending={null}
      setDraft={setDraft}
      onSubmit={vi.fn()}
    />
  );
}

describe("web SMS consent authority card", () => {
  it("offers only operator opt-out and no proof upload or bulk opt-in affordance", () => {
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => root?.render(<Harness />));

    expect(host.textContent).toContain("Record opt-out");
    expect(host.textContent).toContain("verified inbound START or UNSTOP");
    expect(host.textContent).not.toContain("Opt-in (granted)");
    expect(host.textContent).not.toContain("Bulk import opted-in numbers");
    expect(host.querySelector('input[type="file"]')).toBeNull();
  });
});
