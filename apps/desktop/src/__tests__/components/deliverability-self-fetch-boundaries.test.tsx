// @vitest-environment happy-dom

import { type ReactElement, act } from "react";
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

import { BotOpenSignaturesPanel } from "../../components/deliverability/BotOpenSignaturesPanel";
import { DomainWarmupPanel } from "../../components/deliverability/DomainWarmupPanel";

const mocks = vi.hoisted(() => ({
  stats: vi.fn(),
  signatures: vi.fn(),
  warmupPlans: vi.fn(),
  canAdmin: true,
}));

vi.mock("../../lib/api-client", () => ({
  botOpensApi: {
    stats: mocks.stats,
    listSignatures: mocks.signatures,
  },
  domainWarmupApi: {
    list: mocks.warmupPlans,
  },
}));

vi.mock("../../lib/store", () => ({
  useCanAdmin: () => mocks.canAdmin,
  useRoleStatus: () => "resolved",
}));

let root: Root | null = null;
let container: HTMLDivElement | null = null;

const VALID_STATS = {
  since: "2026-06-17T00:00:00Z",
  total_opens: 10,
  bot_opens: 2,
  human_opens: 8,
  by_signature: [{ label: "Apple MPP", opens: 2 }],
};

const VALID_SIGNATURE = {
  id: "signature-1",
  is_default: true,
  label: "Apple Mail Privacy Protection",
  pattern: "Mozilla/5.0 AppleWebKit",
  kind: "prefetch",
  enabled: true,
  created_at: "2026-06-17T00:00:00Z",
};

const VALID_PLAN = {
  id: "plan-1",
  domain: "mail.example.test",
  target_daily: 1_000,
  days: 3,
  started_on: "2026-07-15",
  status: "active",
  schedule: [100, 500, 1_000],
  last_sent_count: 80,
  last_observed_at: "2026-07-17T10:00:00Z",
  created_at: "2026-07-15T00:00:00Z",
  updated_at: "2026-07-17T11:00:00Z",
};

beforeAll(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  mocks.stats.mockReset();
  mocks.signatures.mockReset();
  mocks.warmupPlans.mockReset();
  mocks.canAdmin = true;
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

async function renderPanel(panel: ReactElement): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(panel));
  await settle();
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(document.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!(match instanceof HTMLButtonElement)) {
    throw new Error("button not found: " + label);
  }
  return match;
}

describe("deliverability self-fetch render boundaries", () => {
  it("contains malformed stats without hiding a valid signature inventory", async () => {
    mocks.stats.mockResolvedValue({
      data: {
        since: "2026-06-17T00:00:00Z",
        total_opens: 10,
        bot_opens: 2,
        human_opens: 8,
      },
    });
    mocks.signatures.mockResolvedValue({ data: [VALID_SIGNATURE] });

    await renderPanel(<BotOpenSignaturesPanel />);

    expect(document.body.textContent).toContain(
      "Open-classification statistics could not be verified.",
    );
    expect(document.body.textContent).toContain(
      "Apple Mail Privacy Protection",
    );
    expect(document.body.textContent).not.toContain("returned malformed data");
  });

  it("never renders rejected transport details and leaves the healthy sibling usable", async () => {
    mocks.stats.mockRejectedValue(
      new Error("Bearer secret-token at https://internal.example.test"),
    );
    mocks.signatures.mockResolvedValue({ data: [] });

    await renderPanel(<BotOpenSignaturesPanel />);

    expect(document.body.textContent).toContain(
      "Open-classification statistics could not be verified.",
    );
    expect(document.body.textContent).toContain("No signatures returned");
    expect(document.body.textContent).not.toContain("secret-token");
    expect(document.body.textContent).not.toContain("internal.example.test");
    expect(document.querySelector(".dhw-bot-stats-skeleton")).toBeNull();
  });

  it("retains the last verified bot-open evidence after a refresh failure", async () => {
    mocks.stats.mockResolvedValueOnce({ data: VALID_STATS });
    mocks.signatures.mockResolvedValue({ data: [VALID_SIGNATURE] });
    await renderPanel(<BotOpenSignaturesPanel />);

    mocks.stats.mockRejectedValueOnce(new Error("private transport detail"));
    await act(async () => {
      button("Refresh evidence").click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain("Human classified");
    expect(document.body.textContent).toContain(
      "The last verified data remains visible.",
    );
    expect(document.body.textContent).not.toContain("private transport detail");
  });

  it("bounds and sanitizes signature patterns without a hover-only fallback", async () => {
    const rawPattern =
      "Mozilla/\u0000" + "A".repeat(180) + "TailAgentIdentifier";
    mocks.stats.mockResolvedValue({ data: VALID_STATS });
    mocks.signatures.mockResolvedValue({
      data: [{ ...VALID_SIGNATURE, pattern: rawPattern }],
    });

    await renderPanel(<BotOpenSignaturesPanel />);

    const code = document.querySelector(".dhw-bot-pattern code");
    expect(code?.textContent).toContain("…");
    expect(code?.textContent).toContain("�");
    expect(code?.textContent?.length).toBeLessThanOrEqual(61);
    expect(document.body.textContent).not.toContain(rawPattern);
    expect(code?.hasAttribute("title")).toBe(false);
  });

  it("renders warmup as observational scheduler evidence with exact keyboard-accessible steps", async () => {
    mocks.warmupPlans.mockResolvedValue({ data: [VALID_PLAN] });

    await renderPanel(<DomainWarmupPanel />);

    expect(document.body.textContent).toContain("mail.example.test");
    expect(document.body.textContent).toContain(
      "does not enforce these daily caps",
    );
    expect(document.body.textContent).not.toContain("today");
    expect(document.querySelector("details summary")?.textContent).toContain(
      "Review exact daily schedule",
    );
    const schedule = document.querySelector("details");
    act(() => schedule?.querySelector("summary")?.click());
    expect(schedule?.open).toBe(true);
    expect(document.body.textContent).toContain("Configured day 2");
    expect(document.body.textContent).toContain("500");
    expect(document.querySelector("[title]")).toBeNull();
  });

  it("uses a generic warmup failure, retries, and replaces the dead end with verified data", async () => {
    mocks.warmupPlans
      .mockRejectedValueOnce(new Error("SQLSTATE 42 secret backend detail"))
      .mockResolvedValueOnce({ data: [VALID_PLAN] });

    await renderPanel(<DomainWarmupPanel />);
    expect(document.body.textContent).toContain(
      "Warmup-plan evidence could not be verified.",
    );
    expect(document.body.textContent).not.toContain("SQLSTATE");

    await act(async () => {
      button("Retry").click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain("mail.example.test");
    expect(document.body.textContent).not.toContain(
      "Warmup-plan evidence could not be verified.",
    );
  });

  it("does not request the admin-scoped warmup inventory for a non-admin", async () => {
    mocks.canAdmin = false;

    await renderPanel(<DomainWarmupPanel />);

    expect(document.body.textContent).toContain("Admin access required");
    expect(mocks.warmupPlans).not.toHaveBeenCalled();
  });

  it("ignores late warmup responses after unmount", async () => {
    let resolveRequest:
      | ((value: { data: (typeof VALID_PLAN)[] }) => void)
      | undefined;
    mocks.warmupPlans.mockReturnValue(
      new Promise((resolve) => {
        resolveRequest = resolve;
      }),
    );

    await renderPanel(<DomainWarmupPanel />);
    act(() => root?.unmount());
    root = null;
    resolveRequest?.({ data: [VALID_PLAN] });
    await settle();

    expect(container?.textContent).toBe("");
  });
});
