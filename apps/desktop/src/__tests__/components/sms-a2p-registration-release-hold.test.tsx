// @vitest-environment happy-dom

import axe from "axe-core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const requests = vi.hoisted(() => ({
  listSenders: vi.fn(),
  poll: vi.fn(),
  submitBrand: vi.fn(),
  submitCampaign: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  api: { listSMSSenders: requests.listSenders },
}));

vi.mock("../../lib/sms-a2p-api", () => ({
  pollA2PRegistration: requests.poll,
  submitA2PBrandRegistration: requests.submitBrand,
  submitA2PCampaignRegistration: requests.submitCampaign,
}));

import {
  SMS_A2P_REGISTRATION_RELEASE_HOLD,
  SMS_A2P_REGISTRATION_RELEASE_HOLD_COPY,
  SmsA2PRegistrationCard,
} from "../../components/sms/SmsA2PRegistrationCard";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  vi.clearAllMocks();
});

function renderCard(): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<SmsA2PRegistrationCard />));
}

function expectZeroA2PRequests(): void {
  expect(requests.listSenders).not.toHaveBeenCalled();
  expect(requests.submitBrand).not.toHaveBeenCalled();
  expect(requests.submitCampaign).not.toHaveBeenCalled();
  expect(requests.poll).not.toHaveBeenCalled();
}

describe("A2P registration release hold", () => {
  it("renders the exact stable hold without controls, requests, or callbacks", async () => {
    renderCard();

    expect(document.body.textContent).toContain(
      "Registration actions are release-held",
    );
    expect(document.body.textContent).toContain(
      SMS_A2P_REGISTRATION_RELEASE_HOLD_COPY,
    );
    expect(document.body.textContent).toContain(
      SMS_A2P_REGISTRATION_RELEASE_HOLD,
    );
    expect(document.body.textContent).toContain(
      "No sender read, brand submission, campaign submission, or provider status polling request is started by this card.",
    );
    expect(
      container?.querySelectorAll("button, input, select, textarea, form, a"),
    ).toHaveLength(0);
    expectZeroA2PRequests();

    act(() => {
      container?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      container?.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }),
      );
    });
    await act(async () => Promise.resolve());
    expectZeroA2PRequests();

    const results = await axe.run(container!, {
      rules: { region: { enabled: false } },
    });
    expect(
      results.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);
  });
});
