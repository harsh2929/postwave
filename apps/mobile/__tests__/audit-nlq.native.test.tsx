import { describe, expect, it, jest } from "@jest/globals";
import { render } from "@testing-library/react-native";
import React from "react";

import { AuditNlqSheet } from "../src/components/audit/AuditNlqSheet";
import type { AuditNlqController } from "../src/hooks/useAuditNlq";
import type { AuditRow } from "../src/hooks/useAudit";
import { parseAuditNlqAnswer } from "../src/lib/auditNlq";

/**
 * GOVERNANCE#51 — what the audit assistant must show before it shows an answer.
 *
 * The arithmetic (who may ask, what a cap of 0 means, how an unknown total
 * renders) is unit-tested in `src/lib/auditNlq.test.ts`. What can only be
 * tested here is that the SURFACE renders it: a compliance reader has to see
 * the translated filter and the projection caveat, not just a paragraph of
 * model prose with rows under it.
 */

const ANSWER = parseAuditNlqAnswer<AuditRow>({
  query_preview: "who deleted subscribers yesterday?",
  structured_filters: { action: "delete", resource_type: "subscriber" },
  invalid_fields: ["colour"],
  results: [
    {
      id: 42,
      action: "subscriber.delete",
      actorType: "user",
      actorLabel: "ada@example.com",
      metadata: {},
      at: "2026-08-01T09:00:00Z",
    },
  ],
  total_count: 137,
  summary: "One deletion, by Ada.",
  trace: { model: "claude-x", reasoning: "Mapped 'deleted' to action delete." },
  cost_status: { daily_cap_tokens: 10_000, remaining_tokens: 9_875 },
});

function controller(
  over: Partial<AuditNlqController<AuditRow>> = {},
): AuditNlqController<AuditRow> {
  return {
    access: { allowed: true, known: true, notice: null },
    budget: { usedTokens: 125, capTokens: 10_000, remainingTokens: 9_875, resetAt: null },
    ask: {
      answer: null,
      asking: false,
      errorMessage: null,
      ask: jest.fn(),
      reset: jest.fn(),
    },
    sheetOpen: true,
    openSheet: jest.fn(),
    closeSheet: jest.fn(),
    ...over,
  };
}

function renderSheet(nlq: AuditNlqController<AuditRow>, online = true) {
  return render(
    <AuditNlqSheet nlq={nlq} online={online} canReadPii={false} />,
  );
}

describe("audit NLQ sheet", () => {
  it("shows the remaining budget before the user spends any of it", async () => {
    const result = await renderSheet(controller());
    expect(result.getByText(/9,875 of 10,000 tokens left today/)).toBeTruthy();
  });

  it("disables Ask when a real cap has run out", async () => {
    const result = await renderSheet(
      controller({
        budget: {
          usedTokens: 100,
          capTokens: 100,
          remainingTokens: 0,
          resetAt: null,
        },
      }),
    );
    expect(result.getByLabelText("Ask").props.accessibilityState.disabled).toBe(true);
    expect(result.getByText(/spent its daily question budget/)).toBeTruthy();
  });

  it("says asking needs a connection rather than failing silently offline", async () => {
    const result = await renderSheet(controller(), false);
    expect(result.getByText(/Asking needs a connection/)).toBeTruthy();
    expect(result.getByLabelText("Ask").props.accessibilityState.disabled).toBe(true);
  });

  it("renders the translation, the dropped fields, and the projection caveat", async () => {
    const result = await renderSheet(
      controller({
        ask: {
          answer: ANSWER,
          asking: false,
          errorMessage: null,
          ask: jest.fn(),
          reset: jest.fn(),
        },
      }),
    );

    // The filter the model chose, verbatim — the CloudTrail-Lake requirement.
    expect(result.getByText("What the model understood")).toBeTruthy();
    expect(result.getByLabelText("Action contains: delete")).toBeTruthy();
    expect(result.getByLabelText("Resource type: subscriber")).toBeTruthy();
    // A field the model invented and the server dropped is stated, not hidden.
    expect(result.getByText(/colour/)).toBeTruthy();
    // The denominator is the COUNT(*), not the number of rows on screen.
    expect(result.getByText("Showing 1 of 137 matching events.")).toBeTruthy();
    expect(result.getByText("Subscriber deleted")).toBeTruthy();
    expect(
      result.getByLabelText(/^Subscriber deleted by ada@example\.com,/),
    ).toBeTruthy();
    expect(result.queryByText("subscriber.delete")).toBeNull();
    // The projection gap: no redaction badge here means "not selected".
    expect(result.getByText(/Redaction, legal-hold/)).toBeTruthy();
    // Article 50 + the narrower, truer claim about what the model did.
    expect(result.getByText(/AI assistant/)).toBeTruthy();
    expect(result.getByText(/only chooses the filter/)).toBeTruthy();
  });

  it("offers suggestions only before an answer exists", async () => {
    const empty = await renderSheet(controller());
    expect(empty.getByLabelText("Ask: Every export in the last 7 days")).toBeTruthy();

    const answered = await renderSheet(
      controller({
        ask: {
          answer: ANSWER,
          asking: false,
          errorMessage: null,
          ask: jest.fn(),
          reset: jest.fn(),
        },
      }),
    );
    expect(
      answered.queryByLabelText("Ask: Every export in the last 7 days"),
    ).toBeNull();
  });
});
