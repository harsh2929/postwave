import { describe, expect, it } from "vitest";

import { subscriberHistoryDisplay } from "../../components/subscribers/subscriber-history-display";

describe("subscriber history privacy display", () => {
  it("renders the one reviewed rating payload without exposing other keys", () => {
    const display = subscriberHistoryDisplay({
      kind: "rating.changed",
      payload: {
        rating: 4,
        email: "private@example.test",
        token: "secret-token",
        nested: { authorization: "Bearer secret" },
      },
    });

    expect(display).toEqual({
      title: "Contact rating changed",
      details: [{ label: "Rating", value: "4 of 5" }],
      detailsHidden: false,
    });
    expect(JSON.stringify(display)).not.toContain("private@example.test");
    expect(JSON.stringify(display)).not.toContain("secret");
  });

  it("fails closed for unknown kinds, malformed values, controls, and oversized data", () => {
    const secret = `token\u202E${"x".repeat(100_000)}\nprivate@example.test`;
    const unknown = subscriberHistoryDisplay({
      kind: `provider.sync\u202E${secret}`,
      payload: {
        api_key: secret,
        password: secret,
        nested: { refresh_token: secret },
      },
    });
    const malformed = subscriberHistoryDisplay({
      kind: "rating.changed",
      payload: { rating: "5", token: secret },
    });

    expect(unknown).toEqual({
      title: "Subscriber activity recorded",
      details: [],
      detailsHidden: true,
    });
    expect(malformed).toEqual({
      title: "Contact rating changed",
      details: [],
      detailsHidden: true,
    });
    expect(JSON.stringify([unknown, malformed])).not.toContain("token");
    expect(JSON.stringify([unknown, malformed])).not.toContain(
      "private@example.test",
    );
  });

  it("represents rating zero as an explicit clear operation", () => {
    expect(
      subscriberHistoryDisplay({
        kind: "rating.changed",
        payload: { rating: 0 },
      }).details,
    ).toEqual([{ label: "Rating", value: "Cleared" }]);
  });
});
