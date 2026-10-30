// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { ApiError } from "@/lib/api";
import { expiredPreferenceRoute } from "@/lib/preference-form-errors";

describe("expiredPreferenceRoute", () => {
  it("routes a token that expires after page load to the localized expired flow", () => {
    expect(
      expiredPreferenceRoute(
        new ApiError("expired", 410, { error: "token_expired" }),
        "/fr/preferences/pref-token",
      ),
    ).toBe("/fr/preferences/expired");
  });

  it("leaves unrelated save failures on the form", () => {
    expect(
      expiredPreferenceRoute(
        new ApiError("unavailable", 503, { error: "unavailable" }),
        "/en/preferences/pref-token",
      ),
    ).toBeNull();
  });
});
