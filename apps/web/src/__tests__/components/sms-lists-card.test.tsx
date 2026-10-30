// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ listMembers: vi.fn() }));

vi.mock("@/lib/sms-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sms-api")>();
  return { ...actual, listSmsListMembers: mocks.listMembers };
});

import {
  SmsListsCard,
  type SmsListDraft,
} from "@/app/(dashboard)/app/sms/sms-lists-card";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot> | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

function Harness() {
  const [draft, setDraft] = useState<SmsListDraft>({
    name: "",
    description: "",
    keyword: "",
  });
  return (
    <SmsListsCard
      draft={draft}
      lists={[
        {
          id: "11111111-1111-4111-8111-111111111111",
          name: "Consented customers",
          description: "Verified audience",
          recipient_count: 500,
          created_at: "2026-08-21T00:00:00Z",
          updated_at: "2026-08-21T00:00:00Z",
        },
      ]}
      loading={false}
      pending={null}
      setDraft={setDraft}
      onSubmit={(event) => event.preventDefault()}
    />
  );
}

describe("SmsListsCard confidential roster hold", () => {
  it("shows list metadata but never requests the unbounded PII roster", () => {
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => root?.render(<Harness />));

    const expand = Array.from(host.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Consented customers"),
    );
    expect(expand).toBeDefined();
    act(() => expand?.click());

    expect(host.textContent).toContain("500 opted-in");
    expect(host.textContent).toContain("No roster request was sent");
    expect(mocks.listMembers).not.toHaveBeenCalled();
  });
});
