/**
 * The in-app report's wire contract and failure copy, run through the REAL
 * transport seam (rawRequest → sdkResult → checkedApiResult → errorCopy).
 *
 * Only `./sdkClient` is mocked — the src/api/request.test.ts idiom — so what is
 * asserted here is what the phone actually sends and what the reporter is
 * actually told. The report path is a condition of distribution (Apple 1.2,
 * Play UGC + generative-AI), and before this file no test executed it at all:
 * a body-key rename (the server's DecodeJSON rejects unknown fields), an
 * inverted origin, a verb or path change, or a failure branch that told an
 * editor to retry a 403 forever all left every suite green.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getClient } from "./sdkClient";

vi.mock("./sdkClient", () => ({ getClient: vi.fn() }));

// eslint-disable-next-line import/first
import {
  canSubmitContentReport,
  originForSubject,
  reportFailureMessage,
  submitContentReport,
  type ContentReportInput,
  type ReportSubjectKind,
} from "./contentReports";

const RETRY_COPY = /Try again — your report is still here/;

/** routeauth.writeRouteRoleDenial, byte for byte (denials.go). This is what
 * every viewer/editor session gets today: the generated manifest fails the
 * route closed to `admin`. */
const ROLE_DENIAL = {
  error: {
    subject: "route",
    reason: "role",
    code: "insufficient_role",
    message: "your role does not have permission for this route",
  },
};

/** contentreports.SubmitInAppReport's 400, via errEnv("invalid_report", err). */
const INVALID_REPORT = {
  error: {
    code: "invalid_report",
    message: "contentreports: explanation must substantiate the report",
  },
};

function sdkError(status: number, body: { error: { code: string; message: string } }) {
  return Object.assign(new Error(body.error.message), {
    status,
    code: body.error.code,
    payload: body,
  });
}

const INPUT: ContentReportInput = {
  origin: "in_app_ai_output",
  subject_kind: "ai_output",
  subject_ref: "msg-42",
  reason_category: "ai_output_harmful",
  explanation: "The reply told me to harass a named person.",
};

/** Submit, and hand back whatever the sheet's catch would receive. */
async function rejectionFor(thrown: unknown): Promise<unknown> {
  request.mockRejectedValueOnce(thrown);
  try {
    await submitContentReport(INPUT);
  } catch (error) {
    return error;
  }
  throw new Error("submitContentReport resolved on a failed request");
}

const request = vi.fn();

beforeEach(() => {
  request.mockReset();
  vi.mocked(getClient).mockReturnValue({ client: { request } } as never);
});

describe("submitContentReport — the wire", () => {
  it("POSTs the input, unchanged and alone, to /api/v1/content-reports exactly once", async () => {
    request.mockResolvedValueOnce({
      reference: "PWR-7Q2K",
      received_at: "2026-09-14T10:00:00Z",
    });

    await submitContentReport(INPUT);

    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("POST", "/api/v1/content-reports", {
      body: INPUT,
    });
    // Only the ContentReportInput keys: the server's DecodeJSON rejects an
    // unknown field with a 400, so an extra key is a report that never lands.
    const sent = (request.mock.calls[0]?.[2] as { body: object }).body;
    expect(Object.keys(sent).sort()).toEqual(
      ["explanation", "origin", "reason_category", "subject_kind", "subject_ref"],
    );
  });

  it("returns the server's reference from the 201 receipt", async () => {
    request.mockResolvedValueOnce({
      reference: "PWR-7Q2K",
      received_at: "2026-09-14T10:00:00Z",
    });

    await expect(submitContentReport(INPUT)).resolves.toEqual({
      reference: "PWR-7Q2K",
    });
  });

  it("a 2xx with no top-level reference still resolves — the row is committed, a throw would invite a duplicate", async () => {
    request.mockResolvedValueOnce({ data: { reference: "PWR-7Q2K" } });

    await expect(submitContentReport(INPUT)).resolves.toEqual({
      reference: null,
    });
  });
});

describe("originForSubject — the Play generative-AI vs UGC split", () => {
  const KINDS: ReportSubjectKind[] = [
    "archive_comment",
    "inbound_message",
    "ai_output",
    "hosted_form",
    "landing_page",
    "archive_post",
    "other",
  ];

  it.each(KINDS)("%s lands in the right bucket", (kind) => {
    expect(originForSubject(kind)).toBe(
      kind === "ai_output" ? "in_app_ai_output" : "in_app_ugc",
    );
  });

  it("only model output is filed as model output", () => {
    expect(KINDS.filter((k) => originForSubject(k) === "in_app_ai_output")).toEqual([
      "ai_output",
    ]);
  });
});

