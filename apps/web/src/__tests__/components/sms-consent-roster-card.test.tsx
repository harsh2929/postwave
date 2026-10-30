// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchText: vi.fn(),
  listConsent: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, fetchTextAuthed: mocks.fetchText };
});
vi.mock("@/lib/sms-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sms-api")>();
  return { ...actual, listSmsConsent: mocks.listConsent };
});

import { SmsConsentRosterCard } from "@/app/(dashboard)/app/sms/sms-consent-roster-card";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot> | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("SmsConsentRosterCard evidence hold", () => {
  it("renders a truthful boundary and issues no read or export request", () => {
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() =>
      root?.render(<SmsConsentRosterCard baseKey={["sms"]} enabled />),
    );

    expect(host.textContent).toContain("No consent-log or export request was sent");
    expect(host.querySelector("input")).toBeNull();
    expect(host.querySelector("button")).toBeNull();
    expect(mocks.listConsent).not.toHaveBeenCalled();
    expect(mocks.fetchText).not.toHaveBeenCalled();
  });
});
