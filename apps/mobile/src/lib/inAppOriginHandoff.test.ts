import { beforeEach, describe, expect, it } from "vitest";

import {
  clearInAppOrigin,
  depositInAppOrigin,
  redeemInAppOrigin,
} from "./inAppOriginHandoff";

describe("in-app origin hand-off", () => {
  beforeEach(() => clearInAppOrigin());

  it("vouches for the origin the app itself just deposited", () => {
    depositInAppOrigin("https://api-staging.acme.com");
    expect(redeemInAppOrigin("https://api-staging.acme.com")).toBe(true);
  });

  it("vouches for nothing when the app deposited nothing — the deep-link case", () => {
    expect(redeemInAppOrigin("https://evil.tld")).toBe(false);
  });

  it("refuses an origin that is not the one deposited", () => {
    depositInAppOrigin("https://api.acme.com");
    expect(redeemInAppOrigin("https://evil.tld")).toBe(false);
  });

  it("is one shot: a redeemed deposit cannot vouch for a later link", () => {
    depositInAppOrigin("https://api.acme.com");
    expect(redeemInAppOrigin("https://api.acme.com")).toBe(true);
    expect(redeemInAppOrigin("https://api.acme.com")).toBe(false);
  });

  it("a failed redeem also consumes the deposit, so a miss cannot be retried", () => {
    depositInAppOrigin("https://api.acme.com");
    expect(redeemInAppOrigin("https://evil.tld")).toBe(false);
    expect(redeemInAppOrigin("https://api.acme.com")).toBe(false);
  });

  it("treats an empty deposit as no deposit", () => {
    depositInAppOrigin("   ");
    expect(redeemInAppOrigin("   ")).toBe(false);
  });
});
