import { describe, expect, it } from "vitest";

import {
  anomalyTone,
  metricLabel,
  parseAnomalies,
  severityMultiple,
  type AnomalyEvent,
} from "./anomalies";

const row = {
  id: "an_1",
  tenantId: "t_1",
  metric: "bounces",
  dayBucket: "2026-07-20T00:00:00Z",
  value: 412,
  mean: 38.2,
  zScore: 6.2,
  rangeUsed: "30d",
  detectedAt: "2026-07-20T09:14:00Z",
};

describe("parseAnomalies", () => {
  it("reads the { items } envelope and a bare array alike", () => {
    expect(parseAnomalies({ items: [row] })).toHaveLength(1);
    expect(parseAnomalies([row])).toHaveLength(1);
  });

  it("survives drift without throwing", () => {
    expect(parseAnomalies(null)).toEqual([]);
    expect(parseAnomalies({})).toEqual([]);
    expect(parseAnomalies({ items: "nope" })).toEqual([]);
    expect(parseAnomalies([null, 4])).toEqual([]);
  });

  it("drops rows that cannot be phrased honestly", () => {
    // "— spiked" is worse than one row shorter.
    expect(parseAnomalies({ items: [{ ...row, metric: "" }] })).toEqual([]);
    expect(parseAnomalies({ items: [{ ...row, value: null }] })).toEqual([]);
  });

  it("keeps a missing baseline as null rather than zero", () => {
    const [parsed] = parseAnomalies({ items: [{ ...row, mean: undefined }] });
    expect(parsed?.mean).toBeNull();
    expect(parsed?.value).toBe(412);
  });

  it("synthesises a stable key when the row has no id", () => {
    const [parsed] = parseAnomalies({ items: [{ ...row, id: undefined }] });
    expect(parsed?.id).toBe("bounces:2026-07-20T00:00:00Z");
  });
});

describe("metricLabel", () => {
  it("names known metrics and title-cases unknown ones", () => {
    expect(metricLabel("bounces")).toBe("Bounces");
    expect(metricLabel("unique_soft_bounces")).toBe("Unique soft bounces");
    expect(metricLabel("")).toBe("Metric");
  });
});

describe("severityMultiple", () => {
  const base: AnomalyEvent = {
    id: "a",
    metric: "bounces",
    label: "Bounces",
    value: 400,
    mean: 40,
    zScore: 5,
    detectedAt: null,
    dayBucket: null,
  };

  it("expresses the spike as a multiple of the baseline", () => {
    expect(severityMultiple(base)).toBe(10);
  });

  it("refuses a zero or absent baseline instead of printing Infinity", () => {
    expect(severityMultiple({ ...base, mean: 0 })).toBeNull();
    expect(severityMultiple({ ...base, mean: null })).toBeNull();
  });

  it("bands severity on the z-score", () => {
    expect(anomalyTone(base)).toBe("danger");
    expect(anomalyTone({ ...base, zScore: 3.1 })).toBe("warning");
    expect(anomalyTone({ ...base, zScore: null })).toBe("warning");
  });
});
