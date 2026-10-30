import { describe, expect, it } from "vitest";
import {
  computeSignatureHeader,
  computeSignatureHex,
  verifySignature,
} from "../src/webhook.js";

describe("canonical webhook HMAC verification", () => {
  const secret = "owhsec_test_super_secret";
  const body = JSON.stringify({
    event: {
      id: "11111111-1111-4111-8111-111111111111",
      type: "campaign.sent",
      occurred_at: "2026-07-23T00:00:00Z",
      data: { campaign_id: "cmp_1" },
    },
  });
  const timestamp = 1_784_764_800;
  const now = timestamp * 1000;

  it("round-trips timestamp-prefixed signed bytes", async () => {
    const header = await computeSignatureHeader(body, secret, timestamp);
    expect(await verifySignature(body, header, secret, { now })).toBe(true);
  });

  it("accepts any matching v1 during dual-key rotation", async () => {
    const good = await computeSignatureHex(body, secret, timestamp);
    const header = `t=${timestamp},v1=${"0".repeat(64)},v1=${good}`;
    expect(await verifySignature(body, header, secret, { now })).toBe(true);
  });

  it("rejects tampering, a wrong secret, stale timestamps, and legacy body-only headers", async () => {
    const header = await computeSignatureHeader(body, secret, timestamp);
    expect(await verifySignature(`${body} `, header, secret, { now })).toBe(false);
    expect(await verifySignature(body, header, "wrong", { now })).toBe(false);
    expect(
      await verifySignature(body, header, secret, { now: now + 301_000 }),
    ).toBe(false);
    expect(
      await verifySignature(body, `sha256=${await computeSignatureHex(body, secret, timestamp)}`, secret, {
        now,
      }),
    ).toBe(false);
  });

  it("rejects malformed timestamps and digests", async () => {
    expect(await verifySignature(body, null, secret, { now })).toBe(false);
    expect(await verifySignature(body, `t=nope,v1=${"0".repeat(64)}`, secret, { now })).toBe(false);
    expect(await verifySignature(body, `t=${timestamp},v1=abc`, secret, { now })).toBe(false);
    expect(
      await verifySignature(
        body,
        `t=${timestamp},t=${timestamp},v1=${"0".repeat(64)}`,
        secret,
        { now },
      ),
    ).toBe(false);
    expect(
      await verifySignature(
        body,
        await computeSignatureHeader(body, secret, timestamp),
        secret,
        { now: Number.NaN },
      ),
    ).toBe(false);
  });
});
