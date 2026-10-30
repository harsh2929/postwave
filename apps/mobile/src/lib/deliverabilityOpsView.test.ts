import { describe, expect, it } from "vitest";

import {
  authStatus,
  authStatusTone,
  authWorstStatus,
  botOpenShareCaption,
  eqPillarRows,
  placementRows,
  placementTone,
  providerCredentialRefError,
  providerSecretSummary,
  providerTokenError,
  retryEventActionPolicy,
  retryEventIsHeld,
  retryQueueCaption,
  reputationSparkBars,
  splitDiagnosisSections,
  verificationCreditsCaption,
  warmupDraftError,
  webhookErrorsCaption,
} from "./deliverabilityOpsView";

describe("webhookErrorsCaption", () => {
  it("treats an answered zero as a REAL all-clear sentence", () => {
    expect(
      webhookErrorsCaption({
        items: [],
        failedVerifications: [],
        window: "7d",
      }),
    ).toMatch(/delivered and DNS verifications passed/);
  });

  it("names both failure kinds when both exist", () => {
    const caption = webhookErrorsCaption({
      items: [{ id: "1" }, { id: "2" }] as never,
      failedVerifications: [{ domain: "a.com" }] as never,
      window: "7d",
    });
    expect(caption).toContain("2 failed webhook deliveries");
    expect(caption).toContain("1 unverified identity");
  });
});

describe("intelligent retry", () => {
  it("only the exact backend 'pending' state is cooling-window held", () => {
    expect(retryEventIsHeld({ status: "pending" })).toBe(true);
    expect(retryEventIsHeld({ status: "held" })).toBe(false);
    expect(retryEventIsHeld({ status: " PENDING " })).toBe(false);
    expect(retryEventIsHeld({ status: "PENDING" })).toBe(false);
    expect(retryEventIsHeld({ status: "ready" })).toBe(false);
    expect(retryEventIsHeld({ status: "dismissed" })).toBe(false);
  });

  it("mirrors the server transition matrix without redundant or alias actions", () => {
    expect(retryEventActionPolicy({ status: "pending" })).toEqual({
      markReady: true,
      dismiss: true,
    });
    expect(retryEventActionPolicy({ status: "failed" })).toEqual({
      markReady: true,
      dismiss: true,
    });
    expect(retryEventActionPolicy({ status: "ready" })).toEqual({
      markReady: false,
      dismiss: true,
    });
    for (const status of [
      "retrying",
      "retried",
      "dismissed",
      "held",
    ] as const) {
      expect(retryEventActionPolicy({ status })).toEqual({
        markReady: false,
        dismiss: false,
      });
    }
  });

  it("counts only pending rows in the held-send caption", () => {
    const caption = retryQueueCaption([
      { status: "pending" },
      { status: "ready" },
      { status: "pending" },
    ] as never);
    expect(caption).toContain("2 sends cooling");
  });
});

describe("auth checks", () => {
  it("normalizes verdict spellings and maps unknown honestly", () => {
    expect(authStatus("PASS")).toBe("ok");
    expect(authStatus("warning")).toBe("warn");
    expect(authStatus("error")).toBe("fail");
    expect(authStatus("")).toBe("unknown");
    expect(authStatusTone("unknown")).toBe("neutral");
  });

  it("rolls a row up to its WORST cell, unknown outranking ok", () => {
    const row = {
      domain: "a.com",
      checks: {
        spf: { status: "ok", detail: "" },
        dkim: { status: "fail", detail: "" },
        dmarc: { status: "ok", detail: "" },
        bimi: { status: "ok", detail: "" },
        ptr: { status: "ok", detail: "" },
      },
    };
    expect(authWorstStatus(row as never)).toBe("fail");
    row.checks.dkim.status = "";
    expect(authWorstStatus(row as never)).toBe("unknown");
  });
});

describe("placement", () => {
  it("orders inbox-like first, spam-like last, drops zero shares", () => {
    const rows = placementRows({
      spam: 0.2,
      promotions: 0.1,
      primary: 0.6,
      missing: 0.1,
      updates: 0,
    });
    expect(rows.map((row) => row.code)).toEqual([
      "primary",
      "promotions",
      "spam",
      "missing",
    ]);
    expect(placementTone("primary")).toBe("success");
    expect(placementTone("spam")).toBe("danger");
  });
});

describe("eqPillarRows", () => {
  it("renders a skipped pillar as null, never a fake zero", () => {
    const rows = eqPillarRows({
      score: 70,
      grade: "B",
      content: { score: 80, weight: 0.4, reasons: [] },
      auth: { score: 0, weight: 0.3, reasons: [] },
      reputation: {
        score: 55,
        weight: 0.3,
        reasons: [
          { code: "", message: "cold domain", severity: "warn", bucket: "" },
        ],
      },
      reasons: [],
      skippedSubScores: ["auth"],
    });
    expect(rows.find((row) => row.key === "auth")?.score).toBeNull();
    expect(rows.find((row) => row.key === "content")?.score).toBe(80);
    expect(rows.find((row) => row.key === "reputation")?.reasons).toEqual([
      "cold domain",
    ]);
  });
});

