// SPDX-License-Identifier: AGPL-3.0-only
//
// ECO-22: reaching a chain from an id you already hold.
//
// The row-first entry point assumes you found the row. The case the endpoint
// was written for is the reverse — an id out of a log line — and until this
// control existed neither desktop nor web could serve it.

import { describe, expect, it } from "vitest";

import { isTraceableRequestId } from "../../components/audit/TraceRequestLookup";

describe("isTraceableRequestId", () => {
  it("refuses the empty string and whitespace", () => {
    expect(isTraceableRequestId("")).toBe(false);
    expect(isTraceableRequestId("   ")).toBe(false);
  });

  it("refuses the '-' sentinel audit.Emit writes for 'no correlation'", () => {
    // The endpoint 422s this. Sending it would open the modal onto an empty
    // chain, which reads as "this request touched nothing" — a wrong answer
    // rather than a refusal.
    expect(isTraceableRequestId("-")).toBe(false);
    expect(isTraceableRequestId(" - ")).toBe(false);
  });

  it("accepts a real chi request id, slash and all", () => {
    expect(isTraceableRequestId("postwave-api-7c9f/lF3kQ2xTvB-000042")).toBe(
      true,
    );
  });

  it("accepts an id that merely contains a dash", () => {
    // Guarding on `includes("-")` would reject every real id, since chi's
    // format always ends in "-000042".
    expect(isTraceableRequestId("web-01/AbC-7")).toBe(true);
  });
});
