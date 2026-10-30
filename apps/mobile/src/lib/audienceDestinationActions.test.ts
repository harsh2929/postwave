/**
 * The sync-now/preview/diagnostics contracts. The expectations are written
 * from the SERVER's bodies (audience_destinations/handlers.go — the 202
 * variants at :425/:451/:471/:485/:539, the preview map at :151, and the
 * diagnostics envelope at :643), never from the code under test.
 */
import { describe, expect, it } from "vitest";

import {
  diagnosticsRefusalMessage,
  newDestinationSyncKey,
  parseDestinationPreview,
  parseJobDiagnostics,
  parseSyncNowResult,
  previewLines,
  syncNowResultMessage,
  type DestinationSyncNowResult,
} from "./audienceDestinationActions";

function result(
  overrides: Partial<DestinationSyncNowResult> = {},
): DestinationSyncNowResult {
  return {
    status: "succeeded",
    replayed: false,
    providerMessage: "",
    jobError: "",
    membersSent: null,
    excludedCount: null,
    capExceeded: false,
    ...overrides,
  };
}

describe("parseSyncNowResult", () => {
  it("reads the full success body the handler writes at :539", () => {
    const parsed = parseSyncNowResult({
      status: "succeeded",
      provider: "meta",
      external_job_id: "ext-1",
      provider_message: "accepted",
      total_members: 120,
      excluded_count: 5,
      members_sent: 115,
      cap_exceeded: false,
      destination: { id: "d1" },
      job: { id: "j1", status: "succeeded", error: "", members_synced: 115 },
    });
    expect(parsed.status).toBe("succeeded");
    expect(parsed.membersSent).toBe(115);
    expect(parsed.excludedCount).toBe(5);
    expect(parsed.providerMessage).toBe("accepted");
    expect(parsed.replayed).toBe(false);
  });

  it("reads the early-failure body, whose reason lives on the job row", () => {
    const parsed = parseSyncNowResult({
      status: "failed",
      destination: { id: "d1" },
      job: { id: "j1", status: "failed", error: "source list no longer exists" },
    });
    expect(parsed.status).toBe("failed");
    expect(parsed.jobError).toBe("source list no longer exists");
  });

  it("reads the cap-rejection body", () => {
    const parsed = parseSyncNowResult({
      status: "rejected",
      source_members_at_least: 50001,
      members_sent: 0,
      cap_exceeded: true,
      destination: {},
      job: { status: "rejected" },
    });
    expect(parsed.status).toBe("rejected");
    expect(parsed.capExceeded).toBe(true);
  });

  it("carries the replay flag so a retry never reads as a second delivery", () => {
    const parsed = parseSyncNowResult({
      status: "succeeded",
      replayed: true,
      destination: {},
      job: { status: "succeeded", members_synced: 40 },
    });
    expect(parsed.replayed).toBe(true);
    // members_synced off the replayed job row, since the top-level counts are
    // absent on the replay body.
    expect(parsed.membersSent).toBe(40);
  });
});

describe("syncNowResultMessage", () => {
  it("a succeeded run states the count and the withheld number", () => {
    const message = syncNowResultMessage(
      result({ membersSent: 115, excludedCount: 5 }),
      "meta",
    );
    expect(message.kind).toBe("success");
    expect(message.message).toContain("115 members");
    expect(message.message).toContain("5 withheld by the consent firewall");
  });

  it("a cap rejection is an error that says nothing was sent", () => {
    const message = syncNowResultMessage(
      result({ status: "rejected", capExceeded: true }),
      "meta",
    );
    expect(message.kind).toBe("error");
    expect(message.message).toMatch(/nothing was sent/u);
  });

  it("needs_reconciliation must not read as delivered OR as failed-clean", () => {
    const message = syncNowResultMessage(
      result({ status: "needs_reconciliation" }),
      "meta",
    );
    expect(message.kind).toBe("error");
    expect(message.message).toMatch(/may or may not/u);
  });

  it("a failed run leads with the job's own error text", () => {
    const message = syncNowResultMessage(
      result({ status: "failed", jobError: "429 from provider" }),
      "meta",
    );
    expect(message.kind).toBe("error");
    expect(message.message).toContain("429 from provider");
  });

  it("a replayed success says no second delivery was made", () => {
    const message = syncNowResultMessage(
      result({ replayed: true, membersSent: 10 }),
      "meta",
    );
    expect(message.kind).toBe("success");
    expect(message.message).toMatch(/no second delivery/u);
  });
});

