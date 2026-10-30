import { describe, it, expect } from "vitest";

import { interpretClipboardOrQr, parseDeviceApproveLink } from "./qr";

describe("parseDeviceApproveLink", () => {
  it("accepts only the canonical CLI approval link", () => {
    expect(
      parseDeviceApproveLink(
        "https://app.moosewave.com/cli/auth?user_code=ABCD-EFGH",
      ),
    ).toBe("ABCD-EFGH");
    expect(
      parseDeviceApproveLink(
        "https://app.moosewave.com/cli/auth?user_code=abcd-efgh",
      ),
    ).toBeNull();
  });

  it("rejects wrong host / scheme / path (anti-spoofing)", () => {
    expect(
      parseDeviceApproveLink(
        "https://evil.example/cli/auth?user_code=ABCD-EFGH",
      ),
    ).toBeNull();
    expect(
      parseDeviceApproveLink(
        "http://app.moosewave.com/cli/auth?user_code=ABCD-EFGH",
      ),
    ).toBeNull();
    expect(
      parseDeviceApproveLink(
        "https://app.moosewave.com/app/campaigns/c1?user_code=ABCD-EFGH",
      ),
    ).toBeNull();
  });

  it("rejects a malformed or missing code", () => {
    expect(
      parseDeviceApproveLink("https://app.moosewave.com/cli/auth"),
    ).toBeNull();
    expect(
      parseDeviceApproveLink(
        "https://app.moosewave.com/cli/auth?user_code=NOTVALID",
      ),
    ).toBeNull();
    expect(parseDeviceApproveLink("not a url")).toBeNull();
  });

  it("interpretClipboardOrQr routes a device link to the deviceApprove intent", () => {
    expect(
      interpretClipboardOrQr(
        "https://app.moosewave.com/cli/auth?user_code=WXYZ-1234",
      ),
    ).toEqual({ kind: "deviceApprove", userCode: "WXYZ-1234" });
    // A normal entity/url link is unaffected.
    expect(
      interpretClipboardOrQr("https://app.moosewave.com/app/campaigns/c1").kind,
    ).toBe("entity");
  });
});
