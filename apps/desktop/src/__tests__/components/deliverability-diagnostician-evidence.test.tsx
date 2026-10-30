// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { DiagnosticianCard } from "../../components/deliverability/DiagnosticianCard";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  placement: vi.fn(),
  diagnose: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  authChecksApi: { matrix: mocks.auth },
  inboxRealityCampaignsApi: { report: mocks.placement },
  diagnosticianApi: { diagnose: mocks.diagnose },
}));

vi.mock("../../components/deliverability/CampaignSelect", () => ({
  CampaignSelect: ({
    ariaLabel,
    value,
    onChange,
    disabled,
  }: {
    ariaLabel: string;
    value: string;
    onChange: (value: string) => void;
    disabled?: boolean;
  }) => (
    <select
      aria-label={ariaLabel}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.currentTarget.value)}
    >
      <option value="">Select</option>
      <option value="campaign-1">Campaign one</option>
    </select>
  ),
}));

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  mocks.auth.mockReset();
  mocks.placement.mockReset();
  mocks.diagnose.mockReset();
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

async function renderAndDiagnose(): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<DiagnosticianCard />);
  });
  const select = document.querySelector("select");
  await act(async () => {
    if (!(select instanceof HTMLSelectElement)) return;
    select.value = "campaign-1";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const button = Array.from(document.querySelectorAll("button")).find(
    (candidate) => candidate.textContent === "Diagnose",
  );
  await act(async () => {
    button?.click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

const CHECK = { status: "ok", detail: "verified" };
const AUTH_ROW = {
  domain: "mail.example.test",
  spf: CHECK,
  dkim: CHECK,
  dmarc: CHECK,
  bimi: CHECK,
  ptr: CHECK,
};
const PLACEMENT = {
  campaign_id: "campaign-1",
  providers: [],
  overall_pct: {},
  total_inboxes: 0,
  generated_at: "2026-07-17T12:00:00Z",
};

describe("AI diagnostician evidence boundary", () => {
  it("does not call the model when no real evidence can be verified", async () => {
    mocks.auth.mockResolvedValue({ error: { message: "auth unavailable" } });
    mocks.placement.mockResolvedValue({
      error: { message: "placement unavailable" },
    });

    await renderAndDiagnose();

    expect(mocks.diagnose).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("The AI request was not sent");
  });

  it("supplies only verified auth and placement evidence to the model", async () => {
    mocks.auth.mockResolvedValue({ data: [AUTH_ROW] });
    mocks.placement.mockResolvedValue({ data: PLACEMENT });
    mocks.diagnose.mockResolvedValue({
      data: {
        campaign_id: "campaign-1",
        diagnosis: "Evidence-backed hypothesis",
        fixes: [],
        predicted_impact: {},
        generated_at: "2026-07-17T12:30:00Z",
      },
    });

    await renderAndDiagnose();

    expect(mocks.diagnose).toHaveBeenCalledTimes(1);
    expect(mocks.diagnose.mock.calls[0]?.[0]).toBe("campaign-1");
    expect(mocks.diagnose.mock.calls[0]?.[1]).toMatchObject({
      campaign_id: "campaign-1",
      domain: "mail.example.test",
      auth: AUTH_ROW,
      seedlist: PLACEMENT,
    });
    expect(document.body.textContent).toContain(
      "Reputation and content evidence were not supplied",
    );
    expect(document.body.textContent).toContain("review before acting");
  });
});