describe("parseDestinationPreview / previewLines", () => {
  it("keeps a missing count as null — never coerces to 0", () => {
    const preview = parseDestinationPreview({ provider: "meta" });
    expect(preview.totalMembers).toBeNull();
    expect(preview.excludedCount).toBeNull();
    expect(previewLines(preview)[0]).toBe("not reported in the source audience");
  });

  it("renders the three counts and the truncation warning", () => {
    const preview = parseDestinationPreview({
      provider: "meta",
      total_members: 120,
      excluded_count: 5,
      deliverable: 115,
      truncated: true,
      firewall_active: true,
    });
    const lines = previewLines(preview);
    expect(lines).toContain("120 in the source audience");
    expect(lines).toContain("5 withheld by the consent firewall");
    expect(lines).toContain("115 would be pushed");
    expect(lines.some((line) => /over the size cap/u.test(line))).toBe(true);
  });

  it("says so when the firewall is not active on this server", () => {
    const preview = parseDestinationPreview({
      total_members: 10,
      excluded_count: 0,
      deliverable: 10,
      firewall_active: false,
    });
    expect(
      previewLines(preview).some((line) => /firewall is not active/u.test(line)),
    ).toBe(true);
  });
});

describe("parseJobDiagnostics", () => {
  it("maps the {destination, job, diagnostics} envelope", () => {
    const parsed = parseJobDiagnostics({
      destination: { id: "d1" },
      job: { status: "failed", error: "429" },
      diagnostics: {
        provider: "meta",
        provider_status: "REJECTED",
        provider_message: "audience too small",
        external_job_id: "ext-1",
        external_audience_id: "aud-9",
      },
    });
    expect(parsed.providerStatus).toBe("REJECTED");
    expect(parsed.providerMessage).toBe("audience too small");
    expect(parsed.externalJobId).toBe("ext-1");
    expect(parsed.externalAudienceId).toBe("aud-9");
    expect(parsed.jobStatus).toBe("failed");
    expect(parsed.jobError).toBe("429");
  });
});

describe("diagnosticsRefusalMessage", () => {
  it.each([
    ["diagnostics_unavailable", /No provider request id/u],
    ["diagnostics_not_supported", /does not support job diagnostics/u],
    ["adapter_unavailable", /adapter is not configured/u],
    ["credential_resolution_failed", /credentials could not be resolved/u],
    ["provider_diagnostics_failed", /provider refused/u],
  ])("translates %s into its reason", (code, pattern) => {
    const message = diagnosticsRefusalMessage({ code, status: 409 });
    expect(message).toMatch(pattern);
  });

  it("reads a 403 as a permission rule", () => {
    expect(diagnosticsRefusalMessage({ status: 403 })).toMatch(/role/u);
  });

  it("returns null for an unclassified failure, deferring to errorPresentation", () => {
    expect(diagnosticsRefusalMessage({ status: 500 })).toBeNull();
    expect(diagnosticsRefusalMessage(new Error("network"))).toBeNull();
  });
});

describe("newDestinationSyncKey", () => {
  it("mints a distinct destination-scoped key per press", () => {
    const a = newDestinationSyncKey("d1");
    const b = newDestinationSyncKey("d1");
    expect(a).toContain("audience-destination-d1");
    expect(a).not.toBe(b);
  });
});
