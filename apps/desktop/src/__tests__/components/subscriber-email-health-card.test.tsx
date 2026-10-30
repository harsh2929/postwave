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

const mocks = vi.hoisted(() => ({ health: vi.fn() }));

vi.mock("../../lib/api-client", () => ({
  verificationApi: { health: mocks.health },
}));

import { SubscriberEmailHealthCard } from "../../components/subscribers/SubscriberEmailHealthCard";

const NOW = "2026-08-13T09:00:00.000Z";

function payload(email: string, grade: "A" | "B" | "D" | "F" = "A") {
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
            kind: "delivered",
            at: NOW,
            source: "subscriber_events",
            reason_code: reasonCode,
          },
        ]
      : grade === "D"
        ? [
            {
              kind: "hard_bounce",
              at: NOW,
              source: "subscriber_events",
              reason_code: reasonCode,
            },
          ]
        : grade === "F"
          ? [
              {
                kind: "hard_stop",
                at: NOW,
                source: "send_eligibility",
                reason_code: reasonCode,
              },
            ]
          : [];
  return {
    email,
    grade,
    recommendation:
      grade === "D" ? "do_not_send" : hardStop ? "blocked" : "send",
    hard_stop: hardStop,
    send_eligible: grade === "A" || grade === "B",
    evidence_complete: true,
    reason_codes: [reasonCode],
    evidence,
    evidence_at: NOW,
    ...(grade === "A"
      ? { status: "valid", provider: "kickbox", checked_at: NOW }
      : {}),
    model_version: "postwave-email-health-v1",
    computed_at: NOW,
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => mocks.health.mockReset());

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

async function render(email: string): Promise<void> {
  container ??= document.createElement("div");
  if (!container.isConnected) document.body.appendChild(container);
  root ??= createRoot(container);
  act(() => root?.render(<SubscriberEmailHealthCard email={email} />));
  await act(async () => {
    for (let index = 0; index < 6; index += 1) await Promise.resolve();
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("SubscriberEmailHealthCard", () => {
  it("shows the grade, recommendation, safe reasons, and hard-stop precedence", async () => {
    mocks.health.mockResolvedValue({
      data: payload("person@example.com", "F"),
    });
    await render("person@example.com");

    expect(document.body.textContent).toContain("Grade F");
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
    mocks.health.mockResolvedValue({
      data: payload("person@example.com", "B"),
    });
    await render("person@example.com");

    expect(document.body.textContent).toContain("Grade B");
    expect(document.body.textContent).toContain(
      "A recent first-party delivery, human-classified click, or human reply",
    );
  });

  it("shows the validation date attached to grade A", async () => {
    mocks.health.mockResolvedValue({
      data: {
        ...payload("person@example.com", "A"),
        evidence_at: "2026-08-14T09:00:00.000Z",
      },
    });
    await render("person@example.com");

    expect(document.body.textContent).toContain("Grade A");
    expect(document.body.textContent).toContain("Validated Aug 13, 2026");
  });

  it("describes a recent historical hard bounce as recoverable grade D", async () => {
    mocks.health.mockResolvedValue({
      data: payload("person@example.com", "D"),
    });
    await render("person@example.com");

    expect(document.body.textContent).toContain("Grade D");
    expect(document.body.textContent).toContain("Do not send");
    expect(document.body.textContent).toContain(
      "has not been superseded by newer first-party positive activity",
    );
    expect(document.body.textContent).not.toContain("active hard stop");
  });

  it("pauses sending when the server could not load complete evidence", async () => {
    mocks.health.mockResolvedValue({
      data: {
        ...payload("person@example.com", "B"),
        grade: "U",
        recommendation: "caution",
        send_eligible: false,
        evidence_complete: false,
        reason_codes: ["health_evidence_unavailable"],
        evidence: [],
      },
    });
    await render("person@example.com");

    expect(document.body.textContent).toContain(
      "Sending paused — evidence unavailable",
    );
    expect(document.body.textContent).toContain("remains ineligible");
  });

  it("does not let a late response overwrite the newly selected subscriber", async () => {
    const first = deferred<{ data: ReturnType<typeof payload> }>();
    mocks.health
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ data: payload("second@example.com", "B") });

    await render("first@example.com");
    await render("second@example.com");
    expect(document.body.textContent).toContain("Grade B");

    await act(async () => {
      first.resolve({ data: payload("first@example.com", "F") });
      await first.promise;
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain("Grade B");
    expect(document.body.textContent).not.toContain("Grade F");
  });

  it("stays absent against an older deployment without the endpoint", async () => {
    mocks.health.mockResolvedValue({ error: { status: 404 } });
    await render("person@example.com");
    expect(document.body.textContent).not.toContain("Email health");
  });
});