describe("canSubmitContentReport — mirrors the server's rune count in 20..10000", () => {
  it("20 characters is the floor, 19 is not enough", () => {
    expect(canSubmitContentReport("x".repeat(19))).toBe(false);
    expect(canSubmitContentReport("x".repeat(20))).toBe(true);
  });

  it("counts after trimming, as the server does", () => {
    expect(canSubmitContentReport(`   ${"x".repeat(19)}\n\n`)).toBe(false);
  });

  it("counts code points, not UTF-16 units: ten emoji are ten characters to Go", () => {
    // 🤬 is one rune and two UTF-16 units. `.length` called ten of them 20 and
    // enabled Send on a body the server 400s (len([]rune) = 10 < 20).
    expect(canSubmitContentReport("\u{1F92C}".repeat(10))).toBe(false);
    expect(canSubmitContentReport("\u{1F92C}".repeat(20))).toBe(true);
  });

  it("10,000 is the ceiling; one more is refused before the round trip", () => {
    expect(canSubmitContentReport("x".repeat(10000))).toBe(true);
    expect(canSubmitContentReport("x".repeat(10001))).toBe(false);
  });

  it("strips U+0085 at the edges, as Go's TrimSpace does and String#trim does not", () => {
    // Nineteen characters plus a trailing NEL: JS `.trim()` keeps the NEL and
    // counts 20; the server trims it and counts 19.
    expect(canSubmitContentReport(`${"x".repeat(19)}\u0085`)).toBe(false);
    expect(canSubmitContentReport(`\u0085${"x".repeat(20)}\u0085`)).toBe(true);
  });
});

describe("reportFailureMessage — never tells someone to retry what cannot succeed", () => {
  it("a role denial says it is about the role, and does not invite a retry", async () => {
    const error = await rejectionFor(sdkError(403, ROLE_DENIAL));

    const message = reportFailureMessage(error);
    expect(message).toMatch(/role/i);
    expect(message).not.toMatch(/Try again/);
  });

  it("a 400 is a validation sentence, never the raw server message", async () => {
    const error = await rejectionFor(sdkError(400, INVALID_REPORT));

    const message = reportFailureMessage(error);
    expect(message).toBe(
      "This report couldn't be accepted as written. The explanation needs 20 to 10,000 characters.",
    );
    expect(message).not.toMatch(/contentreports:/);
    expect(message).not.toMatch(RETRY_COPY);
  });

  it("a 422 is the same definite refusal as a 400 — retrying the same text cannot succeed", async () => {
    // It fell through errorCopy's generic branch (retryable) and so got the
    // retry sentence, which is the loop this finding was about.
    const error = await rejectionFor(
      sdkError(422, { error: { code: "invalid_report", message: "contentreports: unprocessable" } }),
    );

    const message = reportFailureMessage(error);
    expect(message).toBe(
      "This report couldn't be accepted as written. The explanation needs 20 to 10,000 characters.",
    );
    expect(message).not.toMatch(RETRY_COPY);
  });

  it("an expired session says to sign in, not to retry", async () => {
    const error = await rejectionFor(
      sdkError(401, { error: { code: "unauthorized", message: "sign in to report content" } }),
    );

    expect(reportFailureMessage(error)).toBe(
      "Your session has expired. Sign in again to continue.",
    );
  });

  it("a rate limit says to wait", async () => {
    const error = await rejectionFor(
      sdkError(429, { error: { code: "rate_limited", message: "slow down" } }),
    );

    expect(reportFailureMessage(error)).toBe(
      "Too many requests — wait a moment and try again.",
    );
  });

  it("a dropped connection or a 5xx keeps the retry sentence — the report is still in the field", async () => {
    const network = await rejectionFor(new TypeError("Network request failed"));
    expect(reportFailureMessage(network)).toMatch(RETRY_COPY);

    const server = await rejectionFor(
      sdkError(500, { error: { code: "internal", message: "internal error" } }),
    );
    expect(reportFailureMessage(server)).toMatch(RETRY_COPY);
  });
});
