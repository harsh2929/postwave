import { afterEach, describe, expect, it, vi } from "vitest";

import {
  relativeSubscriberTime,
  subscriberInitials,
} from "../../components/subscribers/SubscriberDetailPresentation";
import {
  regimeForJurisdiction,
  regulationsForJurisdiction,
} from "../../components/subscribers/useSubscriberDetailMutations";

describe("subscriber detail presentation helpers", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("formats deterministic relative-time buckets and preserves invalid input", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-16T12:00:00Z"));

    expect(relativeSubscriberTime(null)).toBe("—");
    expect(relativeSubscriberTime("not-a-date")).toBe("not-a-date");
    expect(relativeSubscriberTime("2026-07-16T11:59:30Z")).toBe("30s ago");
    expect(relativeSubscriberTime("2026-07-16T10:30:00Z")).toBe("2h ago");
    expect(relativeSubscriberTime("2026-06-01T12:00:00Z")).toBe("2mo ago");
  });

  it("derives stable initials from common email-local-part shapes", () => {
    expect(subscriberInitials("sam@example.test")).toBe("SA");
    expect(subscriberInitials("sam.jones@example.test")).toBe("SJ");
    expect(subscriberInitials("sam+jones@example.test")).toBe("SJ");
    expect(subscriberInitials("@example.test")).toBe("@");
  });

  it("maps jurisdiction inputs to the existing consent regimes and copy", () => {
    expect(regimeForJurisdiction(" de ")).toBe("gdpr");
    expect(regimeForJurisdiction("GB")).toBe("gdpr");
    expect(regimeForJurisdiction("ca")).toBe("casl");
    expect(regimeForJurisdiction("CA", "QC")).toBe("law25");
    expect(regimeForJurisdiction("CA", "Québec")).toBe("law25");
    expect(regimeForJurisdiction("US")).toBe("unknown");
    expect(regimeForJurisdiction(null)).toBe("unknown");
    expect(regulationsForJurisdiction("FR")).toBe("GDPR");
    expect(regulationsForJurisdiction("CA")).toBe("CASL");
    expect(regulationsForJurisdiction("CA", "Quebec")).toBe("Quebec Law 25");
    expect(regulationsForJurisdiction("US")).toBe("stricter consent rules");
  });
});
