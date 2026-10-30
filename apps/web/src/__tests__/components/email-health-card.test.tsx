// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const mocks = vi.hoisted(() => ({ getEmailHealth: vi.fn() }));

vi.mock("@/lib/email-health-api", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/email-health-api")>();
  return { ...actual, getEmailHealth: mocks.getEmailHealth };
});

import { EmailHealthCard } from "@/app/(dashboard)/app/subscribers/[id]/_email-health-card";

const NOW = "2026-08-13T09:00:00.000Z";

function payload(grade: "A" | "B" | "D" | "F" = "A") {
  const hardStop = grade === "F";
  const reasonCode =
    grade === "A"
      ? "verification_valid_30d"
      : grade === "B"
        ? "event_delivered"
        : grade === "D"
          ? "event_bounced_hard"
          : "suppression_hard_bounce";
  const evidence =
    grade === "B"
      ? [
          {
            kind: "delivered" as const,
            at: NOW,
            source: "subscriber_events",
            reason_code: reasonCode,
          },
        ]
      : grade === "D"
        ? [
            {
              kind: "hard_bounce" as const,
              at: NOW,
              source: "subscriber_events",
              reason_code: reasonCode,
            },
          ]
        : grade === "F"
          ? [
              {
                kind: "hard_stop" as const,
                at: NOW,
                source: "send_eligibility",
                reason_code: reasonCode,
              },
            ]
          : [];
  return {
    email: "person@example.com",
    grade,
    recommendation:
      grade === "D"
        ? ("do_not_send" as const)
        : hardStop
          ? ("blocked" as const)
          : ("send" as const),
    hard_stop: hardStop,
    send_eligible: grade === "A" || grade === "B",
    evidence_complete: true,
    reason_codes: [reasonCode],
    evidence,
    evidence_at: NOW,
    ...(grade === "A" ? { status: "valid" as const, checked_at: NOW } : {}),
    model_version: "postwave-email-health-v1",
    computed_at: "2026-08-13T09:01:00.000Z",
  };
}

let root: Root | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => mocks.getEmailHealth.mockReset());

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
});

async function renderCard(): Promise<void> {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, throwOnError: false },
    },
  });
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(EmailHealthCard, {
          email: "person@example.com",
          subscriberId: "subscriber-1",
          tenantId: "tenant-a",
          role: "viewer",
        }),
      ),
    );
  });
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      });
    }
  }
  throw lastError;
}

describe("EmailHealthCard", () => {
  it("shows the authoritative hard stop without exposing raw evidence sources", async () => {
    mocks.getEmailHealth.mockResolvedValue(payload("F"));
    await renderCard();

    await waitFor(() => expect(document.body.textContent).toContain("Grade F"));
    expect(document.body.textContent).toContain("Blocked from sending");
    expect(document.body.textContent).toContain(
      "Active hard-bounce suppression",
    );
    expect(document.body.textContent).toContain(
      "An invalid, spam-trap, abuse, or do-not-mail result",
    );
    expect(document.body.textContent).toContain(
      "hard stop takes precedence over every positive signal",
    );
    expect(document.body.textContent).not.toContain("subscriber_events");
  });

  it("describes B as first-party positive activity", async () => {
    mocks.getEmailHealth.mockResolvedValue(payload("B"));
    await renderCard();

    await waitFor(() => expect(document.body.textContent).toContain("Grade B"));
    expect(document.body.textContent).toContain(
      "A recent first-party delivery, human-classified click, or human reply",
    );
  });

  it("shows the validation timestamp attached to grade A", async () => {
    mocks.getEmailHealth.mockResolvedValue({
      ...payload("A"),
      evidence_at: "2026-08-14T09:00:00.000Z",
    });
    await renderCard();

    await waitFor(() =>
      expect(document.body.textContent).toContain("Validated"),
    );
    expect(document.body.textContent).toContain("2026");
  });

  it("describes a recent historical hard bounce as recoverable grade D", async () => {
    mocks.getEmailHealth.mockResolvedValue(payload("D"));
    await renderCard();

    await waitFor(() => expect(document.body.textContent).toContain("Grade D"));
    expect(document.body.textContent).toContain("Do not send");
    expect(document.body.textContent).toContain(
      "has not been superseded by newer first-party positive activity",
    );
    expect(document.body.textContent).not.toContain("active hard stop");
  });

  it("shows the fail-closed state when evidence could not be loaded", async () => {
    mocks.getEmailHealth.mockResolvedValue({
      ...payload("F"),
      grade: "U",
      recommendation: "caution",
      hard_stop: false,
      send_eligible: false,
      evidence_complete: false,
      reason_codes: ["health_evidence_unavailable"],
      evidence: [],
    });
    await renderCard();

    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "Sending paused — evidence unavailable",
      ),
    );
    expect(document.body.textContent).toContain("remains ineligible");
  });
});