describe("botOpenShareCaption", () => {
  it("refuses to report a 0% machine share of zero opens", () => {
    expect(botOpenShareCaption({ totalOpens: 0, botOpens: 0 })).toMatch(
      /No opens recorded/,
    );
  });

  it("reports the machine share of a real total", () => {
    expect(botOpenShareCaption({ totalOpens: 200, botOpens: 50 })).toContain(
      "25% of opens were machines",
    );
  });
});

describe("provider secrets", () => {
  it("makes presence-only claims from the redacted config", () => {
    expect(providerSecretSummary({ webhook_token_hash: "xx" })).toBe(
      "webhook token set",
    );
    expect(
      providerSecretSummary({
        webhook_token: "redacted",
        credential_ref: "kv/x",
      }),
    ).toBe("webhook token set · vault reference set");
    expect(providerSecretSummary({})).toBe("no secrets stored");
  });

  it("mirrors the server's token rule", () => {
    expect(providerTokenError("")).toBeNull();
    expect(providerTokenError("short")).toMatch(/at least 32/);
    expect(providerTokenError("a".repeat(32))).toBeNull();
    expect(providerTokenError("a".repeat(513))).toMatch(/at most 512/);
    expect(providerTokenError(`${"a".repeat(20)} ${"b".repeat(20)}`)).toMatch(
      /whitespace/,
    );
  });

  it("refuses credential material where a NAME belongs", () => {
    expect(
      providerCredentialRefError("vault/deliverability/sendgrid"),
    ).toBeNull();
    expect(providerCredentialRefError("two words")).toMatch(/no spaces/);
    expect(providerCredentialRefError("x".repeat(300))).toMatch(
      /credential material/,
    );
  });
});

describe("warmupDraftError", () => {
  it("accepts a complete draft and rejects each broken field", () => {
    const good = {
      domain: "mail.example.com",
      targetDaily: "5000",
      days: "30",
    };
    expect(warmupDraftError(good)).toBeNull();
    expect(warmupDraftError({ ...good, domain: "" })).toMatch(
      /Enter the domain/,
    );
    expect(warmupDraftError({ ...good, domain: "not a domain" })).toMatch(
      /doesn't look like a domain/,
    );
    expect(warmupDraftError({ ...good, targetDaily: "0" })).toMatch(
      /at least 1/,
    );
    expect(warmupDraftError({ ...good, days: "400" })).toMatch(/1–365/);
    expect(warmupDraftError({ ...good, days: "" })).toBeNull();
  });
});

describe("splitDiagnosisSections", () => {
  it("splits markdown headings into titled blocks with an untitled lead", () => {
    const sections = splitDiagnosisSections(
      "Lead text.\n## Cause\nBounces.\n### Fix\nClean the list.",
    );
    expect(sections).toEqual([
      { heading: "", body: "Lead text." },
      { heading: "Cause", body: "Bounces." },
      { heading: "Fix", body: "Clean the list." },
    ]);
  });
});

describe("verificationCreditsCaption", () => {
  it("says free-tier when no provider is configured", () => {
    expect(
      verificationCreditsCaption({
        provider: "",
        balance: null,
        totals: { creditsSpent: 0, creditsSaved: 0 },
      }),
    ).toMatch(/free local tier/);
  });

  it("never renders a null balance as zero", () => {
    const caption = verificationCreditsCaption({
      provider: "kickbox",
      balance: null,
      totals: { creditsSpent: 120, creditsSaved: 900 },
    });
    expect(caption).toContain("balance not reported");
    expect(caption).not.toMatch(/\b0 credits left/);
  });

  it("reports a real balance with spend and savings", () => {
    expect(
      verificationCreditsCaption({
        provider: "zerobounce",
        balance: 4200,
        totals: { creditsSpent: 100, creditsSaved: 50 },
      }),
    ).toContain("4,200 credits left");
  });
});

describe("reputationSparkBars", () => {
  it("keeps a visible sliver for a zero-score day and tones by band", () => {
    const bars = reputationSparkBars([
      { score: 0 },
      { score: 65 },
      { score: 92 },
    ]);
    expect(bars[0]?.height).toBeGreaterThan(0);
    expect(bars[0]?.tone).toBe("danger");
    expect(bars[1]?.tone).toBe("warning");
    expect(bars[2]?.tone).toBe("success");
  });
});
