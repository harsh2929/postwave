import { describe, expect, it } from "vitest";

import {
  BOT_OPEN_SPLIT_EMPTY,
  botOpenSignatureLines,
  botOpenSignatureOverflow,
  botOpenSplitDiscrepancy,
  botOpenSplitHeadline,
  botOpenSplitWindow,
} from "./botOpenSplit";

const stats = (over: Partial<Parameters<typeof botOpenSplitHeadline>[0]> = {}) => ({
  totalOpens: 5000,
  botOpens: 4,
  humanOpens: 4996,
  since: "2026-08-01T00:00:00Z",
  bySignature: [{ label: "Apple MPP", opens: 3 }],
  ...over,
});

describe("botOpenSplitHeadline", () => {
  it("prints the server's three counts and no percentage", () => {
    const headline = botOpenSplitHeadline(stats());
    expect(headline).toBe(
      "5,000 opens: 4 matched a machine signature, 4,996 did not.",
    );
    expect(headline).not.toContain("%");
  });

  it("never rounds a tiny machine share away", () => {
    // The bug this module exists to prevent: Math.round(4/5000*100) is 0, and
    // "0% machines" is a different claim from "4 opens matched".
    expect(botOpenSplitHeadline(stats())).toContain("4 matched");
  });

  it("says there is no split rather than reporting zeroes", () => {
    expect(
      botOpenSplitHeadline(
        stats({ totalOpens: 0, botOpens: 0, humanOpens: 0, bySignature: [] }),
      ),
    ).toBe(BOT_OPEN_SPLIT_EMPTY);
  });
});

describe("botOpenSplitDiscrepancy", () => {
  it("stays silent when the server's parts sum to its total", () => {
    expect(botOpenSplitDiscrepancy(stats())).toBe("");
  });

  it("reports drift instead of correcting either number", () => {
    const note = botOpenSplitDiscrepancy(
      stats({ totalOpens: 5000, botOpens: 10, humanOpens: 4996 }),
    );
    expect(note).toContain("10");
    expect(note).toContain("4,996");
    expect(note).toContain("5,000");
  });
});

describe("botOpenSplitWindow", () => {
  it("echoes an unparseable window verbatim rather than showing an em-dash", () => {
    expect(botOpenSplitWindow("last-tuesday")).toBe(
      "Opens recorded since last-tuesday.",
    );
    expect(botOpenSplitWindow("")).toBe("Window not reported by the server.");
  });

  it("renders a real timestamp readably", () => {
    expect(botOpenSplitWindow("2026-08-01T00:00:00Z")).toContain(
      "Opens recorded since ",
    );
    expect(botOpenSplitWindow("2026-08-01T00:00:00Z")).toContain("2026");
  });
});

describe("botOpenSignatureLines", () => {
  it("keeps the server's label exactly as sent", () => {
    const [line] = botOpenSignatureLines(
      stats({ bySignature: [{ label: "GoogleImageProxy", opens: 1200 }] }),
    );
    expect(line?.label).toBe("GoogleImageProxy");
    expect(line?.value).toBe("1,200");
    expect(line?.spoken).toBe("GoogleImageProxy, 1,200 opens");
  });

  it("drops an unnamed detector instead of inventing a classification", () => {
    const lines = botOpenSignatureLines(
      stats({
        bySignature: [
          { label: "   ", opens: 9 },
          { label: "Apple MPP", opens: 3 },
        ],
      }),
    );
    expect(lines.map((line) => line.label)).toEqual(["Apple MPP"]);
  });

  it("caps the list and says how many were left off", () => {
    const many = Array.from({ length: 8 }, (_, i) => ({
      label: `sig-${i}`,
      opens: i,
    }));
    const lines = botOpenSignatureLines(stats({ bySignature: many }));
    expect(lines).toHaveLength(5);
    expect(botOpenSignatureOverflow(stats({ bySignature: many }), 5)).toContain(
      "3 more signatures",
    );
    expect(botOpenSignatureOverflow(stats(), 1)).toBe("");
  });

  it("survives a non-array breakdown", () => {
    expect(
      botOpenSignatureLines(stats({ bySignature: undefined as never })),
    ).toEqual([]);
  });
});
